/**
 * three.js による 3D 点群の表示。位置の計算は geometry.ts、色は view.ts、状態は main.ts が持つ。
 *
 * - 座標: geometry.ts のセンサー座標(x = センサーから見て右、y = 上、z = 前方。mm)を、
 *   geometry.ts の sensorToWorld で three.js の世界座標(右手系、m)の (x, y, −z) / 1000 に写す。前方は −z になる。
 *   基底の取り替えなので鏡像にはならない(センサー座標のまま入れると、センサーの後ろから見た左右が鏡像になる)
 * - WebGL のコンテキストが失われたとき(GPU のリセット等)は three.js が復帰を待ち、復帰したら描き直す
 * - 性能: ゾーンは最大 64 個なので、点・パッチの BufferGeometry は最大数ぶんを最初に確保し、
 *   フレームごとに属性の値だけを書き換える(オブジェクトを作り直さない)。
 *   描画はデータ・表示の設定・カメラが変わったときだけ(renderIfNeeded)
 * - WebGL が使えない環境では、コンストラクタが例外を投げる
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { RangingFrame } from "./frame.ts";
import {
  buildPointCloud,
  frustumCorners,
  sensorToWorld,
  zonePatch,
  type DistanceModel,
  type Vec3,
} from "./geometry.ts";
import {
  zoneValueColor,
  type ColorBy,
  type ColorRanges,
  type Orientation,
  type Rgb,
} from "./view.ts";

/** 3D ビューの大きさ [CSS px] */
export const VIEW_WIDTH = 640;
export const VIEW_HEIGHT = 420;

/** 表示の形 */
export type Display3D = "points" | "patches";

/** 3D ビューの設定(main.ts が画面から作る) */
export interface Scene3DOptions {
  readonly model: DistanceModel;
  readonly display: Display3D;
  readonly colorBy: ColorBy;
  /** 無効なゾーンを半透明の灰色で描くか */
  readonly showInvalid: boolean;
  /** 2D 画像が正面から見た見た目と一致する反転(2D と同じ設定を使う) */
  readonly orientation: Orientation;
  readonly ranges: ColorRanges;
}

const MAX_ZONES = 64;
/** 1 つのパッチの頂点数(三角形 2 つ) */
const PATCH_VERTICES = 6;
/** 視野の四角錐を描く距離 [mm](VL53L8CX の最大測距距離 4 m) */
const FRUSTUM_MM = 4000;
/** 床のグリッドの高さ [m](センサーの 0.5 m 下と仮定した目安) */
const FLOOR_Y = -0.5;
/** 距離の輪の間隔と最大 [m] */
const RING_STEP_M = 0.5;
const RING_MAX_M = 4;
const RING_SEGMENTS = 48;
const AXIS_M = 0.3;

const SURFACE = 0x1a1a19;
const INVALID_GRAY = 0x8a8a85;
/** 値の色がないとき(範囲がまだない等)の色 */
const FALLBACK_RGB: Rgb = { r: 200, g: 200, b: 200 };

const INITIAL_CAMERA = new THREE.Vector3(0.9, 0.8, 1.3);
const INITIAL_TARGET = new THREE.Vector3(0, 0, -1.2);

/** センサー座標 [mm] を three.js の世界座標 [m] に写して、配列に書く */
function writeWorld(array: Float32Array, index: number, v: Vec3): void {
  const w = sensorToWorld(v);
  array[index * 3] = w.x;
  array[index * 3 + 1] = w.y;
  array[index * 3 + 2] = w.z;
}

/** 0〜255 の sRGB の色を、three.js の頂点色(線形)にして配列に書く */
function writeColor(array: Float32Array, index: number, rgb: Rgb, tmp: THREE.Color): void {
  tmp.setRGB(rgb.r / 255, rgb.g / 255, rgb.b / 255, THREE.SRGBColorSpace);
  array[index * 3] = tmp.r;
  array[index * 3 + 1] = tmp.g;
  array[index * 3 + 2] = tmp.b;
}

/** 最大数ぶんの頂点を持つ BufferGeometry(位置と、必要なら色) */
function makeGeometry(vertices: number, withColor: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  if (withColor) {
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  }
  g.setDrawRange(0, 0);
  return g;
}

function attributeArray(g: THREE.BufferGeometry, name: "position" | "color"): Float32Array {
  const attr = g.getAttribute(name);
  // makeGeometry で Float32Array の BufferAttribute として作っている
  if (!(attr instanceof THREE.BufferAttribute) || !(attr.array instanceof Float32Array)) {
    throw new Error(`attribute ${name} is missing`);
  }
  return attr.array;
}

function markUpdated(g: THREE.BufferGeometry, count: number): void {
  g.setDrawRange(0, count);
  for (const name of ["position", "color"]) {
    const attr = g.getAttribute(name);
    if (attr instanceof THREE.BufferAttribute) {
      attr.needsUpdate = true;
    }
  }
}

/** 3D ビュー */
export class Scene3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly validPoints: THREE.Points;
  private readonly invalidPoints: THREE.Points;
  private readonly validPatches: THREE.Mesh;
  private readonly invalidPatches: THREE.Mesh;
  private readonly frustum: THREE.LineSegments;
  private readonly tmpColor = new THREE.Color();
  private dirty = true;
  private frustumModel: DistanceModel | null = null;

  /**
   * @param canvas - 描画先の canvas
   * @param onContextChange - WebGL のコンテキストが失われた(lost = true)・復帰した(false)ときに呼ばれる
   * @throws Error WebGL のコンテキストを作れないとき(three.js が投げる)
   */
  constructor(canvas: HTMLCanvasElement, onContextChange?: (lost: boolean) => void) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // lost の既定の動作(復帰させない)は three.js が preventDefault で止める。ここでは知らせるだけ
    canvas.addEventListener("webglcontextlost", () => {
      onContextChange?.(true);
    });
    canvas.addEventListener("webglcontextrestored", () => {
      // three.js がバッファ等を作り直すので、次の requestAnimationFrame で描き直す
      this.dirty = true;
      onContextChange?.(false);
    });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT);
    this.renderer.setClearColor(SURFACE);

    this.camera = new THREE.PerspectiveCamera(50, VIEW_WIDTH / VIEW_HEIGHT, 0.01, 50);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener("change", () => {
      this.dirty = true;
    });
    this.resetView();

    const pointsMaterial = new THREE.PointsMaterial({ size: 0.04, vertexColors: true });
    const invalidPointsMaterial = new THREE.PointsMaterial({
      size: 0.03,
      color: INVALID_GRAY,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const patchMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    const invalidPatchMaterial = new THREE.MeshBasicMaterial({
      color: INVALID_GRAY,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
    this.validPoints = new THREE.Points(makeGeometry(MAX_ZONES, true), pointsMaterial);
    this.invalidPoints = new THREE.Points(makeGeometry(MAX_ZONES, false), invalidPointsMaterial);
    this.validPatches = new THREE.Mesh(
      makeGeometry(MAX_ZONES * PATCH_VERTICES, true),
      patchMaterial,
    );
    this.invalidPatches = new THREE.Mesh(
      makeGeometry(MAX_ZONES * PATCH_VERTICES, false),
      invalidPatchMaterial,
    );
    // 頂点を毎フレーム書き換えるので、境界球による視錐台カリングは使わない
    for (const o of [
      this.validPoints,
      this.invalidPoints,
      this.validPatches,
      this.invalidPatches,
    ]) {
      o.frustumCulled = false;
      this.scene.add(o);
    }

    this.frustum = new THREE.LineSegments(
      makeGeometry(16, false),
      new THREE.LineBasicMaterial({ color: 0x6d6d68 }),
    );
    this.frustum.frustumCulled = false;
    this.scene.add(this.frustum);
    this.scene.add(this.makeFloorGrid(), this.makeRings(), this.makeAxes(), this.makeSensor());
  }

  /** 視点を初期位置(センサーの右後ろ上から前方を見る)に戻す */
  resetView(): void {
    this.camera.position.copy(INITIAL_CAMERA);
    this.controls.target.copy(INITIAL_TARGET);
    this.controls.update();
    this.dirty = true;
  }

  /**
   * 表示する内容を更新する(属性を書き換えるだけで、描画は renderIfNeeded)。
   *
   * @param frame - 最新の測距フレーム(null なら点を消す)
   * @param options - 表示の設定
   */
  update(frame: RangingFrame | null, options: Scene3DOptions): void {
    this.updateFrustum(options.model);
    const cloud = frame === null ? [] : buildPointCloud(frame, options.orientation, options.model);
    const side = frame?.side ?? 8;

    const vPos = attributeArray(this.validPoints.geometry, "position");
    const vCol = attributeArray(this.validPoints.geometry, "color");
    const iPos = attributeArray(this.invalidPoints.geometry, "position");
    const pvPos = attributeArray(this.validPatches.geometry, "position");
    const pvCol = attributeArray(this.validPatches.geometry, "color");
    const piPos = attributeArray(this.invalidPatches.geometry, "position");
    let nValid = 0;
    let nInvalid = 0;
    for (const p of cloud) {
      const valid = p.cls === "ok";
      if (!valid && !options.showInvalid) {
        continue;
      }
      // cloud が空でなければ frame は null でない
      const color =
        valid && frame !== null
          ? (zoneValueColor(frame, p.zone, options.colorBy, options.ranges) ?? FALLBACK_RGB)
          : null;
      if (options.display === "points") {
        if (color !== null) {
          writeWorld(vPos, nValid, p.position);
          writeColor(vCol, nValid, color, this.tmpColor);
          nValid++;
        } else {
          writeWorld(iPos, nInvalid, p.position);
          nInvalid++;
        }
        continue;
      }
      const [bl, br, tr, tl] = zonePatch(
        p.zone,
        side,
        options.orientation,
        p.distanceMm,
        options.model,
      );
      const corners = [bl, br, tr, bl, tr, tl];
      const base = (color !== null ? nValid : nInvalid) * PATCH_VERTICES;
      for (const [k, v] of corners.entries()) {
        if (color !== null) {
          writeWorld(pvPos, base + k, v);
          writeColor(pvCol, base + k, color, this.tmpColor);
        } else {
          writeWorld(piPos, base + k, v);
        }
      }
      if (color !== null) nValid++;
      else nInvalid++;
    }
    const points = options.display === "points";
    markUpdated(this.validPoints.geometry, points ? nValid : 0);
    markUpdated(this.invalidPoints.geometry, points ? nInvalid : 0);
    markUpdated(this.validPatches.geometry, points ? 0 : nValid * PATCH_VERTICES);
    markUpdated(this.invalidPatches.geometry, points ? 0 : nInvalid * PATCH_VERTICES);
    this.dirty = true;
  }

  /** データ・設定・カメラが変わっていれば描く。requestAnimationFrame の中から呼ぶ */
  renderIfNeeded(): void {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }

  /** 視野の四角錐(原点から 4 隅への辺 4 本と、距離 FRUSTUM_MM での断面の 4 辺) */
  private updateFrustum(model: DistanceModel): void {
    if (this.frustumModel === model) {
      return;
    }
    this.frustumModel = model;
    const pos = attributeArray(this.frustum.geometry, "position");
    const corners = frustumCorners(FRUSTUM_MM, model);
    const origin: Vec3 = { x: 0, y: 0, z: 0 };
    let n = 0;
    for (const [i, c] of corners.entries()) {
      const next = corners[(i + 1) % corners.length] ?? c;
      writeWorld(pos, n++, origin);
      writeWorld(pos, n++, c);
      writeWorld(pos, n++, c);
      writeWorld(pos, n++, next);
    }
    markUpdated(this.frustum.geometry, n);
  }

  /** 床のグリッド(0.5 m 間隔、センサーの 0.5 m 下と仮定) */
  private makeFloorGrid(): THREE.Object3D {
    const grid = new THREE.GridHelper(8, 16, 0x52514e, 0x2e2e2c);
    grid.position.set(0, FLOOR_Y, -3);
    return grid;
  }

  /** 距離の輪(床の高さに、センサーの真下を中心とする前方の半円を 0.5 m ごと) */
  private makeRings(): THREE.Object3D {
    const rings = Math.round(RING_MAX_M / RING_STEP_M);
    const positions = new Float32Array(rings * RING_SEGMENTS * 2 * 3);
    let n = 0;
    for (let k = 1; k <= rings; k++) {
      const r = k * RING_STEP_M;
      for (let s = 0; s < RING_SEGMENTS; s++) {
        for (const t of [s, s + 1]) {
          const a = -Math.PI / 2 + (Math.PI * t) / RING_SEGMENTS;
          positions[n++] = r * Math.sin(a);
          positions[n++] = FLOOR_Y;
          positions[n++] = -r * Math.cos(a);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x46463f }));
  }

  /** 軸: x(センサーから見て右)= 赤、y(上)= 緑、前方 = 青 */
  private makeAxes(): THREE.Object3D {
    const positions = new Float32Array([
      0,
      0,
      0,
      AXIS_M,
      0,
      0,
      0,
      0,
      0,
      0,
      AXIS_M,
      0,
      0,
      0,
      0,
      0,
      0,
      -AXIS_M,
    ]);
    const colors = new Float32Array(18);
    const axisColors: Rgb[] = [
      { r: 255, g: 90, b: 90 },
      { r: 90, g: 220, b: 90 },
      { r: 90, g: 150, b: 255 },
    ];
    for (const [i, c] of axisColors.entries()) {
      writeColor(colors, i * 2, c, this.tmpColor);
      writeColor(colors, i * 2 + 1, c, this.tmpColor);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
  }

  /** センサーの位置の目印(3 cm の箱) */
  private makeSensor(): THREE.Object3D {
    return new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.03, 0.01),
      new THREE.MeshBasicMaterial({ color: 0xcccccc }),
    );
  }
}
