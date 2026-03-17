import {
    ensureWorkspaceMeta,
    resetMetaStore,
    updateWorkspaceMeta,
} from '../services/name_store.js';
import { supportsTabGrouping } from '../services/tab_grouping.js';
import { createLogger } from '../shared/logger.js';
import type { Action, ActionErr, ActionOk, WsEventPayload } from '../shared/types.js';
import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';
import type { WsClient } from './ws_client.js';

export type CmdRouterOptions = {
    wsClient: WsClient;
    onRefresh: () => void;
    onEvent: (payload: WsEventPayload) => void;
    logger?: (...args: unknown[]) => void;
};

const GROUP_TRIGGER_ACTIONS = new Set<string>([
    'workspace.create',
    'workspace.restore',
    'workspace.setActive',
    'tab.create',
    'tab.close',
    'tab.opened',
    'tab.closed',
]);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isRealWebUrl = (url: string | null | undefined) => {
    if (!url) return false;
    return url.startsWith('http://') || url.startsWith('https://');
};

export const createCmdRouter = (options: CmdRouterOptions) => {
    const log = options.logger || createLogger('sw');
    const supportsTabGroups = supportsTabGrouping(chrome);

    const tabState = new Map<number, { tabToken: string; lastUrl: string; updatedAt: number }>();
    const tokenToWorkspace = new Map<string, string>();
    const tokenToScope = new Map<string, { workspaceId: string; tabId: string }>();
    let activeTabId: number | null = null;
    let activeWorkspaceId: string | null = null;
    let activeScopeTabId: string | null = null;

    const dirtyWorkspaces = new Set<string>();
    let groupFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let groupFlushRunning = false;

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
        tabState.set(tabId, { tabToken, lastUrl: url, updatedAt: Date.now() });
    };

    const findTabIdByToken = (tabToken: string) => {
        for (const [tabId, state] of tabState.entries()) {
            if (state.tabToken === tabToken) return tabId;
        }
        return null;
    };

    const requestTokenFromTab = async (tabId: number) => {
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
            if (attempt < 2) await wait(150);
        }
        return { ok: false, error: 'tab token request timeout' } as const;
    };

    const ensureTabToken = async (tabId: number) => {
        const existing = tabState.get(tabId);
        if (existing?.tabToken) return existing;
        const response = await requestTokenFromTab(tabId);
        if (response?.ok && response.tabToken) {
            upsertTab(tabId, response.tabToken, response.url || '');
            return tabState.get(tabId) || null;
        }
        return null;
    };

    const getActiveTabToken = async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (typeof tabId !== 'number') return null;
        activeTabId = tabId;
        const tabInfo = await ensureTabToken(tabId);
        if (!tabInfo?.tabToken) return null;
        return { tabId, tabToken: tabInfo.tabToken, urlHint: tabInfo.lastUrl };
    };

    const upsertTokenScope = (tabToken: string, workspaceId: string, tabId: string) => {
        const existing = tokenToScope.get(tabToken);
        if (existing && (existing.workspaceId !== workspaceId || existing.tabId !== tabId)) {
            log('mapping.scope_conflict_drop', {
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

    const resolveAliveTabIds = async (tabIds: number[]) => {
        const alive: number[] = [];
        for (const tabId of tabIds) {
            try {
                const tab = await chrome.tabs.get(tabId);
                if (typeof tab.id === 'number') alive.push(tab.id);
            } catch {
                // ignore missing tabs
            }
        }
        return alive;
    };

    const resolveWorkspaceTabIds = (workspaceId: string) => {
        const ids: number[] = [];
        for (const [tabId, state] of tabState.entries()) {
            if (!isRealWebUrl(state.lastUrl)) continue;
            const scope = tokenToScope.get(state.tabToken);
            if (!scope || scope.workspaceId !== workspaceId) continue;
            ids.push(tabId);
        }
        return ids;
    };

    const regroupWorkspace = async (workspaceId: string) => {
        if (!supportsTabGroups) return;
        const meta = await ensureWorkspaceMeta(workspaceId);
        const aliveTabIds = await resolveAliveTabIds(resolveWorkspaceTabIds(workspaceId));
        if (!aliveTabIds.length) {
            return;
        }

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
            if (groupId != null && chrome.tabs?.query && chrome.tabs?.ungroup) {
                const groupedTabs = await chrome.tabs.query({ groupId });
                const expected = new Set(aliveTabIds);
                const foreign = groupedTabs
                    .map((tab) => tab.id)
                    .filter((id): id is number => typeof id === 'number' && !expected.has(id));
                if (foreign.length) {
                    await chrome.tabs.ungroup(foreign);
                }
            }
            if (groupId != null && chrome.tabGroups?.update) {
                await chrome.tabGroups.update(groupId, {
                    title: meta.displayName,
                    color: meta.color || 'blue',
                });
            }
        } catch (error) {
            log('group.failed', {
                workspaceId,
                groupId: groupId ?? null,
                tabIds: aliveTabIds,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const flushGrouping = async () => {
        if (groupFlushRunning) return;
        groupFlushRunning = true;
        try {
            while (dirtyWorkspaces.size > 0) {
                const [workspaceId] = dirtyWorkspaces;
                dirtyWorkspaces.delete(workspaceId);
                await regroupWorkspace(workspaceId);
            }
        } finally {
            groupFlushRunning = false;
        }
    };

    const markWorkspaceDirty = (workspaceId: string, reason: string) => {
        if (!workspaceId) return;
        dirtyWorkspaces.add(workspaceId);
        log('group.dirty', { workspaceId, reason, size: dirtyWorkspaces.size });
        if (groupFlushTimer) return;
        groupFlushTimer = setTimeout(() => {
            groupFlushTimer = null;
            void flushGrouping();
        }, 120);
    };

    const handleEvent = (payload: WsEventPayload) => {
        if (payload?.event === 'page.bound') {
            const data = payload.data || {};
            if (data.tabToken && data.workspaceId) {
                tokenToWorkspace.set(String(data.tabToken), String(data.workspaceId));
            }
            if (data.tabToken && data.workspaceId && data.tabId) {
                const ok = upsertTokenScope(String(data.tabToken), String(data.workspaceId), String(data.tabId));
                if (ok) markWorkspaceDirty(String(data.workspaceId), 'page.bound');
            }
            if (!activeWorkspaceId && data.workspaceId) {
                activeWorkspaceId = String(data.workspaceId);
            }
            options.onRefresh();
            return;
        }
        if (payload?.event === 'workspace.changed') {
            const workspaceId = payload?.data?.workspaceId ? String(payload.data.workspaceId) : null;
            const actionType = String(payload?.data?.type || '');
            if (workspaceId) {
                activeWorkspaceId = workspaceId;
                if (GROUP_TRIGGER_ACTIONS.has(actionType)) {
                    markWorkspaceDirty(workspaceId, `workspace.changed:${actionType}`);
                }
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
            const data = payload.data || {};
            const list = Array.isArray((data as any).workspaces) ? ((data as any).workspaces as Array<{ workspaceId: string }>) : [];
            const activeId = (data as any).activeWorkspaceId ? String((data as any).activeWorkspaceId) : null;
            if (activeId) activeWorkspaceId = activeId;
            for (const ws of list) {
                if (ws?.workspaceId) markWorkspaceDirty(ws.workspaceId, 'bootstrap');
            }
        } catch (error) {
            log('bootstrap.grouping.failed', error instanceof Error ? error.message : String(error));
        }
    };

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
        activeTabId = info.tabId;
        void (async () => {
            const tabInfo = await ensureTabToken(info.tabId);
            if (!tabInfo?.tabToken) return;
            const scope = tokenToScope.get(tabInfo.tabToken);
            if (scope) {
                activeWorkspaceId = scope.workspaceId;
                activeScopeTabId = scope.tabId;
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
        const removed = tabState.get(tabId);
        tabState.delete(tabId);
        if (activeTabId === tabId) activeTabId = null;
            if (removed?.tabToken) {
                const workspaceId = tokenToWorkspace.get(removed.tabToken) || null;
                void emitLifecycleAction('tab.closed', removed.tabToken, {
                    source: 'extension.sw',
                    at: Date.now(),
            });
            tokenToWorkspace.delete(removed.tabToken);
                tokenToScope.delete(removed.tabToken);
                if (workspaceId) markWorkspaceDirty(workspaceId, 'tabs.onRemoved');
            }
        options.onRefresh();
    };

    const onUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (!changeInfo.url) return;
        const existing = tabState.get(tabId);
        if (existing?.tabToken) {
            upsertTab(tabId, existing.tabToken, changeInfo.url);
            const scope = tokenToScope.get(existing.tabToken);
            if (scope && isRealWebUrl(changeInfo.url)) {
                markWorkspaceDirty(scope.workspaceId, 'tabs.onUpdated:url');
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

        if (message.type === MSG.HELLO) {
            const tabId = sender.tab?.id;
            if (tabId == null) return;
            const tabToken = String(message.tabToken || '');
            upsertTab(tabId, tabToken, message.url || sender.tab?.url || '');
            const scope = tokenToScope.get(tabToken);
            if (scope) {
                if (activeTabId === tabId) {
                    activeWorkspaceId = scope.workspaceId;
                    activeScopeTabId = scope.tabId;
                }
                if (isRealWebUrl(message.url || sender.tab?.url || '')) {
                    markWorkspaceDirty(scope.workspaceId, 'hello:url-ready');
                }
            }
            sendResponse({ ok: true });
            return;
        }

        if (message.type === MSG.ACTION) {
            (async () => {
                const action = (message.action || {}) as Action;
                let tabToken = (action.tabToken || action.scope?.tabToken) as string | undefined;
                const senderTabId = sender.tab?.id;

                if (typeof senderTabId === 'number') {
                    const senderTabInfo = await ensureTabToken(senderTabId);
                    if (senderTabInfo?.tabToken) tabToken = senderTabInfo.tabToken;
                }

                if (!tabToken) {
                    const active = await getActiveTabToken();
                    if (!active) {
                        sendResponse({ ok: false, error: 'tab token unavailable' });
                        return;
                    }
                    tabToken = active.tabToken;
                }

                const tokenScope = tokenToScope.get(tabToken);
                const scope = tokenScope ? { workspaceId: tokenScope.workspaceId, tabId: tokenScope.tabId } : undefined;
                const requestedWorkspaceId = action.scope?.workspaceId;
                const requestedTabId = action.scope?.tabId;
                const hasExplicitScope = !!(requestedWorkspaceId || requestedTabId);

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

                if (scope?.workspaceId) activeWorkspaceId = scope.workspaceId;
                if (scope?.tabId) activeScopeTabId = scope.tabId;

                const payload = await sendAction(scoped);
                sendResponse(payload);

                const effectiveWorkspaceId = payload?.ok
                    ? (payload.data as any)?.workspaceId || scope?.workspaceId || activeWorkspaceId
                    : null;
                if (!payload?.ok || !effectiveWorkspaceId) return;

                const responseTabToken = (payload.data as any)?.tabToken as string | undefined;
                const responseTabId = (payload.data as any)?.tabId as string | undefined;
                if (responseTabToken && responseTabId) {
                    upsertTokenScope(responseTabToken, String(effectiveWorkspaceId), String(responseTabId));
                }

                if (typeof senderTabId === 'number') {
                    if (tabToken) {
                        const oldTabId = findTabIdByToken(tabToken);
                        if (oldTabId != null && oldTabId !== senderTabId) {
                            tabState.delete(oldTabId);
                        }
                    }
                    const senderUrl = sender.tab?.url || tabState.get(senderTabId)?.lastUrl || '';
                    upsertTab(senderTabId, tabToken, senderUrl);
                }

                const responseToken = responseTabToken || tabToken;
                if (responseToken) {
                    tokenToWorkspace.set(responseToken, String(effectiveWorkspaceId));
                }

                const senderUrlForGroup =
                    typeof senderTabId === 'number' ? sender.tab?.url || tabState.get(senderTabId)?.lastUrl || '' : '';
                const canGroupBySender = isRealWebUrl(senderUrlForGroup);
                if (GROUP_TRIGGER_ACTIONS.has(action.type)) {
                    markWorkspaceDirty(String(effectiveWorkspaceId), `action:${action.type}`);
                } else if (canGroupBySender && responseTabToken && responseTabId) {
                    markWorkspaceDirty(String(effectiveWorkspaceId), 'action:scope-bound');
                }
            })().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                try {
                    sendResponse({ ok: false, error: { code: 'RUNTIME_ERROR', message: `ACTION dispatch failed: ${message}` } });
                } catch {
                    // ignore
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
