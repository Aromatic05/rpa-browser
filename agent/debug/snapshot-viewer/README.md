# Snapshot Viewer

这是独立 debug tooling，不属于 runner 主执行链路。

## 功能

- 加载 JSON（文件导入或手动粘贴）
- 在 `DOM tree / A11y tree / Unified graph` 间切换
- 递归树展示，支持展开/折叠
- 点击节点查看详情（`id / role / name / text / attrs`）

## 运行

在该目录启动静态服务，例如：

```bash
python3 -m http.server 4173
```

访问：

- `http://localhost:4173/`
