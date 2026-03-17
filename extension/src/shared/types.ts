/**
 * 通用类型定义：收敛扩展内部散落的结构，便于跨层复用与维护。
 *
 * 设计要点：
 * - 类型只描述“协议形状”，不包含具体实现逻辑。
 * - 与 agent 侧协议兼容，字段名保持一致（如 workspaceId/tabId/tabToken）。
 */

import type { ActionType } from './action_types.js';

export type WorkspaceId = string;
export type TabId = string;

export type ResultOk<T = unknown> = { ok: true; data: T };
export type ResultErr = { ok: false; error: string };
export type Result<T = unknown> = ResultOk<T> | ResultErr;

export type ActionScope = {
    workspaceId?: WorkspaceId;
    tabId?: TabId;
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

export type WorkspaceItem = {
    workspaceId: WorkspaceId;
    tabCount: number;
    activeTabId?: TabId;
    status?: 'idle' | 'running' | 'error';
    displayName?: string;
};

export type TabItem = {
    tabId: TabId;
    title?: string;
    url?: string;
    active: boolean;
    displayName?: string;
};

export type PanelState = {
    activeWorkspaceId: WorkspaceId | null;
    activeTabId: TabId | null;
    workspaces: WorkspaceItem[];
    tabs: TabItem[];
    logs: string[];
};

export type WorkspaceMeta = {
    displayName: string;
    createdAt: number;
    updatedAt: number;
};

export type TabMeta = {
    displayName: string;
    createdAt: number;
    updatedAt: number;
};

export type WsActionReply = {
    type: string;
    replyTo?: string;
    payload?: ActionOk<unknown> | ActionErr;
};
