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
import type { Action, ActionErr, ActionOk, WsEventPayload } from '../shared/types.js';
import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';
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
    const tokenToScope = new Map<string, { workspaceId: string; tabId: string }>();
    const upsertTokenScope = (
        tabToken: string,
        workspaceId: string,
        tabId: string,
        source: string,
        actionType?: string,
    ) => {
        const existing = tokenToScope.get(tabToken);
        if (existing && (existing.workspaceId !== workspaceId || existing.tabId !== tabId)) {
            log('mapping.scope_conflict_drop', {
                source,
                actionType: actionType || null,
                tabToken,
                existing,
                incoming: { workspaceId, tabId },
            });
            return false;
        }
        tokenToWorkspace.set(tabToken, workspaceId);
        tokenToScope.set(tabToken, { workspaceId, tabId });
        return true;
    };
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

    const emitLifecycleAction = async (
        type: 'tab.activated' | 'tab.closed',
        tabToken: string,
        payload: Record<string, unknown>,
    ) => {
        if (!tabToken) return;
        try {
            await sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type,
                tabToken,
                scope: { tabToken },
                payload,
            });
        } catch {
            // ignore lifecycle emit failures
        }
    };

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

    const requestTokenFromTab = async (tabId: number) => {
        // Navigation + content-script startup is eventually consistent.
        // Use short retries to avoid turning token discovery into a 20s hard timeout.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const result = await send.toTab<{ ok: boolean; tabToken?: string; url?: string }>(tabId, MSG.GET_TOKEN, undefined, {
                timeoutMs: 1500,
            });
            if (result.ok) {
                const data = result.data || { ok: false, error: 'no response' };
                if (data?.ok && data.tabToken) return data;
            } else if (result.error.code === 'NO_RECEIVER') {
                return { ok: false, error: result.error.message } as const;
            }
            if (attempt < 2) {
                await wait(150);
            }
        }
        return { ok: false, error: 'tab token request timeout' } as const;
    };

    const ensureTabToken = async (tabId: number) => {
        const existing = tabState.get(tabId);
        if (existing?.tabToken) return existing;
        const response = await requestTokenFromTab(tabId);
        if (response?.ok && 'tabToken' in response && response.tabToken) {
            upsertTab(tabId, response.tabToken, ('url' in response && response.url) || '');
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

    const syncWorkspaceTabIdsByToken = async (workspaceId: string, tabToken: string) => {
        const matchedTabIds: number[] = [];
        for (const [tabId, state] of tabState.entries()) {
            if (state.tabToken === tabToken) {
                matchedTabIds.push(tabId);
            }
        }
        if (matchedTabIds.length === 0) return;
        for (const tabId of matchedTabIds) {
            await addWorkspaceTabId(workspaceId, tabId);
        }
        log('workspace.tabIds.synced_by_token', {
            workspaceId,
            tabToken,
            tabIds: matchedTabIds,
        });
    };

    const resolveAliveTabIds = async (tabIds: number[]) => {
        const alive: number[] = [];
        for (const tabId of tabIds) {
            try {
                const tab = await chrome.tabs.get(tabId);
                if (typeof tab.id === 'number') alive.push(tab.id);
            } catch {
                // tab already closed or inaccessible; skip
            }
        }
        return alive;
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
                log('tab group updated', { workspaceId, groupId, mode: 'active-tab' });
            } else {
                log('tab group skipped', {
                    workspaceId,
                    mode: 'active-tab',
                    reason: result.reason,
                    hasGroupId: groupId != null,
                });
            }
        } catch (error) {
            log('tab group failed', {
                workspaceId,
                mode: 'active-tab',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const ensureWorkspaceTabsGrouped = async (workspaceId: string) => {
        if (!supportsTabGroups) return;
        const meta = await ensureWorkspaceMeta(workspaceId);
        const rawTabIds = meta.tabIds || [];
        if (!rawTabIds.length) return;
        const aliveTabIds = await resolveAliveTabIds(rawTabIds);
        if (aliveTabIds.length !== rawTabIds.length) {
            await updateWorkspaceMeta(workspaceId, { tabIds: aliveTabIds });
        }
        if (!aliveTabIds.length) return;
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
                groupId = await chrome.tabs.group({ tabIds: aliveTabIds });
                await updateWorkspaceMeta(workspaceId, { groupId });
            } else {
                await chrome.tabs.group({ tabIds: aliveTabIds, groupId });
            }
            if (groupId != null && chrome.tabGroups?.update) {
                await chrome.tabGroups.update(groupId, {
                    title: meta.displayName,
                    color: meta.color || 'blue',
                });
            }
            log('tab group updated', {
                workspaceId,
                groupId,
                mode: 'workspace-tabs',
                tabCount: aliveTabIds.length,
            });
        } catch (error) {
            log('tab group failed', {
                workspaceId,
                mode: 'workspace-tabs',
                tabCount: aliveTabIds.length,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const handleEvent = (payload: WsEventPayload) => {
        if (payload?.event === 'page.bound') {
            const data = payload.data || {};
            if (data.tabToken && data.workspaceId) {
                tokenToWorkspace.set(String(data.tabToken), String(data.workspaceId));
                void syncWorkspaceTabIdsByToken(String(data.workspaceId), String(data.tabToken));
            }
            if (data.tabToken && data.workspaceId && data.tabId) {
                upsertTokenScope(
                    String(data.tabToken),
                    String(data.workspaceId),
                    String(data.tabId),
                    'event.page.bound',
                );
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
                const workspaceId = String(payload.data.workspaceId);
                activeWorkspaceId = workspaceId;
                void ensureGroupedActiveTab(workspaceId);
                void ensureWorkspaceTabsGrouped(workspaceId);
            }
            options.onRefresh();
        }
    };

    const bootstrapGrouping = async () => {
        try {
            const payload = await sendAction({
                v: 1,
                id: crypto.randomUUID(),
                type: 'workspace.list',
                payload: {},
                scope: {},
            });
            if (!payload?.ok) {
                log('bootstrap.grouping.workspace_list_failed', payload?.error || null);
                return;
            }
            const data = (payload.data || {}) as {
                activeWorkspaceId?: string | null;
                workspaces?: Array<{ workspaceId: string }>;
            };
            const activeId = data.activeWorkspaceId || null;
            if (activeId) {
                activeWorkspaceId = activeId;
                await ensureGroupedActiveTab(activeId);
                await ensureWorkspaceTabsGrouped(activeId);
                log('bootstrap.grouping.active_done', { activeWorkspaceId: activeId });
            }
            const list = Array.isArray(data.workspaces) ? data.workspaces : [];
            for (const ws of list) {
                if (!ws?.workspaceId || ws.workspaceId === activeId) continue;
                await ensureWorkspaceTabsGrouped(ws.workspaceId);
            }
            if (list.length) {
                log('bootstrap.grouping.done', { workspaceCount: list.length, activeWorkspaceId: activeId });
            }
        } catch (error) {
            log('bootstrap.grouping.failed', error instanceof Error ? error.message : String(error));
        }
    };

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
        activeTabId = info.tabId;
        log('tab.onActivated', { tabId: info.tabId, activeWorkspaceId, activeScopeTabId });
        void (async () => {
            const tabInfo = await ensureTabToken(info.tabId);
            if (!tabInfo?.tabToken) return;
            const workspaceId = tokenToWorkspace.get(tabInfo.tabToken) || activeWorkspaceId || undefined;
            if (workspaceId) {
                await addWorkspaceTabId(workspaceId, info.tabId);
                await ensureGroupedActiveTab(workspaceId);
                await ensureWorkspaceTabsGrouped(workspaceId);
            }
            await emitLifecycleAction('tab.activated', tabInfo.tabToken, {
                source: 'extension.sw',
                url: tabInfo.lastUrl || '',
                at: Date.now(),
            });
        })();
        options.onRefresh();
    };

    const onRemoved = (tabId: number) => {
        log('tab.onRemoved', { tabId, known: tabState.has(tabId) });
        const removed = tabState.get(tabId);
        tabState.delete(tabId);
        if (activeTabId === tabId) {
            activeTabId = null;
        }
        if (removed?.tabToken) {
            void emitLifecycleAction('tab.closed', removed.tabToken, {
                source: 'extension.sw',
                at: Date.now(),
            });
            tokenToWorkspace.delete(removed.tabToken);
            tokenToScope.delete(removed.tabToken);
        }
        void removeWorkspaceTabId(tabId);
        options.onRefresh();
    };

    const onUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (changeInfo.url) {
            log('tab.onUpdated', { tabId, url: changeInfo.url });
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

    const reconcileTabs = async () => {
        const tabs = await chrome.tabs.query({});
        const aliveIds = new Set<number>();
        for (const tab of tabs) {
            if (typeof tab.id === 'number') {
                aliveIds.add(tab.id);
            }
        }

        for (const [tabId, state] of tabState.entries()) {
            if (aliveIds.has(tabId)) continue;
            tabState.delete(tabId);
            if (activeTabId === tabId) activeTabId = null;
            if (state.tabToken) {
                await emitLifecycleAction('tab.closed', state.tabToken, {
                    source: 'extension.reconcile',
                    at: Date.now(),
                });
                tokenToWorkspace.delete(state.tabToken);
                tokenToScope.delete(state.tabToken);
            }
            void removeWorkspaceTabId(tabId);
        }
        options.onRefresh();
    };
    setInterval(() => {
        void reconcileTabs().catch(() => {
            // ignore reconcile failures
        });
    }, 15000);

    const handleMessage = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (payload?: any) => void) => {
        if (!message?.type) return;
        if (message.type === MSG.HELLO) {
            const tabId = sender.tab?.id;
            if (tabId == null) return;
            log('msg.hello', { tabId, tabToken: message.tabToken, url: message.url, activeWorkspaceId });
            upsertTab(tabId, message.tabToken, message.url || sender.tab?.url || '');
            const workspaceId = tokenToWorkspace.get(message.tabToken);
            if (workspaceId) {
                void addWorkspaceTabId(workspaceId, tabId);
                void ensureGroupedActiveTab(workspaceId);
                void ensureWorkspaceTabsGrouped(workspaceId);
            } else {
                log('msg.hello.workspace_pending', {
                    tabId,
                    tabToken: message.tabToken,
                    reason: 'workspace not mapped yet',
                });
            }
            sendResponse({ ok: true });
            return;
        }

        if (message.type === MSG.ACTION) {
            (async () => {
                const action = (message.action || {}) as Action;
                log('msg.action.received', {
                    id: action.id,
                    type: action.type,
                    tabToken: action.tabToken,
                    scope: action.scope,
                    senderTabId: sender.tab?.id,
                    activeWorkspaceId,
                    activeScopeTabId,
                });
                let tabToken = (action.tabToken || action.scope?.tabToken) as string | undefined;
                const senderTabId = sender.tab?.id;
                if (typeof senderTabId === 'number') {
                    const senderTabInfo = await ensureTabToken(senderTabId);
                    if (senderTabInfo?.tabToken) {
                        if (!tabToken || tabToken !== senderTabInfo.tabToken) {
                            log('msg.action.override_token_from_sender_tab', {
                                id: action.id,
                                type: action.type,
                                inputTabToken: tabToken || null,
                                senderTabToken: senderTabInfo.tabToken,
                                senderTabId,
                            });
                        }
                        tabToken = senderTabInfo.tabToken;
                    }
                }
                if (!tabToken) {
                    const active = await getActiveTabToken();
                    if (!active) {
                        sendResponse({ ok: false, error: 'tab token unavailable' });
                        return;
                    }
                    tabToken = active.tabToken;
                    log('msg.action.resolved_active_token', { id: action.id, type: action.type, tabToken, tabId: active.tabId });
                }
                const tokenScope = tokenToScope.get(tabToken);
                const fallbackScope = resolveScope(
                    {
                        activeWorkspaceId: activeWorkspaceId,
                        activeTabId: activeScopeTabId,
                    },
                    { workspaceId: action.scope?.workspaceId, tabId: action.scope?.tabId },
                );
                const scope = tokenScope ? { workspaceId: tokenScope.workspaceId, tabId: tokenScope.tabId } : undefined;
                if (tokenScope) {
                    log('msg.action.scope_forced_from_token', {
                        id: action.id,
                        type: action.type,
                        tabToken,
                        tokenScope,
                        inputScope: action.scope || null,
                    });
                }
                log('msg.action.scope_resolved', {
                    id: action.id,
                    type: action.type,
                    tabToken,
                    tokenScope,
                    resolvedScope: scope || null,
                    fallbackScope,
                });
                if (!action.type) {
                    sendResponse({ ok: false, error: 'missing action.type' });
                    return;
                }
                const requestedWorkspaceId = action.scope?.workspaceId;
                const requestedTabId = action.scope?.tabId;
                const hasExplicitScope = !!(requestedWorkspaceId || requestedTabId);
                const conflictsWithTokenScope = !!(
                    tokenScope &&
                    ((requestedWorkspaceId && requestedWorkspaceId !== tokenScope.workspaceId) ||
                        (requestedTabId && requestedTabId !== tokenScope.tabId))
                );
                if (hasExplicitScope) {
                    log('msg.action.scope_mode', {
                        id: action.id,
                        type: action.type,
                        mode: 'scope_only',
                        requestedScope: action.scope || null,
                        tokenScope: tokenScope || null,
                    });
                }
                if (conflictsWithTokenScope) {
                    log('msg.action.scope_token_conflict', {
                        id: action.id,
                        type: action.type,
                        tabToken,
                        tokenScope,
                        requestedScope: action.scope || null,
                        mode: 'scope_only_forward',
                    });
                }
                // If token has no known scope yet, do not guess workspace/tab from global active state.
                // Sending only tabToken avoids stale scope mismatch errors.
                const scopedScope = hasExplicitScope
                    ? {
                          ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
                          ...(requestedTabId ? { tabId: requestedTabId } : {}),
                      }
                    : scope
                      ? { workspaceId: scope.workspaceId, tabId: scope.tabId, tabToken }
                      : { tabToken };
                const scoped: Action = {
                    ...action,
                    v: 1,
                    id: action.id || crypto.randomUUID(),
                    tabToken: hasExplicitScope ? undefined : tabToken,
                    scope: scopedScope,
                };
                if (scope?.workspaceId) {
                    activeWorkspaceId = scope.workspaceId;
                }
                if (scope?.tabId) {
                    activeScopeTabId = scope.tabId;
                }
                const payload = await sendAction(scoped);
                log('msg.action.reply', {
                    id: action.id,
                    type: action.type,
                    ok: payload?.ok,
                    error: payload && !payload.ok ? payload.error : undefined,
                    data: payload?.ok ? payload.data : undefined,
                });
                sendResponse(payload);
                const effectiveWorkspaceId = payload?.ok
                    ? (payload.data as any)?.workspaceId || scope?.workspaceId || activeWorkspaceId
                    : null;
                if (!payload?.ok || !effectiveWorkspaceId) return;
                const responseTabToken = (payload.data as any)?.tabToken as string | undefined;
                const responseTabId = (payload.data as any)?.tabId as string | undefined;
                let mappingUpdated = false;
                if (responseTabToken && effectiveWorkspaceId && responseTabId) {
                    mappingUpdated = upsertTokenScope(
                        responseTabToken,
                        String(effectiveWorkspaceId),
                        String(responseTabId),
                        'action.reply',
                        action.type,
                    );
                    if (mappingUpdated) {
                        log('mapping.updated', {
                            id: action.id,
                            type: action.type,
                            responseTabToken,
                            workspaceId: String(effectiveWorkspaceId),
                            tabId: String(responseTabId),
                        });
                    }
                }
                if (mappingUpdated) {
                    const mappedTabToken = responseTabToken as string;
                    if (typeof senderTabId === 'number') {
                        if (mappedTabToken === tabToken) {
                            upsertTab(
                                senderTabId,
                                mappedTabToken,
                                sender.tab?.url || tabState.get(senderTabId)?.lastUrl || '',
                            );
                            await addWorkspaceTabId(String(effectiveWorkspaceId), senderTabId);
                            log('workspace.tabId.bound', {
                                id: action.id,
                                senderTabId,
                                workspaceId: String(effectiveWorkspaceId),
                                responseTabToken: mappedTabToken,
                                mode: 'same-token',
                            });
                        } else {
                            log('workspace.tabId.bind_skipped', {
                                id: action.id,
                                senderTabId,
                                requestTabToken: tabToken,
                                responseTabToken: mappedTabToken,
                                workspaceId: String(effectiveWorkspaceId),
                                reason: 'response token belongs to a different tab',
                            });
                        }
                    }
                    void ensureGroupedActiveTab(String(effectiveWorkspaceId));
                    void ensureWorkspaceTabsGrouped(String(effectiveWorkspaceId));
                    log('group.sync.triggered', { id: action.id, workspaceId: String(effectiveWorkspaceId) });
                }
                if (action.type === 'workspace.create' || action.type === 'tab.create') {
                    if ((payload.data as any)?.tabToken) {
                        tokenToWorkspace.set((payload.data as any).tabToken, effectiveWorkspaceId);
                    }
                    void ensureGroupedActiveTab(effectiveWorkspaceId);
                    void ensureWorkspaceTabsGrouped(effectiveWorkspaceId);
                } else if (action.type === 'workspace.setActive') {
                    void ensureGroupedActiveTab(effectiveWorkspaceId);
                }
            })().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                try {
                    sendResponse({
                        ok: false,
                        error: {
                            code: 'RUNTIME_ERROR',
                            message: `ACTION dispatch failed: ${message}`,
                        },
                    });
                } catch {
                    // ignore response failures
                }
            });
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
        bootstrapGrouping,
    };
};
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
