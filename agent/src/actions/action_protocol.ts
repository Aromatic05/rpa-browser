import type { StepUnion } from '../runner/steps/types';

/**
 * Action 协议：WS 唯一协议单元。
 *
 * 说明：
 * - Action 是 extension ↔ agent 的唯一协议对象。
 * - Step 仅是 agent 内部执行协议，只能作为 Action.payload 的一部分。
 */

export type ActionScope = {
    workspaceId?: string;
    tabId?: string;
    tabToken?: string;
};

/**
 * 协议硬约束（禁止修改为 RPC）：
 * - Action 是唯一跨进程/跨端传输单元，请求、回复、错误、流式事件都必须是 Action。
 * - replyTo 仅用于关联 Action，不允许返回 { ok, data } / { ok, error } 包装体。
 * - payload 只承载业务数据，协议语义由 type/replyTo/scope/tabToken/traceId/at 承担。
 */
export type Action<T extends string = string, P = unknown> = {
    v: 1;
    id: string;
    type: T;
    tabToken?: string;
    scope?: ActionScope;
    payload?: P;
    at?: number;
    traceId?: string;
    replyTo?: string;
};

export type ActionFailurePayload = {
    code: string;
    message: string;
    details?: any;
};

const copyScope = (scope?: ActionScope) => (scope ? { ...scope } : undefined);

export const replyAction = <P>(
    request: Action,
    payload?: P,
    type = `${request.type}.result`,
): Action<string, P> => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    tabToken: request.tabToken,
    scope: copyScope(request.scope),
    payload,
    at: Date.now(),
    traceId: request.traceId,
    replyTo: request.id,
});

export const failedAction = (
    request: Action,
    code: string,
    message: string,
    details?: any,
    type = `${request.type}.failed`,
): Action<string, ActionFailurePayload> => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    tabToken: request.tabToken,
    scope: copyScope(request.scope),
    payload: { code, message, details },
    at: Date.now(),
    traceId: request.traceId,
    replyTo: request.id,
});

export const isFailedAction = (action: Action) => action.type.endsWith('.failed');

/**
 * RecordStep：外部上报的录制 Step（必须可序列化）。
 */
export type RecordStep = StepUnion;
