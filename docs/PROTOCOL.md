# 协议

## 消息封装（扩展 -> Agent）

Service worker 发送：

```
{ cmd: { cmd, tabToken, args, requestId } }
```

含义：

- `cmd`：字符串
- `tabToken`：每个标签页的稳定 token
- `args`：命令特定的参数
- `requestId`：可选 UUID

## 结果

Runner 返回：

```
{ ok: true, tabToken, requestId?, data }
{ ok: false, tabToken, requestId?, error: { code, message, details? } }
```

## 关键命令（录制相关）

- `record.start`
- `record.stop`
- `record.get`
- `record.clear`
- `record.replay`
- `record.stopReplay`

## 无障碍

- `page.a11yScan`（参见 `docs/A11Y.md`）

