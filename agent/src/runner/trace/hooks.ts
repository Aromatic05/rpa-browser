/**
 * Trace Hooks：在 op 生命周期提供钩子点。
 *
 * 注意：
 * - 当前默认 no-op，不做权限/脱敏处理
 * - 后续可在此层做观测/告警/审计
 */

import type { ToolError, TraceEvent, TraceHooks, ToolResult } from './types';

export const createNoopHooks = (): TraceHooks => ({
    beforeOp: async () => {},
    afterOp: async () => {},
    onError: async () => {},
});

type LoggingHookOptions = {
    maxStringLength?: number;
    maxJsonLength?: number;
};

/**
 * createLoggingHooks：用于人工验收的日志 hooks。
 *
 * 为什么在 afterOp 打印：
 * - afterOp 拿到完整结果（成功/失败），适合做可审查日志
 * - 未来可在此替换为权限审查/脱敏/审计落盘
 *
 * 注意：
 * - 输出为单行，便于 grep/汇总
 * - 对超长字符串做截断（如 screenshot base64）
 */
export const createLoggingHooks = (opts: LoggingHookOptions = {}): TraceHooks => {
    const maxStringLength = opts.maxStringLength ?? 160;
    const maxJsonLength = opts.maxJsonLength ?? 1000;

    const formatArgs = (args: unknown) => safeJson(args, maxStringLength, maxJsonLength);

    const formatResult = (event: TraceEvent) => {
        if (event.type !== 'op.end') return 'null';
        if (!event.ok) {
            return `error=${safeJson(event.error, maxStringLength, maxJsonLength)}`;
        }
        return `result=${safeJson(event.result ?? null, maxStringLength, maxJsonLength)}`;
    };

    return {
        beforeOp: async () => {},
        afterOp: async (event) => {
            if (event.type !== 'op.end') return;
            const args = formatArgs(event.args ?? null);
            const result = formatResult(event);
            const ms = event.durationMs;
            // 单行、稳定格式，便于 grep/分析
            console.log(
                `[trace] op=${event.op} ok=${event.ok} ms=${ms} args=${args} ${result}`,
            );
        },
        onError: async (event, error) => {
            if (event.type !== 'op.end') return;
            // afterOp 已打印失败路径，这里只补充一次 error（可选）
            console.log(
                `[trace] op=${event.op} ok=false ms=${event.durationMs} error=${safeJson(
                    error,
                    maxStringLength,
                    maxJsonLength,
                )}`,
            );
        },
    };
};

const safeJson = (value: unknown, maxStringLength: number, maxJsonLength: number) => {
    try {
        const json = JSON.stringify(value, (_key, v) => {
            if (typeof v === 'string') {
                return truncateString(v, maxStringLength);
            }
            return v;
        });
        if (!json) return 'null';
        if (json.length > maxJsonLength) {
            return JSON.stringify({
                len: json.length,
                preview: json.slice(0, maxJsonLength),
            });
        }
        return json;
    } catch (error) {
        return JSON.stringify({
            error: 'stringify_failed',
            message: error instanceof Error ? error.message : String(error),
        });
    }
};

const truncateString = (value: string, maxLen: number) => {
    if (value.length <= maxLen) return value;
    return `${value.slice(0, maxLen)}...`;
};
