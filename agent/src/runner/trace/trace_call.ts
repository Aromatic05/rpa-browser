/**
 * traceCall：统一包装 Trace 操作，负责写入 start/end 事件并返回 ToolResult。
 *
 * 说明：
 * - 仅在 Trace 层做最小错误映射
 * - 不抛异常，统一返回 ToolResult
 */

import type { TraceContext, TraceOpName, ToolResult } from './types';

export type TraceCallMeta = {
    op: TraceOpName;
    args?: unknown;
};

export const traceCall = async <T>(
    _ctx: TraceContext,
    _meta: TraceCallMeta,
    _run: () => Promise<T>,
): Promise<ToolResult<T>> => {
    // 具体实现将在后续 commit 中完成
    return { ok: false, error: { code: 'ERR_UNKNOWN', message: 'not implemented', phase: 'trace' } };
};
