# Snapshot V2 Viewer

独立的 Snapshot V2 调试工具。它直接使用当前生产链：

```text
browser page
  -> captureControlSnapshot
  -> Form/Table V2 assembly
  -> PageSnapshotSessionStore
  -> SnapshotProjection schemaVersion 2
```

## 功能

- 输入 HTTP/HTTPS URL，在真实 Chromium 页面生成 V2 Projection。
- 切换 overview、interaction、annotation、debug、full projection mode。
- 查看 canonical node tree、Form/Table components、SemanticBindings 和 diagnostics。
- 通过 `/api/capture/ingest` 保存测试产生的 V2 Projection，再从 capture list 加载。
- 旧 V1 UnifiedNode snapshot 不做兼容转换；加载时会明确拒绝。

## 运行

```bash
cd agent/debug/snapshot-viewer
pnpm dev
```

打开 `http://localhost:5173/`。

## 测试侧推送

```bash
POST http://localhost:5173/api/capture/ingest
Content-Type: application/json
```

请求体示例：

```json
{
  "label": "orders-debug",
  "sourceUrl": "https://example.test/orders",
  "snapshot": {
    "schemaVersion": 2,
    "meta": {},
    "roots": [],
    "components": {"forms": [], "tables": []},
    "semantics": [],
    "collections": [],
    "diagnostics": []
  }
}
```

采集记录默认存放于：

```text
$TMPDIR/rpa-snapshot-viewer-captures
```

可用 `RPA_SNAPSHOT_CAPTURE_DIR` 覆盖。

## 构建

```bash
pnpm build
pnpm preview
```
