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
      // sample/demo/test-case fixtures: skip lint to keep signal focused on runtime code
      "agent/tests/**",
      "agent/tests/specs/**",
      "agent/tests/integration/scenarios/**",
      "agent/scripts/**",
      "agent/debug/snapshot-viewer/**",
      "agent/src/demo/**",
      "agent/src/runner/demo/**",
      "agent/src/runner/trace/demo/**",
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
          // this codebase has many forward references for helpers/constants;
          // keep class checks only to avoid overwhelming false-positive volume.
          variables: false,
          typedefs: false
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

  // browser extension / start page runtime globals
  {
    files: [
      "extension/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "start_extension/**/*.{ts,tsx,js,jsx,mjs,cjs}"
    ],
    languageOptions: {
      globals: {
        chrome: "readonly",
        console: "readonly",
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        location: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        queueMicrotask: "readonly"
      }
    },
    rules: {
      // @types/chrome 标注了大量 deprecated，不适合作为 MV3 extension 的阻塞规则
      "@typescript-eslint/no-deprecated": "off"
    }
  },

  {
    files: ["extension/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    rules: {
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "no-console": "off"
    }
  },

  // build scripts run in node context
  {
    files: ["**/build.mjs"],
    languageOptions: {
      globals: {
        URL: "readonly",
        process: "readonly"
      }
    }
  },

  // these paths are intentionally outside agent/tsconfig include set
  {
    files: [
      "agent/scripts/**/*.{ts,tsx}",
      "agent/tests/**/*.{ts,tsx}",
      "agent/debug/snapshot-viewer/**/*.{ts,tsx}"
    ],
    extends: [tseslint.configs.disableTypeChecked]
  },

  // agent runtime uses async-compatible handler signatures and rich string interpolation
  {
    files: ["agent/src/actions/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/require-await": "off"
    }
  },
  {
    files: ["agent/src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unnecessary-type-conversion": "warn",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-implied-eval": "off",
      "@typescript-eslint/return-await": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowNullish: true
        }
      ]
    }
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
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-non-null-assertion": "off"
    }
  }
);
