import { defineConfig } from "vitest/config";

export default defineConfig({
  // テストが実機の記録(test/fixtures/*.bin)を `?inline`(base64 の data URL)で読むため、.bin をアセットとして扱う
  assetsInclude: ["**/*.bin"],
  build: {
    // three.js(Step 4 の 3D 表示)を含めると 1 つのチャンクが約 586 kB(gzip 約 150 kB。2026-09-27 の実測)になる。
    // three.js の本体だけで 500 kB を超えるので分割しても警告は消えない。ローカルで使う開発用のアプリなので上限を上げる
    chunkSizeWarningLimit: 700,
  },
  test: {
    // 解析のロジックは DOM に依存しないので Node 上で動かす
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
