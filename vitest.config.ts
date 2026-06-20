import { defineConfig } from "vitest/config";

// 单元测试只覆盖纯函数（URL 构造、脱敏、usage 合并、preset 校验、SSE 分帧）。
// node 环境即可，不需要 jsdom；测试文件紧邻源码。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "web/**/*.test.ts"],
  },
});
