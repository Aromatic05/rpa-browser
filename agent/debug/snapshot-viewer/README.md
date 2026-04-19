# Snapshot Viewer

这是独立 debug tooling，不属于 runner 主执行链路。

## 功能

- 输入 URL 抓取真实页面数据
- 后端直接调用 snapshot 入口函数生成 unified graph
- 支持测试脚本通过 `/api/capture/ingest` 直接推送 `raw/snapshot`
- 前端显示采集列表并一键加载，不再依赖本地文件选择器
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

## 测试侧推送

在测试/脚本侧调用：

```bash
POST http://localhost:5173/api/capture/ingest
Content-Type: application/json
```

请求体可包含：

- `label`
- `raw: { domTree, a11yTree }`
- `snapshot`
- `sourceUrl/finalUrl/title/capturedAt/meta`

采集记录默认存放在系统临时目录：

`$TMPDIR/rpa-snapshot-viewer-captures`（可用 `RPA_SNAPSHOT_CAPTURE_DIR` 覆盖）。

## 构建

```bash
pnpm build
pnpm preview
```
