/**
 * 通用类型定义：收敛扩展内部散落的结构，便于跨层复用与维护。
 *
 * 设计要点：
 * - 类型只描述“协议形状”，不包含具体实现逻辑。
 * - 与 agent 侧协议兼容，字段名保持一致（如 workspaceId/tabId/tabToken）。
 */

import type { ActionType } from './action_types.js';

export type ActionScope = {
    workspaceId?: string;
    tabId?: string;
    tabToken?: string;
};

export type Action<T extends string = ActionType, P = unknown> = {
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

export type WsActionReply = {
    type: string;
    replyTo?: string;
    payload?: ActionOk<unknown> | ActionErr;
};
