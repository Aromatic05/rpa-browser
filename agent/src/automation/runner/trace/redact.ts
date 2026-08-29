/**
 * 写往 sinks/hooks 前统一对 TraceEvent 脱敏。
 *
 * 说明：
 * - 不修改原始事件对象，只产出脱敏副本
 * - 对已知携带用户输入的 op 字段强制遮罩，再递归应用 RedactionPolicy
 * - ToolError 保持 code/phase 不变，仅脱敏 message/details
 */

import type { RedactionPolicy } from '../../../security/redaction';
import type { ToolError, TraceEvent, TraceOpName } from './types';

const REDACTED_SECRET_PLACEHOLDER = '[redacted]';

const SENSITIVE_OP_FIELDS: Partial<Record<TraceOpName, readonly string[]>> = {
    'trace.locator.fill': ['value'],
    'trace.locator.type': ['text'],
    'trace.locator.selectOption': ['values'],
};

const SENSITIVE_OP_RESULT_FIELDS: Partial<Record<TraceOpName, readonly string[]>> = {
    'trace.locator.selectOption': ['selected'],
};

const maskSensitiveFields = (
    op: TraceOpName,
    value: unknown,
    keys: readonly string[] | undefined,
): unknown => {
    if (!keys) {return value;}
    const record = value as Record<string, unknown> | null | undefined;
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {return value;}
    const masked: Record<string, unknown> = {...record};
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(masked, key)) {
            masked[key] = REDACTED_SECRET_PLACEHOLDER;
        }
    }
    return masked;
};

const maskSensitiveOpFields = (op: TraceOpName, args: unknown): unknown =>
    maskSensitiveFields(op, args, SENSITIVE_OP_FIELDS[op]);

const maskSensitiveOpResultFields = (op: TraceOpName, result: unknown): unknown =>
    maskSensitiveFields(op, result, SENSITIVE_OP_RESULT_FIELDS[op]);

export const redactToolError = (error: ToolError, policy: RedactionPolicy): ToolError => ({
    ...error,
    message: policy.redactString(error.message).value as string,
    ...(error.details === undefined
        ? {}
        : { details: policy.redact(error.details).value }),
});

export const redactTraceEvent = (event: TraceEvent, policy: RedactionPolicy): TraceEvent => {
    const args = policy.redact(maskSensitiveOpFields(event.op, event.args)).value;
    if (event.type === 'op.start') {
        return { ...event, args };
    }
    return {
        ...event,
        args,
        result: event.result === undefined
            ? undefined
            : policy.redact(maskSensitiveOpResultFields(event.op, event.result)).value,
        error: event.error === undefined ? undefined : redactToolError(event.error, policy),
    };
};