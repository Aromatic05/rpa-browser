# Checkpoint

## 概述

Checkpoint 在 step 失败后提供恢复与过程化执行机制，核心入口为 `runCheckpoint`。

## 规范

### 类型

- `procedure`
- `recovery`
- `guard`

### 结构

- `trigger.matchRules`
- `prepare[]`
- `content[]`
- `output`
- `policy.maxAttempts/retryOriginal/stopOnFailure`

### action 类型

- `snapshot`
- `query`
- `compute`
- `act`
- `wait`

### 作用域

- `input`
- `local`
- `output`

`saveAs` 默认写入 `local.*`。

## 示例

```yaml
checkpoint:
  id: ensure_logged_in
  kind: procedure
  content:
    - type: act
      step:
        name: browser.click
        args:
          selector: "#login"
```

## 限制

- output path 只允许 `local.*` 或 `output.*`。
- 不支持未注册 action 类型。
