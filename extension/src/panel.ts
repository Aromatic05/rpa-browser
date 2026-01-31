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
} from './workspace_state';
import { getStartPageUrl } from './start_page';
import { withTabDisplayNames, withWorkspaceDisplayNames } from './name_store';

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

let state: PanelState = initState();
const workspaceGroups = new Map<string, number>();
const supportsGroups = typeof chrome !== 'undefined' && !!chrome.tabs && !!chrome.tabGroups;

const renderLog = (response: unknown) => {
    outEl.textContent = JSON.stringify(response, null, 2);
};

const logMessage = (message: string) => {
    renderLog({ ok: true, message });
};

const setState = (next: PanelState) => {
    state = next;
    renderWorkspaceList();
    renderTabList();
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
            await sendPanelCommand('workspace.setActive', { workspaceId: ws.workspaceId });
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
            await sendPanelCommand('tab.setActive', {
                workspaceId: state.activeWorkspaceId || undefined,
                tabId: tab.tabId,
            });
            await refreshTabs();
        });
        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', async () => {
            await sendPanelCommand('tab.close', {
                workspaceId: state.activeWorkspaceId || undefined,
                tabId: tab.tabId,
            });
            const workspacesResp = await sendPanelCommand('workspace.list');
            const tabsResp = await sendPanelCommand('tab.list', {
                workspaceId: state.activeWorkspaceId || undefined,
            });
            const nextWorkspaces = (workspacesResp?.data?.workspaces || []) as WorkspaceItem[];
            const nextTabs = (tabsResp?.data?.tabs || []) as TabItem[];
            setState(handleCloseTab(state, state.activeWorkspaceId || '', nextTabs, nextWorkspaces));
            if (!nextTabs.length && nextWorkspaces.length) {
                const newActive = nextWorkspaces[0].workspaceId;
                await sendPanelCommand('workspace.setActive', { workspaceId: newActive });
                setState(selectWorkspace(state, newActive));
                await refreshTabs();
            }
        });
        row.appendChild(btn);
        row.appendChild(closeBtn);
        tabList.appendChild(row);
    });
};

const sendPanelCommand = (
    cmd: string,
    args?: Record<string, unknown>,
    scope?: { workspaceId?: string; tabId?: string },
): Promise<any> =>
    new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CMD', cmd, args, ...(scope || {}) }, (response: any) => {
            if (chrome.runtime.lastError) {
                const errorPayload = { ok: false, error: chrome.runtime.lastError.message };
                renderLog(errorPayload);
                resolve(errorPayload);
                return;
            }
            renderLog(response);
            resolve(response);
        });
    });

const startPageUrl = getStartPageUrl();

const openStartPage = async (workspaceId?: string, tabId?: string) => {
    if (!workspaceId || !tabId) return;
    await sendPanelCommand(
        'page.goto',
        { url: startPageUrl, waitUntil: 'domcontentloaded' },
        { workspaceId, tabId },
    );
};

startButton.addEventListener('click', () => sendPanelCommand('record.start'));
stopButton.addEventListener('click', () => sendPanelCommand('record.stop'));
showButton.addEventListener('click', () => sendPanelCommand('record.get'));
clearButton.addEventListener('click', () => sendPanelCommand('record.clear'));
replayButton.addEventListener('click', () => sendPanelCommand('record.replay'));
stopReplayButton.addEventListener('click', () => sendPanelCommand('record.stopReplay'));

const refreshWorkspaces = async () => {
    const response = await sendPanelCommand('workspace.list');
    if (response?.data?.workspaces) {
        const named = await withWorkspaceDisplayNames(response.data.workspaces as WorkspaceItem[]);
        setState(applyWorkspaces(state, named));
    }
};

const refreshTabs = async () => {
    const response = await sendPanelCommand('tab.list', {
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

const tryGroupCurrentTab = async (workspaceId: string) => {
    if (!supportsGroups || typeof chrome.tabs.group !== 'function') {
        logMessage('Tab groups not available; skipping grouping.');
        return;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = tabs[0];
    if (!active?.id) return;
    let groupId = workspaceGroups.get(workspaceId);
    try {
        if (groupId == null) {
            groupId = await chrome.tabs.group({ tabIds: [active.id] });
            workspaceGroups.set(workspaceId, groupId);
        } else {
            await chrome.tabs.group({ tabIds: [active.id], groupId });
        }
    } catch {
        logMessage('Failed to group tab; continuing without grouping.');
    }
};

newWorkspaceButton.addEventListener('click', async () => {
    const response = await sendPanelCommand('workspace.create');
    await openStartPage(response?.data?.workspaceId, response?.data?.tabId);
    await refreshWorkspaces();
    if (response?.data?.workspaceId) {
        await tryGroupCurrentTab(response.data.workspaceId);
    }
});
refreshWorkspaceButton.addEventListener('click', refreshWorkspaces);
newTabButton.addEventListener('click', async () => {
    const scope = planNewTabScope(state);
    const response = await sendPanelCommand('tab.create', { workspaceId: scope.workspaceId });
    await openStartPage(scope.workspaceId, response?.data?.tabId);
    await refreshTabs();
    if (scope.workspaceId && response?.data?.tabId) {
        await tryGroupCurrentTab(scope.workspaceId);
    }
});
refreshTabsButton.addEventListener('click', refreshTabs);

const init = async () => {
    await refreshWorkspaces();
    await refreshTabs();
};

void init();

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
