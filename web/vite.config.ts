import { defineConfig } from "vitest/config";

export default defineConfig({
  // テストが実機の記録(test/fixtures/*.bin)を `?inline`(base64 の data URL)で読むため、.bin をアセットとして扱う
  assetsInclude: ["**/*.bin"],
  test: {
    // 解析のロジックは DOM に依存しないので Node 上で動かす
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
