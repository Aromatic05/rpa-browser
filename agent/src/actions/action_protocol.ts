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

export type ActionOk<T> = { ok: true; data: T };
export type ActionErr = { ok: false; error: { code: string; message: string; details?: any } };

export const makeOk = <T>(data: T): ActionOk<T> => ({ ok: true, data });

export const makeErr = (code: string, message: string, details?: any): ActionErr => ({
    ok: false,
    error: { code, message, details },
});

/**
 * RecordStep：外部上报的录制 Step（必须可序列化）。
 */
export type RecordStep = StepUnion;

export const assertIsAction = (input: unknown): asserts input is Action => {
    if (!input || typeof input !== 'object') {
        throw new Error('invalid action: not an object');
    }
    const action = input as Record<string, unknown>;
    if (action.v !== 1) {
        throw new Error('invalid action: v must be 1');
    }
    if (typeof action.id !== 'string' || !action.id) {
        throw new Error('invalid action: id required');
    }
    if (typeof action.type !== 'string' || !action.type) {
        throw new Error('invalid action: type required');
    }
};
