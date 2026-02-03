/**
 * Panel UI 主逻辑：负责列表渲染与用户操作响应。
 *
 * 边界说明：
 * - 只处理 UI 与 Action 发送，不直接操作 chrome API。
 * - 状态计算使用 state 模块，保证可测试性。
 */

import {
    applyTabs,
    applyWorkspaces,
    handleCloseTab,
    initState,
    planNewTabScope,
    selectTab,
    selectWorkspace,
    type PanelState,
    type TabItem,
    type WorkspaceItem,
} from '../../state/workspace_state.js';
import { withTabDisplayNames, withWorkspaceDisplayNames } from '../../services/name_store.js';
import { getMockStartUrl } from '../../services/mock_config.js';
import { createUiLogger } from '../log/ui_log.js';
import { send } from '../../shared/send.js';
import { MSG } from '../../shared/protocol.js';

export const initPanelApp = () => {
    const startButton = document.getElementById('startRec') as HTMLButtonElement;
    const stopButton = document.getElementById('stopRec') as HTMLButtonElement;
    const showButton = document.getElementById('showRec') as HTMLButtonElement;
    const clearButton = document.getElementById('clearRec') as HTMLButtonElement;
    const replayButton = document.getElementById('replayRec') as HTMLButtonElement;
    const stopReplayButton = document.getElementById('stopReplay') as HTMLButtonElement;
    const newWorkspaceButton = document.getElementById('newWorkspace') as HTMLButtonElement;
    const refreshWorkspaceButton = document.getElementById('refreshWorkspaces') as HTMLButtonElement;
    const newTabButton = document.getElementById('newTab') as HTMLButtonElement;
    const refreshTabsButton = document.getElementById('refreshTabs') as HTMLButtonElement;
    const enableVerticalTabsButton = document.getElementById('enableVerticalTabs') as HTMLButtonElement;
    const enableTabGroupsButton = document.getElementById('enableTabGroups') as HTMLButtonElement;
    const workspaceList = document.getElementById('workspaceList') as HTMLDivElement;
    const tabList = document.getElementById('tabList') as HTMLDivElement;
    const outEl = document.getElementById('out') as HTMLPreElement;

    const { logPayload, logMessage } = createUiLogger(outEl);

    let state: PanelState = initState();
    const supportsGroups = typeof chrome !== 'undefined' && !!chrome.tabs && !!chrome.tabGroups;
    const recentWorkspaceIds: string[] = [];

    const setState = (next: PanelState) => {
        state = next;
        renderWorkspaceList();
        renderTabList();
    };

    const rememberWorkspace = (workspaceId: string | null) => {
        if (!workspaceId) return;
        const index = recentWorkspaceIds.indexOf(workspaceId);
        if (index >= 0) {
            recentWorkspaceIds.splice(index, 1);
        }
        recentWorkspaceIds.unshift(workspaceId);
    };

    const pickFallbackWorkspace = (workspaces: WorkspaceItem[]) => {
        for (const id of recentWorkspaceIds) {
            if (workspaces.find((ws) => ws.workspaceId === id)) return id;
        }
        return workspaces[0]?.workspaceId || null;
    };

    const renderWorkspaceList = () => {
        workspaceList.innerHTML = '';
        state.workspaces.forEach((ws) => {
            const row = document.createElement('div');
            row.className = 'item';
            const btn = document.createElement('button');
            const label = ws.displayName || `Workspace ${ws.workspaceId.slice(0, 6)}`;
            btn.textContent = `${label} (${ws.tabCount})`;
            if (state.activeWorkspaceId === ws.workspaceId) {
                btn.classList.add('active');
            }
            btn.addEventListener('click', async () => {
                setState(selectWorkspace(state, ws.workspaceId));
                rememberWorkspace(ws.workspaceId);
                await sendPanelAction('workspace.setActive', { workspaceId: ws.workspaceId });
                await refreshTabs();
            });
            row.appendChild(btn);
            workspaceList.appendChild(row);
        });
    };

    const renderTabList = () => {
        tabList.innerHTML = '';
        state.tabs.forEach((tab) => {
            const row = document.createElement('div');
            row.className = 'item';
            const btn = document.createElement('button');
            const label = tab.displayName || tab.title || tab.url || tab.tabId.slice(0, 6);
            const extra = tab.displayName && (tab.title || tab.url) ? ` — ${tab.title || tab.url}` : '';
            btn.textContent = `${label}${extra}`;
            if (tab.active) {
                btn.classList.add('active');
            }
            btn.addEventListener('click', async () => {
                setState(selectTab(state, tab.tabId));
                await sendPanelAction('tab.setActive', {
                    workspaceId: state.activeWorkspaceId || undefined,
                    tabId: tab.tabId,
                });
                await refreshTabs();
            });
            const closeBtn = document.createElement('button');
            closeBtn.textContent = 'Close';
            closeBtn.addEventListener('click', async () => {
                await sendPanelAction('tab.close', {
                    workspaceId: state.activeWorkspaceId || undefined,
                    tabId: tab.tabId,
                });
                const workspacesResp = await sendPanelAction('workspace.list');
                const rawWorkspaces = (workspacesResp?.data?.workspaces || []) as WorkspaceItem[];
                if (!rawWorkspaces.length) {
                    const startUrl = await prepareStartUrl();
                    const created = await sendPanelAction('workspace.create', { startUrl });
                    if (created?.ok === false) {
                        logMessage(`Mock start page unreachable: ${startUrl}`);
                    }
                    await refreshWorkspaces();
                    await refreshTabs();
                    return;
                }
                const namedWorkspaces = await withWorkspaceDisplayNames(rawWorkspaces);
                const filtered = namedWorkspaces.filter((ws) => ws.tabCount > 0);
                const fallbackId = pickFallbackWorkspace(filtered);
                if (fallbackId) {
                    await sendPanelAction('workspace.setActive', { workspaceId: fallbackId });
                    setState(selectWorkspace(state, fallbackId));
                    rememberWorkspace(fallbackId);
                }
                const tabsResp = await sendPanelAction('tab.list', {
                    workspaceId: fallbackId || undefined,
                });
                const rawTabs = (tabsResp?.data?.tabs || []) as TabItem[];
                const namedTabs =
                    fallbackId && rawTabs.length ? await withTabDisplayNames(fallbackId, rawTabs) : [];
                setState(handleCloseTab(state, state.activeWorkspaceId || '', namedTabs, filtered));
            });
            row.appendChild(btn);
            row.appendChild(closeBtn);
            tabList.appendChild(row);
        });
    };

    const sendPanelAction = (
        type: string,
        payload?: Record<string, unknown>,
        scope?: { workspaceId?: string; tabId?: string },
    ): Promise<any> =>
        (async () => {
            const action = {
                v: 1,
                id: crypto.randomUUID(),
                type,
                scope,
                payload: payload || {},
            };
            const result = await send.action(action);
            if (!result.ok) {
                logPayload(result);
                return result;
            }
            logPayload(result.data);
            return result.data;
        })();

    const prepareStartUrl = async () => getMockStartUrl();

    startButton.addEventListener('click', () => sendPanelAction('record.start'));
    stopButton.addEventListener('click', () => sendPanelAction('record.stop'));
    showButton.addEventListener('click', () => sendPanelAction('record.get'));
    clearButton.addEventListener('click', () => sendPanelAction('record.clear'));
    replayButton.addEventListener('click', () => sendPanelAction('play.start'));
    stopReplayButton.addEventListener('click', () => sendPanelAction('play.stop'));

    const refreshWorkspaces = async () => {
        const response = await sendPanelAction('workspace.list');
        if (response?.data?.workspaces) {
            if (response.data.workspaces.length === 0) {
                const startUrl = await prepareStartUrl();
                const created = await sendPanelAction('workspace.create', { startUrl });
                if (created?.ok === false) {
                    logMessage(`Mock start page unreachable: ${startUrl}`);
                }
                return refreshWorkspaces();
            }
            const named = await withWorkspaceDisplayNames(response.data.workspaces as WorkspaceItem[]);
            const preferred = response.data.activeWorkspaceId as string | null | undefined;
            setState(applyWorkspaces(state, named, preferred ?? undefined));
            rememberWorkspace(state.activeWorkspaceId);
        }
    };

    const refreshTabs = async () => {
        const response = await sendPanelAction('tab.list', {
            workspaceId: state.activeWorkspaceId || undefined,
        });
        if (response?.data?.tabs && state.activeWorkspaceId) {
            const named = await withTabDisplayNames(
                state.activeWorkspaceId,
                response.data.tabs as TabItem[],
            );
            setState(applyTabs(state, named));
        }
    };

    newWorkspaceButton.addEventListener('click', async () => {
        const startUrl = await prepareStartUrl();
        const response = await sendPanelAction('workspace.create', { startUrl });
        if (response?.ok === false) {
            logMessage(`Mock start page unreachable: ${startUrl}`);
        }
        rememberWorkspace(response?.data?.workspaceId || null);
        await refreshWorkspaces();
    });
    refreshWorkspaceButton.addEventListener('click', refreshWorkspaces);
    newTabButton.addEventListener('click', async () => {
        const scope = planNewTabScope(state);
        const startUrl = await prepareStartUrl();
        const response = await sendPanelAction('tab.create', { workspaceId: scope.workspaceId, startUrl });
        if (response?.ok === false) {
            logMessage(`Mock start page unreachable: ${startUrl}`);
        }
        await refreshTabs();
    });
    refreshTabsButton.addEventListener('click', refreshTabs);

    let refreshPending = false;
    const scheduleRefresh = () => {
        if (refreshPending) return;
        refreshPending = true;
        queueMicrotask(async () => {
            refreshPending = false;
            await refreshWorkspaces();
            await refreshTabs();
        });
    };

    const init = async () => {
        await refreshWorkspaces();
        await refreshTabs();
    };

    void init();

    chrome.runtime.onMessage.addListener((message: any) => {
        if (message?.type !== MSG.REFRESH) return;
        scheduleRefresh();
    });

    enableVerticalTabsButton.addEventListener('click', () => {
        logMessage('Vertical tabs cannot be enabled programmatically. Please enable in Chrome settings/flags.');
    });

    enableTabGroupsButton.addEventListener('click', () => {
        if (!supportsGroups) {
            logMessage('Tab groups API not available in this Chrome context.');
            return;
        }
        logMessage('Tab groups API is available. New tabs will be grouped by workspace when possible.');
    });
};
