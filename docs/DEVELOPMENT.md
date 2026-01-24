# 开发指南

## 安装

```
pnpm install
```

## 运行

- 构建扩展：

```
pnpm -C extension build
```

- 启动 agent：

```
pnpm -C agent dev
```

- 在 Chrome 中从 `extension/dist` 加载扩展。

## 测试

```
pnpm -C agent test
pnpm -C agent test:headed
```

## 扩展构建

`extension/build.mjs` 在 TypeScript 编译后将 `manifest.json` 和 `panel.html` 复制到 `extension/dist`。

## 常用路径

- 扩展 UI：`extension/src/content.ts`
- Service worker：`extension/src/sw.ts`
- Runner 动作：`agent/src/runner/actions/*`
- 回放逻辑：`agent/src/play/replay.ts`
