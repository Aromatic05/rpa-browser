(() => {
    if (window.top !== window) return;
    if ((window as any).__rpaTokenInjected) return;
    (window as any).__rpaTokenInjected = true;

    const TAB_TOKEN_KEY = '__rpa_tab_token';
    let tabToken = sessionStorage.getItem(TAB_TOKEN_KEY);
    if (!tabToken) {
        tabToken = crypto.randomUUID();
        sessionStorage.setItem(TAB_TOKEN_KEY, tabToken);
    }
    (window as any).__TAB_TOKEN__ = tabToken;

    const sendHello = () => {
        console.log('[RPA] HELLO', { tabToken, url: location.href });
        chrome.runtime.sendMessage({
            type: 'RPA_HELLO',
            tabToken,
            url: location.href,
        });
    };

    chrome.runtime.onMessage.addListener(
        (
            message: any,
            _sender: chrome.runtime.MessageSender,
            sendResponse: (response?: any) => void,
        ) => {
            console.log('[RPA] message', message);
            if (message?.type === 'RPA_GET_TOKEN') {
                sendResponse({ ok: true, tabToken, url: location.href });
                return true;
            }
        },
    );

    const patchHistory = () => {
        const wrap = (method: typeof history.pushState) =>
            function (...args: Parameters<typeof history.pushState>) {
                const result = method.apply(history, args as unknown as [any, any, any]);
                sendHello();
                return result;
            };
        history.pushState = wrap(history.pushState);
        history.replaceState = wrap(history.replaceState);
    };

    patchHistory();
    window.addEventListener('popstate', sendHello);
    window.addEventListener('hashchange', sendHello);
    sendHello();

    const ROOT_ID = 'rpa-floating-panel';
    if (document.getElementById(ROOT_ID)) return;

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
    meta.textContent = `tabToken: ${tabToken.slice(0, 8)}…`;

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
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear Rec';
    const replayBtn = document.createElement('button');
    replayBtn.className = 'primary';
    replayBtn.textContent = 'Replay';
    row2.append(showBtn, clearBtn);

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
    const newTabBtn = document.createElement('button');
    newTabBtn.textContent = 'New Tab';
    const closeTabBtn = document.createElement('button');
    closeTabBtn.textContent = 'Close Tab';
    tabActions.append(newTabBtn, closeTabBtn);
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

    const sendPanelCommand = (
        cmd: string,
        args?: Record<string, unknown>,
        scope?: { workspaceId?: string; tabId?: string },
        onResponse?: (payload: any) => void,
    ) => {
        console.log('[RPA] send command', cmd);
        chrome.runtime.sendMessage(
            { type: 'CMD', cmd, tabToken, args, ...(scope || {}) },
            (response: any) => {
            console.log('[RPA] response', response);
            if (chrome.runtime.lastError) {
                render({ ok: false, error: chrome.runtime.lastError.message });
                return;
            }
            render(response);
            interceptResponse(response);
            onResponse?.(response);
        },
        );
    };

    const DEFAULT_MOCK_ORIGIN = 'http://localhost:4173';
    const DEFAULT_MOCK_PATH = '/pages/start.html#beta';

    const getMockStartUrl = (onUrl: (url: string) => void) => {
        chrome.storage.local.get('mockBaseUrl', (data: any) => {
            const base = (data?.mockBaseUrl as string | undefined) || DEFAULT_MOCK_ORIGIN;
            const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
            onUrl(`${normalized}${DEFAULT_MOCK_PATH}`);
        });
    };

    const createWithStartUrl = (
        cmd: 'workspace.create' | 'tab.create',
        args: Record<string, unknown>,
        onDone?: (payload: any) => void,
    ) => {
        getMockStartUrl((startPageUrl) => {
            sendPanelCommand(
                cmd,
                { ...args, startUrl: startPageUrl },
                undefined,
                (payload) => {
                    if (payload?.ok === false) {
                        render({ ok: false, error: `Mock start page unreachable: ${startPageUrl}` });
                    }
                    onDone?.(payload);
                },
            );
        });
    };

    startBtn.addEventListener('click', () => sendPanelCommand('record.start'));
    stopBtn.addEventListener('click', () => sendPanelCommand('record.stop'));
    showBtn.addEventListener('click', () => sendPanelCommand('record.get'));
    clearBtn.addEventListener('click', () => sendPanelCommand('record.clear'));
    replayBtn.addEventListener('click', () => sendPanelCommand('record.replay'));
    stopReplayBtn.addEventListener('click', () => sendPanelCommand('record.stopReplay'));

    const renderWorkspaces = (workspaces: Array<{ workspaceId: string; activeTabId?: string; tabCount: number }>) => {
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
                sendPanelCommand('workspace.setActive', { workspaceId: ws.workspaceId });
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
                    sendPanelCommand('tab.setActive', { workspaceId: activeWorkspaceId, tabId: tab.tabId });
                } else {
                    sendPanelCommand('tab.setActive', { tabId: tab.tabId });
                }
                refreshTabs();
            });
            tabList.appendChild(btn);
        });
    };

    const refreshWorkspaces = () => {
        sendPanelCommand('workspace.list', {}, undefined);
    };

    const refreshTabs = () => {
        if (activeWorkspaceId) {
            sendPanelCommand('tab.list', { workspaceId: activeWorkspaceId });
        } else {
            sendPanelCommand('tab.list', {});
        }
    };

    newWorkspaceBtn.addEventListener('click', () => {
        createWithStartUrl('workspace.create', {}, (payload) => {
            if (payload?.data?.workspaceId) {
                activeWorkspaceId = payload.data.workspaceId;
            }
            refreshWorkspaces();
            refreshTabs();
        });
    });

    newTabBtn.addEventListener('click', () => {
        if (activeWorkspaceId) {
            createWithStartUrl('tab.create', { workspaceId: activeWorkspaceId }, (payload) => {
                activeTabId = payload?.data?.tabId || activeTabId;
                refreshTabs();
            });
        } else {
            createWithStartUrl('tab.create', {}, (payload) => {
                activeWorkspaceId = payload?.data?.workspaceId || activeWorkspaceId;
                activeTabId = payload?.data?.tabId || activeTabId;
                refreshTabs();
            });
        }
    });

    closeTabBtn.addEventListener('click', () => {
        if (!activeTabId) return;
        if (activeWorkspaceId) {
            sendPanelCommand(
                'tab.close',
                { workspaceId: activeWorkspaceId, tabId: activeTabId },
                undefined,
                () => {
                    sendPanelCommand('workspace.list', {}, undefined, (payload) => {
                        const workspaces = payload?.data?.workspaces || [];
                        if (!workspaces.length) {
                            createWithStartUrl('workspace.create', {}, (created) => {
                                activeWorkspaceId = created?.data?.workspaceId || null;
                                refreshWorkspaces();
                                refreshTabs();
                            });
                            return;
                        }
                        activeWorkspaceId = workspaces[0].workspaceId;
                        sendPanelCommand('workspace.setActive', { workspaceId: activeWorkspaceId });
                        refreshTabs();
                    });
                },
            );
        } else {
            sendPanelCommand('tab.close', { tabId: activeTabId }, undefined, () => {
                sendPanelCommand('workspace.list', {}, undefined, (payload) => {
                    const workspaces = payload?.data?.workspaces || [];
                    if (!workspaces.length) {
                        createWithStartUrl('workspace.create', {}, (created) => {
                            activeWorkspaceId = created?.data?.workspaceId || null;
                            refreshWorkspaces();
                            refreshTabs();
                        });
                        return;
                    }
                    activeWorkspaceId = workspaces[0].workspaceId;
                    sendPanelCommand('workspace.setActive', { workspaceId: activeWorkspaceId });
                    refreshTabs();
                });
            });
        }
    });

    const interceptResponse = (payload: any) => {
        if (payload?.data?.workspaces) {
            renderWorkspaces(payload.data.workspaces);
        }
        if (payload?.data?.tabs) {
            renderTabs(payload.data.tabs);
        }
    };

    refreshWorkspaces();
    refreshTabs();

    chrome.runtime.onMessage.addListener((message: any) => {
        if (message?.type !== 'RPA_REFRESH') return;
        refreshWorkspaces();
        refreshTabs();
    });
})();
