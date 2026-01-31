import {
    applyTabs,
    applyWorkspaces,
    initState,
    planNewTabScope,
    selectTab,
    selectWorkspace,
    type PanelState,
    type TabItem,
    type WorkspaceItem,
} from './workspace_state';

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
const workspaceList = document.getElementById('workspaceList') as HTMLDivElement;
const tabList = document.getElementById('tabList') as HTMLDivElement;
const outEl = document.getElementById('out') as HTMLPreElement;

let state: PanelState = initState();

const renderLog = (response: unknown) => {
    outEl.textContent = JSON.stringify(response, null, 2);
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
        btn.textContent = `${ws.workspaceId.slice(0, 6)}… (${ws.tabCount})`;
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
        btn.textContent = `${tab.title || tab.url || tab.tabId.slice(0, 6)}`;
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
        row.appendChild(btn);
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

startButton.addEventListener('click', () => sendPanelCommand('record.start'));
stopButton.addEventListener('click', () => sendPanelCommand('record.stop'));
showButton.addEventListener('click', () => sendPanelCommand('record.get'));
clearButton.addEventListener('click', () => sendPanelCommand('record.clear'));
replayButton.addEventListener('click', () => sendPanelCommand('record.replay'));
stopReplayButton.addEventListener('click', () => sendPanelCommand('record.stopReplay'));

const refreshWorkspaces = async () => {
    const response = await sendPanelCommand('workspace.list');
    if (response?.data?.workspaces) {
        setState(applyWorkspaces(state, response.data.workspaces as WorkspaceItem[]));
    }
};

const refreshTabs = async () => {
    const response = await sendPanelCommand('tab.list', {
        workspaceId: state.activeWorkspaceId || undefined,
    });
    if (response?.data?.tabs) {
        setState(applyTabs(state, response.data.tabs as TabItem[]));
    }
};

newWorkspaceButton.addEventListener('click', async () => {
    await sendPanelCommand('workspace.create');
    await refreshWorkspaces();
});
refreshWorkspaceButton.addEventListener('click', refreshWorkspaces);
newTabButton.addEventListener('click', async () => {
    const scope = planNewTabScope(state);
    await sendPanelCommand('tab.create', { workspaceId: scope.workspaceId });
    await refreshTabs();
});
refreshTabsButton.addEventListener('click', refreshTabs);

const init = async () => {
    await refreshWorkspaces();
    await refreshTabs();
};

void init();
