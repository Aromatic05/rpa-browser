# Snapshot Viewer

这是独立 debug tooling，不属于 runner 主执行链路。

## 功能

- 输入 URL 抓取真实页面数据
- 后端直接调用 snapshot 入口函数生成 unified graph
- 在 `DOM tree / A11y tree / Unified graph` 间切换
- 递归树展示，支持展开/折叠
- 点击节点查看详情（`id / role / name / text / attrs`）

## 运行

```bash
cd agent/debug/snapshot-viewer
pnpm install
pnpm dev
```

打开 `http://localhost:5173/`。
在页面里输入 URL，点击“抓取真实页面”。

## 构建

```bash
pnpm build
pnpm preview
```
