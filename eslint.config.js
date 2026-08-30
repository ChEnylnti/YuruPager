import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      // Build outputs and caches
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/artifacts/**",
      "**/test-results/**",
      "**/.build/**",
      "**/.yurupager-spike/**",
      // Vendored third-party code
      "vendor/**",
      // Frozen spike evidence kept as re-runnable verification artifacts
      "src/spike/**",
      // Swift sources are out of ESLint's scope (see CI ios job)
      "apps/ios/**",
      // Static web assets
      "apps/web/public/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs"],
    extends: [tseslint.configs.recommended],
    rules: {
      // Underscore-prefixed params/vars are intentional placeholders
      // (e.g. handler signatures that must match a protocol shape).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Warn-level adoption: existing `any` uses are confined to test files;
      // tighten to "error" once the current test debt is paid down.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
