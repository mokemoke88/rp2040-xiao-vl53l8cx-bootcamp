// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/** 解析のモジュール(DOM / Web API に依存させず、Node 上の Vitest でテストする) */
const pureModules = [
  "src/cobs.ts",
  "src/crc32.ts",
  "src/frame.ts",
  "src/stream.ts",
  "src/stats.ts",
  "src/receiver.ts",
  "src/replay.ts",
  "src/view.ts",
  "src/geometry.ts",
  "src/scan2d.ts",
  "src/demos.ts",
  "src/lecture/text.ts",
];

export default defineConfig(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 数値をテンプレート文字列に埋め込むのは表示で頻繁に使うので許可する
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: pureModules,
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "document", message: "解析のモジュールは DOM に依存させない" },
        { name: "window", message: "解析のモジュールは DOM に依存させない" },
        { name: "navigator", message: "解析のモジュールは Web API に依存させない" },
      ],
    },
  },
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
