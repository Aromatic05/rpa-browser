import {
    addWorkspaceTabId,
    ensureWorkspaceMeta,
    removeWorkspaceTabId,
    resetMetaStore,
    updateWorkspaceMeta,
} from './services/name_store.js';
import { safeGroupActiveTab, supportsTabGrouping } from './tab_grouping.js';

const tabState = new Map<number, { tabToken: string; lastUrl: string; updatedAt: number }>();
let activeTabId: number | null = null;
let activeWorkspaceId: string | null = null;
let activeScopeTabId: string | null = null;
const supportsTabGroups = supportsTabGrouping(chrome);
// Map Playwright tabToken -> workspaceId to group the first page reliably.
const tokenToWorkspace = new Map<string, string>();

const log = (...args: unknown[]) => console.log('[RPA:sw]', ...args);

const upsertTab = (tabId: number, tabToken: string, url: string) => {
    tabState.set(tabId, {
        tabToken,
        lastUrl: url,
        updatedAt: Date.now(),
    });
    log('tab update', { tabId, tabToken, url });
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

let wsRef: WebSocket | null = null;
let wsReady: Promise<void> | null = null;
const pending = new Map<string, (payload: any) => void>();

// Bridge agent events into UI refreshes (panel + floating overlay).
const notifyRefresh = () => {
    chrome.runtime.sendMessage({ type: 'RPA_REFRESH' });
    if (activeTabId != null) {
        chrome.tabs.sendMessage(activeTabId, { type: 'RPA_REFRESH' }, () => {
            if (chrome.runtime.lastError) {
                // ignore if tab has no content script
            }
        });
    }
};

const handleEvent = (payload: any) => {
    if (payload?.event === 'page.bound') {
        const data = payload.data || {};
        if (data.tabToken && data.workspaceId) {
            tokenToWorkspace.set(data.tabToken, data.workspaceId);
        }
        if (!activeWorkspaceId && data.workspaceId) {
            activeWorkspaceId = data.workspaceId;
        }
        if (data.workspaceId) {
            void ensureGroupedActiveTab(data.workspaceId);
            void ensureWorkspaceTabsGrouped(data.workspaceId);
        }
        notifyRefresh();
        return;
    }
    if (payload?.event === 'workspace.changed') {
        if (payload?.data?.workspaceId) {
            activeWorkspaceId = payload.data.workspaceId;
        }
        notifyRefresh();
    }
};

// Keep a single WS connection for bidirectional events + command results.
const connectWs = () => {
    if (wsRef && (wsRef.readyState === WebSocket.OPEN || wsRef.readyState === WebSocket.CONNECTING)) {
        return wsReady || Promise.resolve();
    }
    wsRef = new WebSocket('ws://127.0.0.1:17333');
    wsReady = new Promise((resolve) => {
        wsRef?.addEventListener('open', () => resolve());
    });
    wsRef.addEventListener('message', (event) => {
        let payload: any = event.data;
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch {
                return;
            }
        }
        if (payload?.type === 'event') {
            handleEvent(payload);
            return;
        }
        if (payload?.type === 'result' && payload.requestId) {
            const resolver = pending.get(payload.requestId);
            if (resolver) {
                pending.delete(payload.requestId);
                resolver(payload.payload);
            }
        }
    });
    wsRef.addEventListener('close', () => {
        wsRef = null;
        wsReady = null;
        pending.forEach((resolver) => resolver({ ok: false, error: 'ws closed' }));
        pending.clear();
    });
    wsRef.addEventListener('error', () => {
        // keep existing reconnect behavior on next send
    });
    return wsReady;
};

const sendToAgent = (command: Record<string, unknown>, sendResponse: (payload: unknown) => void) => {
    const requestId = command.requestId as string;
    const timeoutId = setTimeout(() => {
        pending.delete(requestId);
        sendResponse({ ok: false, error: 'ws timeout' });
    }, 20000);
    pending.set(requestId, (payload) => {
        clearTimeout(timeoutId);
        sendResponse(payload);
    });
    connectWs()
        .then(() => {
            wsRef?.send(JSON.stringify({ type: 'cmd', cmd: command }));
        })
        .catch(() => {
            clearTimeout(timeoutId);
            pending.delete(requestId);
            sendResponse({ ok: false, error: 'ws connect failed' });
        });
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

chrome.runtime.onStartup?.addListener(() => {
    void resetMetaStore();
});

chrome.runtime.onInstalled?.addListener(() => {
    void resetMetaStore();
});

chrome.tabs.onActivated.addListener((info: chrome.tabs.TabActiveInfo) => {
    activeTabId = info.tabId;
    log('active tab', activeTabId);
    notifyRefresh();
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
    tabState.delete(tabId);
    if (activeTabId === tabId) {
        activeTabId = null;
    }
    void removeWorkspaceTabId(tabId);
});

chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
    if (changeInfo.url) {
        const existing = tabState.get(tabId);
        if (existing?.tabToken) {
            upsertTab(tabId, existing.tabToken, changeInfo.url);
        }
    }
});

chrome.runtime.onMessage.addListener(
    (message: any, sender: chrome.runtime.MessageSender, sendResponse: (payload?: any) => void) => {
        if (!message?.type) return;
        log('onMessage', message);

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
                const requestId = crypto.randomUUID();
                let tabToken = message.tabToken as string | undefined;
                const workspaceId = (message.workspaceId as string | undefined) || activeWorkspaceId || undefined;
                const scopeTabId = (message.tabId as string | undefined) || activeScopeTabId || undefined;
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
                    workspaceId,
                    tabId: scopeTabId,
                };
                if (workspaceId) {
                    activeWorkspaceId = workspaceId;
                }
                if (scopeTabId) {
                    activeScopeTabId = scopeTabId;
                }
                log('panel command', command);
                const handleResponse = (payload: any) => {
                    sendResponse(payload);
                    const effectiveWorkspaceId =
                        payload?.data?.workspaceId || workspaceId || activeWorkspaceId;
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
                };
                sendToAgent(command, handleResponse);
            })();
            return true;
        }
    },
);
