/**
 * CMD 路由：处理 content/panel 的消息，补全 scope 与 tabToken，转发给 agent。
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
import type { CmdEnvelope, WsEventPayload } from '../shared/types.js';
import { resolveScope } from './scope_resolver.js';
import type { WsClient } from './ws_client.js';
import type { RawEvent } from '../record/event_capture.js';

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
    const recordEventQueue: Array<{ workspaceId: string; tabToken: string; event: RawEvent }> = [];
    let flushingRecordEvents = false;

    const enqueueRecordEvent = (payload: { workspaceId: string; tabToken: string; event: RawEvent }) => {
        recordEventQueue.push(payload);
        if (recordEventQueue.length > 200) {
            recordEventQueue.shift();
        }
    };

    const flushRecordEvents = async () => {
        if (flushingRecordEvents) return;
        flushingRecordEvents = true;
        while (recordEventQueue.length > 0) {
            const payload = recordEventQueue[0];
            const result = await options.wsClient.sendCommand({
                cmd: 'record.event',
                requestId: crypto.randomUUID(),
                tabToken: payload.tabToken,
                args: payload,
            });
            if (!result?.ok) {
                break;
            }
            recordEventQueue.shift();
        }
        flushingRecordEvents = false;
    };

    const sendRecordEvent = (payload: { workspaceId: string; tabToken: string; event: RawEvent }) => {
        // 轻量策略：失败则入队，后续事件触发重试；不做持久化。
        enqueueRecordEvent(payload);
        void flushRecordEvents();
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

    const handleMessage = (message: CmdEnvelope | any, sender: chrome.runtime.MessageSender, sendResponse: (payload?: any) => void) => {
        if (!message?.type) return;
        if (message.type === 'RECORD_EVENT') {
            const event = message.event as RawEvent;
            const workspaceId =
                tokenToWorkspace.get(message.tabToken) || activeWorkspaceId || 'default';
            sendRecordEvent({ workspaceId, tabToken: message.tabToken, event });
            sendResponse({ ok: true });
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

        if (message.type === 'CMD') {
            (async () => {
                if (message.cmd === 'record.start' || message.cmd === 'record.stop') {
                    const active = await getActiveTabToken();
                    if (!active) {
                        sendResponse({ ok: false, error: 'tab token unavailable' });
                        return;
                    }
                    const type = message.cmd === 'record.start' ? 'RECORD_START' : 'RECORD_STOP';
                    chrome.tabs.sendMessage(active.tabId, { type }, (response: any) => {
                        if (chrome.runtime.lastError) {
                            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                            return;
                        }
                        sendResponse(response || { ok: true });
                    });
                    return;
                }
                if (
                    message.cmd === 'record.get' ||
                    message.cmd === 'record.clear' ||
                    message.cmd === 'record.replay' ||
                    message.cmd === 'record.stopReplay'
                ) {
                    const active = await getActiveTabToken();
                    if (!active) {
                        sendResponse({ ok: false, error: 'tab token unavailable' });
                        return;
                    }
                    const response = await options.wsClient.sendCommand({
                        cmd: message.cmd,
                        requestId: crypto.randomUUID(),
                        tabToken: active.tabToken,
                        args: {},
                    });
                    sendResponse(response);
                    return;
                }

                const requestId = crypto.randomUUID();
                let tabToken = message.tabToken as string | undefined;
                const scope = resolveScope(
                    { activeWorkspaceId, activeTabId: activeScopeTabId },
                    { workspaceId: message.workspaceId, tabId: message.tabId },
                );
                if (!tabToken) {
                    const active = await getActiveTabToken();
                    if (!active) {
                        sendResponse({ ok: false, error: 'tab token unavailable' });
                        return;
                    }
                    tabToken = active.tabToken;
                }
                if (!message.cmd) {
                    sendResponse({ ok: false, error: 'missing cmd' });
                    return;
                }
                const command = {
                    cmd: message.cmd,
                    tabToken,
                    args: message.args || {},
                    requestId,
                    workspaceId: scope.workspaceId,
                    tabId: scope.tabId,
                };
                if (scope.workspaceId) {
                    activeWorkspaceId = scope.workspaceId;
                }
                if (scope.tabId) {
                    activeScopeTabId = scope.tabId;
                }
                const payload = await options.wsClient.sendCommand(command);
                sendResponse(payload);
                const effectiveWorkspaceId =
                    payload?.data?.workspaceId || scope.workspaceId || activeWorkspaceId;
                if (!payload?.ok || !effectiveWorkspaceId) return;
                if (message.cmd === 'workspace.create' || message.cmd === 'tab.create') {
                    if (payload?.data?.tabToken) {
                        tokenToWorkspace.set(payload.data.tabToken, effectiveWorkspaceId);
                    }
                    void ensureGroupedActiveTab(effectiveWorkspaceId);
                    void ensureWorkspaceTabsGrouped(effectiveWorkspaceId);
                } else if (message.cmd === 'workspace.setActive') {
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
