import {
    applyTabs,
    applyWorkspaces,
    initState,
    planNewTabScope,
    selectTab,
    selectWorkspace,
    type PanelState,
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
        btn.addEventListener('click', () => {
            setState(selectWorkspace(state, ws.workspaceId));
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
        btn.addEventListener('click', () => {
            setState(selectTab(state, tab.tabId));
        });
        row.appendChild(btn);
        tabList.appendChild(row);
    });
};

const sendPanelCommand = (cmd: string, args?: Record<string, unknown>) => {
    chrome.runtime.sendMessage({ type: 'CMD', cmd, args }, (response: any) => {
        if (chrome.runtime.lastError) {
            renderLog({ ok: false, error: chrome.runtime.lastError.message });
            return;
        }
        renderLog(response);
    });
};

startButton.addEventListener('click', () => sendPanelCommand('record.start'));
stopButton.addEventListener('click', () => sendPanelCommand('record.stop'));
showButton.addEventListener('click', () => sendPanelCommand('record.get'));
clearButton.addEventListener('click', () => sendPanelCommand('record.clear'));
replayButton.addEventListener('click', () => sendPanelCommand('record.replay'));
stopReplayButton.addEventListener('click', () => sendPanelCommand('record.stopReplay'));

newWorkspaceButton.addEventListener('click', () => {
    setState({ ...state, workspaces: state.workspaces });
});
refreshWorkspaceButton.addEventListener('click', () => {
    setState({ ...state, workspaces: state.workspaces });
});
newTabButton.addEventListener('click', () => {
    planNewTabScope(state);
});
refreshTabsButton.addEventListener('click', () => {
    setState(applyTabs(state, state.tabs));
});

setState(applyWorkspaces(state, []));
