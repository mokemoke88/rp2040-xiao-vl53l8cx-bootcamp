/**
 * デモ用記録の一覧(public/demos/manifest.json)の検証と、ビュー・URL パラメータの定義。DOM に依存しない。
 */

/** ビュー(全画面で 1 つずつ大きく表示できる単位)。並び順がキー `1`〜`n` に対応する */
export const VIEW_IDS = ["lidar", "3d", "images", "lectureA", "lectureB", "lectureC"] as const;

/** ビューの ID */
export type ViewId = (typeof VIEW_IDS)[number];

/** 文字列がビューの ID か */
export function isViewId(v: string): v is ViewId {
  return (VIEW_IDS as readonly string[]).includes(v);
}

/** manifest の形式の版 */
export const MANIFEST_VERSION = 1;

/** デモ用記録の 1 件 */
export interface DemoEntry {
  /** URL パラメータ(`?demo=`)で指定する名前。英小文字・数字・ハイフン */
  readonly id: string;
  /** public/demos/ の中のファイル名(`.bin`。ディレクトリは含めない) */
  readonly file: string;
  /** メニューに出す名前 */
  readonly title: string;
  /** 何を撮ったか */
  readonly description: string;
  /** 記録の長さ [秒] */
  readonly seconds: number;
  /** 選んだときに開くビュー */
  readonly view: ViewId;
}

/** デモ用記録の一覧 */
export interface DemoManifest {
  readonly version: number;
  readonly demos: readonly DemoEntry[];
}

/** 検証の結果。失敗は理由の一覧で返す */
export type ManifestResult =
  | { readonly ok: true; readonly manifest: DemoManifest }
  | { readonly ok: false; readonly errors: readonly string[] };

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** ファイル名(パスの区切りや .. を含めない。public/demos/ の外を指せないようにする) */
const FILE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.bin$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * manifest.json を JSON.parse した値を検証する。
 *
 * @param json - JSON.parse の結果(任意の値)
 * @returns 検証済みの一覧、または誤りの一覧
 */
export function parseManifest(json: unknown): ManifestResult {
  const errors: string[] = [];
  if (!isRecord(json)) {
    return { ok: false, errors: ["manifest is not an object"] };
  }
  if (json.version !== MANIFEST_VERSION) {
    errors.push(`version must be ${MANIFEST_VERSION}`);
  }
  if (!Array.isArray(json.demos)) {
    return { ok: false, errors: [...errors, "demos is not an array"] };
  }
  const demos: DemoEntry[] = [];
  const ids = new Set<string>();
  for (const [i, item] of (json.demos as unknown[]).entries()) {
    const p = `demos[${i}]`;
    if (!isRecord(item)) {
      errors.push(`${p} is not an object`);
      continue;
    }
    const { id, file, title, description, seconds, view } = item;
    const before = errors.length;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      errors.push(`${p}.id must be lower-case letters, digits and hyphens`);
    } else if (ids.has(id)) {
      errors.push(`${p}.id "${id}" is duplicated`);
    }
    if (typeof file !== "string" || !FILE_PATTERN.test(file)) {
      errors.push(`${p}.file must be a .bin file name without directories`);
    }
    if (typeof title !== "string" || title.trim() === "") {
      errors.push(`${p}.title must be a non-empty string`);
    }
    if (typeof description !== "string") {
      errors.push(`${p}.description must be a string`);
    }
    if (typeof seconds !== "number" || !(seconds > 0) || !Number.isFinite(seconds)) {
      errors.push(`${p}.seconds must be a positive number`);
    }
    if (typeof view !== "string" || !isViewId(view)) {
      errors.push(`${p}.view must be one of ${VIEW_IDS.join(", ")}`);
    }
    if (
      errors.length === before &&
      typeof id === "string" &&
      typeof file === "string" &&
      typeof title === "string" &&
      typeof description === "string" &&
      typeof seconds === "number" &&
      typeof view === "string" &&
      isViewId(view)
    ) {
      ids.add(id);
      demos.push({ id, file, title, description, seconds, view });
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, manifest: { version: MANIFEST_VERSION, demos } };
}

/**
 * manifest に書かれたファイルがすべて存在するかを確かめる。
 *
 * @param manifest - 検証済みの一覧
 * @param exists - ファイル名(public/demos/ の中)が存在するか
 * @returns 存在しないファイル名の一覧(すべてあれば空)
 */
export function missingDemoFiles(
  manifest: DemoManifest,
  exists: (file: string) => boolean,
): string[] {
  return manifest.demos.filter((d) => !exists(d.file)).map((d) => d.file);
}

/** URL パラメータの解釈の結果 */
export interface UrlOptions {
  /** `?view=`(知らない値は null) */
  readonly view: ViewId | null;
  /** `?demo=`(形が正しくない値は null。manifest にあるかは呼び出し側で確かめる) */
  readonly demo: string | null;
}

/**
 * URL の検索文字列(`?view=lidar&demo=wave` など)からビューとデモを読む。
 *
 * @param search - location.search
 */
export function parseUrlOptions(search: string): UrlOptions {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const demo = params.get("demo");
  return {
    view: view !== null && isViewId(view) ? view : null,
    demo: demo !== null && ID_PATTERN.test(demo) ? demo : null,
  };
}
