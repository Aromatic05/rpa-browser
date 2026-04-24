// eslint.config.mjs
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.runner-dist/**",
      "**/.runner-hot/**",
      "**/.mcp-hot/**",
      "**/.mcp-**/**",
      "**/.user-**/**",
      "**/.artifacts/**",
      "**/.playwright/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/docs/**",
      "**/*.bundle.js",
      "**/*.d.ts"
    ]
  },

  // JS 基础推荐
  js.configs.recommended,

  // 通用 JS / TS 规则
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module"
    },
    rules: {
      "no-debugger": "error",
      "no-alert": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-var": "error",
      "prefer-const": "error",
      "object-shorthand": ["error", "always"],
      "eqeqeq": ["error", "always"],
      "curly": ["error", "all"],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  },

  // TS 推荐规则
  ...tseslint.configs.recommended,

  // TS 严格规则（不含类型信息）
  ...tseslint.configs.strict,

  // TS 基于类型信息的推荐规则
  ...tseslint.configs.recommendedTypeChecked,

  // TS 基于类型信息的严格规则
  ...tseslint.configs.strictTypeChecked,

  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        // 更推荐这种方式，少写 project 路径，和编辑器的类型服务更一致
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // 关闭基础版，改用 TS 版
      "no-unused-vars": "off",
      "no-use-before-define": "off",

      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      "@typescript-eslint/no-use-before-define": [
        "error",
        {
          functions: false,
          classes: true,
          variables: true,
          typedefs: true
        }
      ],

      // 比你原来明显更严格：any 不再直接放开
      "@typescript-eslint/no-explicit-any": "warn",

      // 边界类型建议收紧；如果你觉得太烦可以先改成 warn
      "@typescript-eslint/explicit-module-boundary-types": "warn",

      // Promise / async 安全
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false
          }
        }
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/return-await": ["error", "always"],

      // 不安全类型流动
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",

      // 其它常见工程约束
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": [
        "warn",
        { allowConstantLoopConditions: true }
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports"
        }
      ],
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn"
    }
  },

  // 纯 JS 文件不要跑 type-checked 规则
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked]
  },

  // 测试文件稍微放宽一点
  {
    files: [
      "**/*.test.{ts,tsx,js,jsx}",
      "**/*.spec.{ts,tsx,js,jsx}",
      "**/tests/**/*.{ts,tsx,js,jsx}"
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-floating-promises": "off"
    }
  }
);