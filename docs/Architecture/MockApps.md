# MockApps

## 概述

mock apps 提供稳定页面结构，用于 entity_rules、DSL、录制回放回归。

## 规范

### 应用

- `mock/ant-app`
- `mock/element-app`

### 命令

- `pnpm -C mock dev`
- `pnpm -C mock dev:ant`
- `pnpm -C mock dev:element`

### 用途

- 固定 DOM/A11y，降低测试波动。
- 构建 entity_rules 训练与验证样例。

## 示例

- Ant 路由：`http://127.0.0.1:5173/entity-rules`
- Element 路由：`http://127.0.0.1:5174/entity-rules`

## 限制

- mock 是本地夹具，不代表线上站点复杂度。
