import tseslint from "typescript-eslint";

// ESLint 9 flat config。仅做轻量类型感知 lint：TS 推荐规则 + 项目约定的少量调整。
// 之前散落的 `// eslint-disable-next-line no-control-regex` 注释在此配置下才名副其实。
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".wrangler/**", ".vercel/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // 工具会大量使用 any 处理各家异构响应；降为 off 避免噪声。
      "@typescript-eslint/no-explicit-any": "off",
      // 允许以 _ 前缀标记有意未使用的参数。
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-control-regex": "error",
    },
  },
);
