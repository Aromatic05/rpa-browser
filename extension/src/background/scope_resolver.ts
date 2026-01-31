/**
 * scope 解析器：负责 workspace/tab 的补全规则。
 *
 * 说明：
 * - 只做“字段补全/优先级”逻辑，不直接发起消息。
 * - 业务侧可在这里统一 scope 优先级，避免散落判断。
 */

export type ScopeState = {
    activeWorkspaceId: string | null;
    activeTabId: string | null;
};

export type ScopeInput = {
    workspaceId?: string;
    tabId?: string;
};

export const resolveScope = (state: ScopeState, input?: ScopeInput) => ({
    workspaceId: input?.workspaceId || state.activeWorkspaceId || undefined,
    tabId: input?.tabId || state.activeTabId || undefined,
});
