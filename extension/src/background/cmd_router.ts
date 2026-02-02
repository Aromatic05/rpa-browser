/**
 * Action 路由：处理 content/panel 的消息，补全 scope 与 tabToken，转发给 agent。
 *
 * 设计边界：
 * - 本模块可以使用 chrome API（属于 background 层）。
 * - 只处理消息与状态，不直接操作 UI。
 */

import {
    addWorkspaceTabId,
    ensureWorkspaceMeta,
    removeWorkspaceTabId,
    resetMetaStore,
    updateWorkspaceMeta,
} from '../services/name_store.js';
import { safeGroupActiveTab, supportsTabGrouping } from '../services/tab_grouping.js';
import { createLogger } from '../shared/logger.js';
import type { Action, ActionErr, ActionOk, RecordedStep, WsEventPayload } from '../shared/types.js';
import { resolveScope } from './scope_resolver.js';
import type { WsClient } from './ws_client.js';

export type CmdRouterOptions = {
    wsClient: WsClient;
    onRefresh: () => void;
    onEvent: (payload: WsEventPayload) => void;
    logger?: (...args: unknown[]) => void;
};

export const createCmdRouter = (options: CmdRouterOptions) => {
    const log = options.logger || createLogger('sw');
    const tabState = new Map<number, { tabToken: string; lastUrl: string; updatedAt: number }>();
    let activeTabId: number | null = null;
    let activeWorkspaceId: string | null = null;
    let activeScopeTabId: string | null = null;
    const supportsTabGroups = supportsTabGrouping(chrome);
    const tokenToWorkspace = new Map<string, string>();
    const withActionBase = (action: Action) => ({
        v: 1 as const,
        id: action.id || crypto.randomUUID(),
        type: action.type,
        payload: action.payload,
        scope: action.scope,
        tabToken: action.tabToken,
        at: action.at,
        traceId: action.traceId,
    });

    const sendAction = async (action: Action): Promise<ActionOk<any> | ActionErr> =>
        options.wsClient.sendAction(withActionBase(action));

    const upsertTab = (tabId: number, tabToken: string, url: string) => {
        tabState.set(tabId, {
            tabToken,
            lastUrl: url,
            updatedAt: Date.now(),
        });
    };

    const getActiveTabId = async () => {
        if (activeTabId != null) return activeTabId;
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length) {
            activeTabId = tabs[0].id ?? null;
        }
        return activeTabId;
    };

    const requestTokenFromTab = (tabId: number) =>
        new Promise<{ ok: boolean; tabToken?: string; url?: string; error?: string }>((resolve) => {
            chrome.tabs.sendMessage(tabId, { type: 'RPA_GET_TOKEN' }, (response: any) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }
                resolve(response || { ok: false, error: 'no response' });
            });
        });

    const ensureTabToken = async (tabId: number) => {
        const existing = tabState.get(tabId);
        if (existing?.tabToken) return existing;
        const response = await requestTokenFromTab(tabId);
        if (response?.ok && response.tabToken) {
            upsertTab(tabId, response.tabToken, response.url || '');
            return tabState.get(tabId);
        }
        return null;
    };

    const getActiveTabToken = async () => {
        const tabId = await getActiveTabId();
        if (tabId == null) return null;
        const tabInfo = await ensureTabToken(tabId);
        if (!tabInfo?.tabToken) return null;
        return { tabId, tabToken: tabInfo.tabToken, urlHint: tabInfo.lastUrl };
    };

    const ensureGroupedActiveTab = async (workspaceId: string) => {
        if (!supportsTabGroups) return;
        const meta = await ensureWorkspaceMeta(workspaceId);
        let groupId = meta.groupId;
        try {
            if (groupId != null && chrome.tabGroups?.get) {
                try {
                    await chrome.tabGroups.get(groupId);
                } catch {
                    groupId = undefined;
                }
            }
            const result = await safeGroupActiveTab(chrome, {
                groupId,
                title: meta.displayName,
                color: meta.color || 'blue',
            });
            if (result.ok) {
                groupId = result.groupId;
                await updateWorkspaceMeta(workspaceId, { groupId });
            }
        } catch {
            log('tab group failed', { workspaceId });
        }
    };

    const ensureWorkspaceTabsGrouped = async (workspaceId: string) => {
        if (!supportsTabGroups) return;
        const meta = await ensureWorkspaceMeta(workspaceId);
        if (!meta.tabIds?.length) return;
        let groupId = meta.groupId;
        if (groupId != null && chrome.tabGroups?.get) {
            try {
                await chrome.tabGroups.get(groupId);
            } catch {
                groupId = undefined;
            }
        }
        try {
            if (groupId == null) {
                groupId = await chrome.tabs.group({ tabIds: meta.tabIds });
                await updateWorkspaceMeta(workspaceId, { groupId });
            } else {
                await chrome.tabs.group({ tabIds: meta.tabIds, groupId });
            }
            if (groupId != null && chrome.tabGroups?.update) {
                await chrome.tabGroups.update(groupId, {
                    title: meta.displayName,
                    color: meta.color || 'blue',
                });
            }
        } catch {
            log('tab group failed', { workspaceId });
        }
    };

    const handleEvent = (payload: WsEventPayload) => {
        if (payload?.event === 'page.bound') {
            const data = payload.data || {};
            if (data.tabToken && data.workspaceId) {
                tokenToWorkspace.set(String(data.tabToken), String(data.workspaceId));
            }
            if (!activeWorkspaceId && data.workspaceId) {
                activeWorkspaceId = String(data.workspaceId);
            }
            if (data.workspaceId) {
                void ensureGroupedActiveTab(String(data.workspaceId));
                void ensureWorkspaceTabsGrouped(String(data.workspaceId));
            }
            options.onRefresh();
            return;
        }
        if (payload?.event === 'workspace.changed') {
            if (payload?.data?.workspaceId) {
                activeWorkspaceId = String(payload.data.workspaceId);
            }
            options.onRefresh();
        }
    };

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
        activeTabId = info.tabId;
        options.onRefresh();
    };

    const onRemoved = (tabId: number) => {
        tabState.delete(tabId);
        if (activeTabId === tabId) {
            activeTabId = null;
        }
        void removeWorkspaceTabId(tabId);
    };

    const onUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (changeInfo.url) {
            const existing = tabState.get(tabId);
            if (existing?.tabToken) {
                upsertTab(tabId, existing.tabToken, changeInfo.url);
            }
        }
    };

    const onStartup = () => {
        void resetMetaStore();
    };

    const onInstalled = () => {
        void resetMetaStore();
    };

    const handleMessage = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (payload?: any) => void) => {
        if (!message?.type) return;
        if (message.type === 'RECORD_STEP') {
            const step = message.step as RecordedStep;
            const workspaceId = tokenToWorkspace.get(message.tabToken) || activeWorkspaceId || 'default';
            // 兼容旧录制通道：收到步骤仅做转发，不再本地持久化。
            void workspaceId;
            sendResponse({ ok: true });
            return true;
        }
        if (message.type === 'RECORD_EVENT') {
            // 录制上报不阻塞响应，避免 SW 休眠导致消息端口关闭。
            sendResponse({ ok: true });
            (async () => {
                const workspaceId = tokenToWorkspace.get(message.tabToken) || activeWorkspaceId || undefined;
                const action: Action = {
                    v: 1,
                    id: crypto.randomUUID(),
                    type: 'record.event',
                    tabToken: message.tabToken,
                    scope: { workspaceId, tabToken: message.tabToken },
                    payload: message.event,
                };
                await sendAction(action);
            })();
            return true;
        }
        if (message.type === 'RPA_HELLO') {
            const tabId = sender.tab?.id;
            if (tabId == null) return;
            upsertTab(tabId, message.tabToken, message.url || sender.tab?.url || '');
            const workspaceId = tokenToWorkspace.get(message.tabToken) || activeWorkspaceId || undefined;
            if (workspaceId) {
                void addWorkspaceTabId(workspaceId, tabId);
                void ensureGroupedActiveTab(workspaceId);
                void ensureWorkspaceTabsGrouped(workspaceId);
            }
            return;
        }

        if (message.type === 'ACTION') {
            (async () => {
                const action = (message.action || {}) as Action;
                if (action.type === 'record.start' || action.type === 'record.stop') {
                    const active = await getActiveTabToken();
                    if (!active) {
                        sendResponse({ ok: false, error: 'tab token unavailable' });
                        return;
                    }
                    const type = action.type === 'record.start' ? 'RECORD_START' : 'RECORD_STOP';
                    const contentResp = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
                        chrome.tabs.sendMessage(active.tabId, { type }, (response: any) => {
                            if (chrome.runtime.lastError) {
                                resolve({ ok: false, error: chrome.runtime.lastError.message });
                                return;
                            }
                            resolve(response || { ok: true });
                        });
                    });
                    if (!contentResp.ok) {
                        sendResponse(contentResp);
                        return;
                    }
                    const scoped: Action = {
                        ...action,
                        v: 1,
                        id: action.id || crypto.randomUUID(),
                        tabToken: active.tabToken,
                        scope: { ...(action.scope || {}), tabToken: active.tabToken },
                    };
                    const payload = await sendAction(scoped);
                    sendResponse(payload);
                    return;
                }

                let tabToken = action.tabToken as string | undefined;
                const scope = resolveScope(
                    { activeWorkspaceId, activeTabId: activeScopeTabId },
                    { workspaceId: action.scope?.workspaceId, tabId: action.scope?.tabId },
                );
                if (!tabToken) {
                    const active = await getActiveTabToken();
                    if (!active) {
                        sendResponse({ ok: false, error: 'tab token unavailable' });
                        return;
                    }
                    tabToken = active.tabToken;
                }
                if (!action.type) {
                    sendResponse({ ok: false, error: 'missing action.type' });
                    return;
                }
                const scoped: Action = {
                    ...action,
                    v: 1,
                    id: action.id || crypto.randomUUID(),
                    tabToken,
                    scope: { workspaceId: scope.workspaceId, tabId: scope.tabId, tabToken },
                };
                if (scope.workspaceId) {
                    activeWorkspaceId = scope.workspaceId;
                }
                if (scope.tabId) {
                    activeScopeTabId = scope.tabId;
                }
                const payload = await sendAction(scoped);
                sendResponse(payload);
                const effectiveWorkspaceId = payload?.ok
                    ? (payload.data as any)?.workspaceId || scope.workspaceId || activeWorkspaceId
                    : null;
                if (!payload?.ok || !effectiveWorkspaceId) return;
                if (action.type === 'workspace.create' || action.type === 'tab.create') {
                    if ((payload.data as any)?.tabToken) {
                        tokenToWorkspace.set((payload.data as any).tabToken, effectiveWorkspaceId);
                    }
                    void ensureGroupedActiveTab(effectiveWorkspaceId);
                    void ensureWorkspaceTabsGrouped(effectiveWorkspaceId);
                } else if (action.type === 'workspace.setActive') {
                    void ensureGroupedActiveTab(effectiveWorkspaceId);
                }
            })();
            return true;
        }
    };

    return {
        handleEvent,
        handleMessage,
        onActivated,
        onRemoved,
        onUpdated,
        onStartup,
        onInstalled,
    };
};
