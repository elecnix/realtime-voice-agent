import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";

const tsconfigRootDir = fileURLToPath(new URL("./", import.meta.url));

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/node_modules/**",
      "eslint.config.js",
      "server/test-feedback.js",
      "research/**",
      "scripts/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parserOptions: {
        tsconfigRootDir,
        project: ["./client/tsconfig.json", "./server/tsconfig.json", "./tsconfig.eslint.json"]
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  }
);
