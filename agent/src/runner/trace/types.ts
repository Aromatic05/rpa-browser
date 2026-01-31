/**
 * Trace 类型定义：提供严格的 op 名称、ToolResult 结构与事件模型。
 *
 * 设计说明：
 * - Trace 层只负责“原子操作 + 观测”，不做重试/策略
 * - 所有返回都统一为 ToolResult（不抛异常）
 * - op 名称使用字符串联合类型，避免拼写错误
 */

export type TraceOpName =
    | 'trace.context.newPage'
    | 'trace.page.close'
    | 'trace.page.goto'
    | 'trace.page.getInfo'
    | 'trace.page.snapshotA11y'
    | 'trace.page.screenshot'
    | 'trace.locator.waitForVisible'
    | 'trace.locator.scrollIntoView'
    | 'trace.locator.click'
    | 'trace.locator.focus'
    | 'trace.locator.fill'
    | 'trace.mouse.click'
    | 'trace.page.scrollTo'
    | 'trace.keyboard.press';

export type ToolErrorCode =
    | 'ERR_TIMEOUT'
    | 'ERR_NOT_FOUND'
    | 'ERR_AMBIGUOUS'
    | 'ERR_NOT_INTERACTABLE'
    | 'ERR_UNKNOWN';

export type ToolError = {
    code: ToolErrorCode;
    message: string;
    phase: 'trace';
    details?: unknown;
};

export type ToolResult<T = void> =
    | { ok: true; data?: T }
    | { ok: false; error: ToolError };

export type TraceEvent =
    | {
          type: 'op.start';
          ts: number;
          op: TraceOpName;
          args?: unknown;
      }
    | {
          type: 'op.end';
          ts: number;
          op: TraceOpName;
          ok: boolean;
          durationMs: number;
          args?: unknown;
          result?: unknown;
          error?: ToolError;
      };

export type TraceContext = {
    sinks: TraceSink[];
    hooks: TraceHooks;
    cache: TraceCache;
};

export type TraceCache = {
    a11ySnapshotRaw?: string;
    a11yNodeMap?: Map<string, A11yNodeInfo>;
};

export type A11yNodeInfo = {
    id: string;
    role?: string;
    name?: string;
    description?: string;
    value?: string;
};

export type TraceSink = {
    write: (event: TraceEvent) => void | Promise<void>;
};

export type TraceHooks = {
    beforeOp?: (event: TraceEvent) => void | Promise<void>;
    afterOp?: (event: TraceEvent) => void | Promise<void>;
    onError?: (event: TraceEvent, error: ToolError) => void | Promise<void>;
};
