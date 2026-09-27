import { describe, expect, it } from "vitest";
import {
  MANIFEST_VERSION,
  VIEW_IDS,
  isViewId,
  missingDemoFiles,
  parseManifest,
  parseUrlOptions,
} from "../src/demos.ts";
import manifestText from "../public/demos/manifest.json?raw";

/** public/demos/ にある .bin(ファイル名だけ)。glob のキーだけを使い、中身は読み込まない */
const demoFiles = new Set(
  Object.keys(import.meta.glob("../public/demos/*.bin")).map((path) =>
    path.slice(path.lastIndexOf("/") + 1),
  ),
);

const valid = {
  version: 1,
  demos: [
    {
      id: "wave",
      file: "wave.bin",
      title: "手を振る",
      description: "",
      seconds: 20,
      view: "lectureB",
    },
    {
      id: "wall-1",
      file: "wall_1.bin",
      title: "正面の壁",
      description: "0.8 m",
      seconds: 15.5,
      view: "lectureC",
    },
  ],
};

function errorsOf(json: unknown): readonly string[] {
  const r = parseManifest(json);
  return r.ok ? [] : r.errors;
}

/** valid の 1 件目の 1 項目を変えた manifest */
function withFirst(patch: Record<string, unknown>): unknown {
  const [first, ...rest] = valid.demos;
  return { ...valid, demos: [{ ...first, ...patch }, ...rest] };
}

describe("the bundled manifest (public/demos/manifest.json)", () => {
  it("is valid and every file exists", () => {
    const r = parseManifest(JSON.parse(manifestText));
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.manifest.demos.length).toBeGreaterThan(0);
    expect(missingDemoFiles(r.manifest, (f) => demoFiles.has(f))).toEqual([]);
  });
});

describe("parseManifest", () => {
  it("accepts a valid manifest", () => {
    const r = parseManifest(valid);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.manifest.version).toBe(MANIFEST_VERSION);
    expect(r.manifest.demos.map((d) => d.id)).toEqual(["wave", "wall-1"]);
    expect(r.manifest.demos[1]?.seconds).toBe(15.5);
  });

  it("rejects a wrong top level", () => {
    expect(errorsOf(null)).toEqual(["manifest is not an object"]);
    expect(errorsOf([])).toEqual(["manifest is not an object"]);
    expect(errorsOf({ ...valid, version: 2 })).toEqual(["version must be 1"]);
    expect(errorsOf({ version: 1, demos: {} })).toEqual(["demos is not an array"]);
    expect(errorsOf({ version: 1 })).toEqual(["demos is not an array"]);
  });

  it("accepts an empty list", () => {
    expect(parseManifest({ version: 1, demos: [] }).ok).toBe(true);
  });

  it("checks each field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ id: "Wave" }, "demos[0].id"],
      [{ id: "-wave" }, "demos[0].id"],
      [{ id: "" }, "demos[0].id"],
      [{ id: 3 }, "demos[0].id"],
      [{ file: "../secret.bin" }, "demos[0].file"],
      [{ file: "sub/wave.bin" }, "demos[0].file"],
      [{ file: "sub\\wave.bin" }, "demos[0].file"],
      [{ file: "wave.txt" }, "demos[0].file"],
      [{ file: ".bin" }, "demos[0].file"],
      [{ title: " " }, "demos[0].title"],
      [{ title: undefined }, "demos[0].title"],
      [{ description: 1 }, "demos[0].description"],
      [{ seconds: 0 }, "demos[0].seconds"],
      [{ seconds: -3 }, "demos[0].seconds"],
      [{ seconds: "20" }, "demos[0].seconds"],
      [{ seconds: Number.POSITIVE_INFINITY }, "demos[0].seconds"],
      [{ view: "radar" }, "demos[0].view"],
    ];
    for (const [patch, prefix] of cases) {
      const errors = errorsOf(withFirst(patch));
      expect(errors, JSON.stringify(patch)).toHaveLength(1);
      expect(errors[0]?.startsWith(prefix), JSON.stringify(patch)).toBe(true);
    }
  });

  it("rejects duplicated ids and non-object entries", () => {
    const dup = { ...valid, demos: [valid.demos[0], { ...valid.demos[1], id: "wave" }] };
    expect(errorsOf(dup)).toEqual(['demos[1].id "wave" is duplicated']);
    expect(errorsOf({ version: 1, demos: [42] })).toEqual(["demos[0] is not an object"]);
  });
});

describe("missingDemoFiles", () => {
  it("lists files that do not exist", () => {
    const r = parseManifest(valid);
    if (!r.ok) throw new Error("invalid");
    expect(missingDemoFiles(r.manifest, (f) => f === "wave.bin")).toEqual(["wall_1.bin"]);
    expect(missingDemoFiles(r.manifest, () => true)).toEqual([]);
  });
});

describe("views and URL parameters", () => {
  it("has at most 9 views (keys 1-9)", () => {
    expect(VIEW_IDS.length).toBeLessThanOrEqual(9);
    expect(VIEW_IDS[0]).toBe("lidar");
    expect(isViewId("3d")).toBe(true);
    expect(isViewId("LIDAR")).toBe(false);
  });

  it("reads view and demo", () => {
    expect(parseUrlOptions("?view=lidar&demo=wave")).toEqual({ view: "lidar", demo: "wave" });
    expect(parseUrlOptions("")).toEqual({ view: null, demo: null });
    expect(parseUrlOptions("?view=radar&demo=../x")).toEqual({ view: null, demo: null });
    expect(parseUrlOptions("?view=lectureC")).toEqual({ view: "lectureC", demo: null });
    expect(parseUrlOptions("?demo=wall-1")).toEqual({ view: null, demo: "wall-1" });
  });
});
