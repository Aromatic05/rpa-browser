/**
 * traceCall：统一包装 Trace 操作，负责写入 start/end 事件并返回 ToolResult。
 *
 * 说明：
 * - 仅在 Trace 层做最小错误映射（超时/未知）
 * - 不抛异常，统一返回 ToolResult
 * - start/end 事件写入所有 sinks，并触发 hooks
 */

import type { TraceContext, TraceOpName, ToolError, ToolResult, TraceEvent } from './types';

export type TraceCallMeta = {
    op: TraceOpName;
    args?: unknown;
};

export const traceCall = async <T>(
    ctx: TraceContext,
    meta: TraceCallMeta,
    run: () => Promise<T>,
): Promise<ToolResult<T>> => {
    const startTs = Date.now();
    const startEvent: TraceEvent = {
        type: 'op.start',
        ts: startTs,
        op: meta.op,
        args: meta.args,
    };
    await ctx.hooks.beforeOp?.(startEvent);
    await Promise.all(ctx.sinks.map((sink) => sink.write(startEvent)));

    try {
        const data = await run();
        const endEvent: TraceEvent = {
            type: 'op.end',
            ts: Date.now(),
            op: meta.op,
            ok: true,
            durationMs: Date.now() - startTs,
            args: meta.args,
            result: data,
        };
        await Promise.all(ctx.sinks.map((sink) => sink.write(endEvent)));
        await ctx.hooks.afterOp?.(endEvent);
        return { ok: true, data };
    } catch (error) {
        const mapped = mapTraceError(error);
        const endEvent: TraceEvent = {
            type: 'op.end',
            ts: Date.now(),
            op: meta.op,
            ok: false,
            durationMs: Date.now() - startTs,
            args: meta.args,
            error: mapped,
        };
        await Promise.all(ctx.sinks.map((sink) => sink.write(endEvent)));
        await ctx.hooks.afterOp?.(endEvent);
        await ctx.hooks.onError?.(endEvent, mapped);
        return { ok: false, error: mapped };
    }
};

const mapTraceError = (error: unknown): ToolError => {
    if (isToolErrorLike(error)) {
        return error;
    }
    if (error instanceof Error) {
        if (error.name === 'TimeoutError' || /timeout/i.test(error.message)) {
            return { code: 'ERR_TIMEOUT', message: 'timeout', phase: 'trace' };
        }
        if (isAmbiguousError(error.message)) {
            return { code: 'ERR_AMBIGUOUS', message: 'ambiguous', phase: 'trace' };
        }
        return { code: 'ERR_UNKNOWN', message: error.message || 'unknown', phase: 'trace' };
    }
    return { code: 'ERR_UNKNOWN', message: 'unknown', phase: 'trace', details: error };
};

const isToolErrorLike = (error: unknown): error is ToolError => {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as ToolError;
    return typeof candidate.code === 'string' && typeof candidate.message === 'string' && candidate.phase === 'trace';
};

const isAmbiguousError = (message: string) =>
    /strict mode|multiple elements|ambiguous|matches\\s+\\d+\\s+elements/i.test(message);
