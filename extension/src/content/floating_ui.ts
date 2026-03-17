/**
 * floating_ui：只负责 UI 注入/渲染与交互绑定。
 *
 * 设计说明：
 * - 不直接发送消息，所有操作通过 onAction 回调完成。
 * - 内部维护 workspace/tab 的轻量状态，用于渲染与联动刷新。
 */

export type FloatingUIOptions = {
    tabToken: string;
    onAction: (
        type: string,
        payload?: Record<string, unknown>,
        scope?: { workspaceId?: string; tabId?: string },
    ) => Promise<any>;
};

export type FloatingUIHandle = {
    unmount: () => void;
    scheduleRefresh: () => void;
};

export const mountFloatingUI = (opts: FloatingUIOptions): FloatingUIHandle => {
    const ROOT_ID = 'rpa-floating-panel';
    if (document.getElementById(ROOT_ID)) {
        return {
            unmount: () => undefined,
            scheduleRefresh: () => undefined,
        };
    }

    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.style.position = 'fixed';
    host.style.top = '16px';
    host.style.right = '16px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'auto';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
    :host { all: initial; }
    .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .ball {
      width: 44px; height: 44px; border-radius: 999px; border: none;
      background: #111827; color: #f9fafb; font-size: 12px; font-weight: 600;
      cursor: pointer; box-shadow: 0 10px 20px rgba(15, 23, 42, 0.3);
    }
    .panel {
      width: 260px; padding: 10px; border-radius: 12px; background: #fff;
      box-shadow: 0 12px 26px rgba(15, 23, 42, 0.2); border: 1px solid #e2e8f0;
      display: none;
    }
    .panel.open { display: block; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px; }
    .panel-section { margin-top: 8px; }
    .list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 6px; }
    button {
      padding: 6px 8px; font-size: 12px; border-radius: 8px;
      border: 1px solid #cbd5f5; background: #fff; cursor: pointer;
    }
    button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
    pre {
      margin: 6px 0 0; background: #0f172a; color: #e2e8f0;
      padding: 6px; border-radius: 8px; font-size: 11px; max-height: 140px; overflow: auto;
      white-space: pre-wrap;
    }
    .meta { font-size: 11px; color: #6b7280; margin-bottom: 6px; }
  `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const ball = document.createElement('button');
    ball.className = 'ball';
    ball.textContent = 'RPA';

    const panel = document.createElement('div');
    panel.className = 'panel';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `tabToken: ${opts.tabToken.slice(0, 8)}…`;

    const row1 = document.createElement('div');
    row1.className = 'row';
    const startBtn = document.createElement('button');
    startBtn.className = 'primary';
    startBtn.textContent = 'Start Rec';
    const stopBtn = document.createElement('button');
    stopBtn.textContent = 'Stop Rec';
    row1.append(startBtn, stopBtn);

    const row2 = document.createElement('div');
    row2.className = 'row';
    const showBtn = document.createElement('button');
    showBtn.textContent = 'Show Rec';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save WS';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear Rec';
    const replayBtn = document.createElement('button');
    replayBtn.className = 'primary';
    replayBtn.textContent = 'Replay';
    row2.append(showBtn, saveBtn, clearBtn);

    const row3 = document.createElement('div');
    row3.className = 'row';
    const stopReplayBtn = document.createElement('button');
    stopReplayBtn.textContent = 'Stop Replay';
    row3.append(replayBtn, stopReplayBtn);

    const wsSection = document.createElement('div');
    wsSection.className = 'panel-section';
    const wsTitle = document.createElement('div');
    wsTitle.className = 'meta';
    wsTitle.textContent = 'Workspaces';
    const wsList = document.createElement('div');
    wsList.className = 'list';
    const wsActions = document.createElement('div');
    wsActions.className = 'row';
    const newWorkspaceBtn = document.createElement('button');
    newWorkspaceBtn.textContent = 'New Workspace';
    wsActions.append(newWorkspaceBtn);
    wsSection.append(wsTitle, wsList, wsActions);

    const tabSection = document.createElement('div');
    tabSection.className = 'panel-section';
    const tabTitle = document.createElement('div');
    tabTitle.className = 'meta';
    tabTitle.textContent = 'Tabs';
    const tabList = document.createElement('div');
    tabList.className = 'list';
    const tabActions = document.createElement('div');
    tabActions.className = 'row';
    const closeTabBtn = document.createElement('button');
    closeTabBtn.textContent = 'Close Tab';
    tabActions.append(closeTabBtn);
    tabSection.append(tabTitle, tabList, tabActions);

    const out = document.createElement('pre');

    panel.append(meta, row1, row2, row3, wsSection, tabSection, out);
    wrap.append(ball, panel);
    shadow.append(style, wrap);

    const mount = () => {
        if (!document.documentElement) {
            setTimeout(mount, 50);
            return;
        }
        document.documentElement.appendChild(host);
    };
    mount();

    let isOpen = false;
    ball.addEventListener('click', () => {
        isOpen = !isOpen;
        panel.classList.toggle('open', isOpen);
    });

    const render = (payload: unknown) => {
        out.textContent = JSON.stringify(payload, null, 2);
    };

    let activeWorkspaceId: string | null = null;
    let activeTabId: string | null = null;

    // UI 行为统一走 onAction
    const sendPanelAction = async (
        type: string,
        payload?: Record<string, unknown>,
        scope?: { workspaceId?: string; tabId?: string },
        onResponse?: (payload: any) => void,
    ) => {
        const response = await opts.onAction(type, payload, scope);
        render(response);
        interceptResponse(response);
        onResponse?.(response);
    };

    startBtn.addEventListener('click', () => void sendPanelAction('record.start'));
    stopBtn.addEventListener('click', () => void sendPanelAction('record.stop'));
    showBtn.addEventListener('click', () => void sendPanelAction('record.get'));
    saveBtn.addEventListener('click', () =>
        void sendPanelAction('workspace.save', activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
    );
    clearBtn.addEventListener('click', () => void sendPanelAction('record.clear'));
    replayBtn.addEventListener('click', () => void sendPanelAction('play.start'));
    stopReplayBtn.addEventListener('click', () => void sendPanelAction('play.stop'));

    const renderWorkspaces = (
        workspaces: Array<{ workspaceId: string; activeTabId?: string; tabCount: number }>,
    ) => {
        wsList.innerHTML = '';
        if (!activeWorkspaceId && workspaces.length) {
            activeWorkspaceId = workspaces[0].workspaceId;
        }
        workspaces.forEach((ws) => {
            const btn = document.createElement('button');
            btn.textContent = `${ws.workspaceId.slice(0, 6)}… (${ws.tabCount})`;
            if (activeWorkspaceId === ws.workspaceId) {
                btn.classList.add('primary');
            }
            btn.addEventListener('click', () => {
                activeWorkspaceId = ws.workspaceId;
                void sendPanelAction('workspace.setActive', { workspaceId: ws.workspaceId });
                refreshTabs();
            });
            wsList.appendChild(btn);
        });
    };

    const renderTabs = (tabs: Array<{ tabId: string; url: string; title: string; active: boolean }>) => {
        tabList.innerHTML = '';
        tabs.forEach((tab) => {
            const btn = document.createElement('button');
            btn.textContent = `${tab.tabId.slice(0, 6)}… ${tab.title || tab.url || ''}`;
            if (tab.active) {
                btn.classList.add('primary');
                activeTabId = tab.tabId;
            }
            btn.addEventListener('click', () => {
                activeTabId = tab.tabId;
                if (activeWorkspaceId) {
                    void sendPanelAction('tab.setActive', { workspaceId: activeWorkspaceId, tabId: tab.tabId });
                } else {
                    void sendPanelAction('tab.setActive', { tabId: tab.tabId });
                }
                refreshTabs();
            });
            tabList.appendChild(btn);
        });
    };

    const refreshWorkspaces = () => {
        void sendPanelAction('workspace.list', {}, undefined);
    };

    const refreshTabs = () => {
        if (activeWorkspaceId) {
            void sendPanelAction('tab.list', { workspaceId: activeWorkspaceId });
        } else {
            void sendPanelAction('tab.list', {});
        }
    };

    newWorkspaceBtn.addEventListener('click', () => {
        void sendPanelAction('workspace.create', {}, undefined, (payload) => {
            if (payload?.data?.workspaceId) {
                activeWorkspaceId = payload.data.workspaceId;
            }
            refreshWorkspaces();
            refreshTabs();
        });
    });

    closeTabBtn.addEventListener('click', () => {
        if (!activeTabId) return;
        if (activeWorkspaceId) {
            void sendPanelAction('tab.close', { workspaceId: activeWorkspaceId, tabId: activeTabId }, undefined, () => {
                void sendPanelAction('workspace.list', {}, undefined, (payload) => {
                    const workspaces = payload?.data?.workspaces || [];
                    if (!workspaces.length) {
                        void sendPanelAction('workspace.create', {}, undefined, (created) => {
                            activeWorkspaceId = created?.data?.workspaceId || null;
                            refreshWorkspaces();
                            refreshTabs();
                        });
                        return;
                    }
                    activeWorkspaceId = workspaces[0].workspaceId;
                    void sendPanelAction('workspace.setActive', { workspaceId: activeWorkspaceId });
                    refreshTabs();
                });
            });
        } else {
            void sendPanelAction('tab.close', { tabId: activeTabId }, undefined, () => {
                void sendPanelAction('workspace.list', {}, undefined, (payload) => {
                    const workspaces = payload?.data?.workspaces || [];
                    if (!workspaces.length) {
                        void sendPanelAction('workspace.create', {}, undefined, (created) => {
                            activeWorkspaceId = created?.data?.workspaceId || null;
                            refreshWorkspaces();
                            refreshTabs();
                        });
                        return;
                    }
                    activeWorkspaceId = workspaces[0].workspaceId;
                    void sendPanelAction('workspace.setActive', { workspaceId: activeWorkspaceId });
                    refreshTabs();
                });
            });
        }
    });

    const interceptResponse = (payload: any) => {
        if (!payload?.ok) return;
        if (payload?.data?.workspaces) {
            if (payload.data.activeWorkspaceId) {
                activeWorkspaceId = payload.data.activeWorkspaceId;
            }
            renderWorkspaces(payload.data.workspaces);
        }
        if (payload?.data?.tabs) {
            renderTabs(payload.data.tabs);
        }
    };

    refreshWorkspaces();
    refreshTabs();

    let refreshPending = false;
    const scheduleRefresh = () => {
        if (refreshPending) return;
        refreshPending = true;
        queueMicrotask(() => {
            refreshPending = false;
            refreshWorkspaces();
            refreshTabs();
        });
    };

    return {
        unmount: () => {
            host.remove();
        },
        scheduleRefresh,
    };
};
