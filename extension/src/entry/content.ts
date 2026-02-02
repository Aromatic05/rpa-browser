/**
 * Content script 入口：注入悬浮 UI + tabToken，并与 SW 通信。
 *
 * 注意：
 * - 内容脚本是“非 module”脚本，禁止静态 import。
 * - 需要延迟加载录制模块（动态 import）以避免报错。
 * - 运行在页面上下文，不能直接访问 tabs API。
 * - 仅处理 UI 与消息，不做持久化。
 */

type RecorderModule = {
    startRecording: (opts: {
        tabToken: string;
        onEvent: (event: any) => void;
    }) => void;
    stopRecording: () => void;
};

const loadRecorder = (() => {
    let cached: Promise<RecorderModule> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('record/recorder.js');
            cached = import(url) as Promise<RecorderModule>;
        }
        return cached;
    };
})();

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
            if (message?.type === 'RPA_GET_TOKEN') {
                sendResponse({ ok: true, tabToken, url: location.href });
                return true;
            }
            if (message?.type === 'RECORD_START') {
                (async () => {
                    const recorder = await loadRecorder();
                    recorder.startRecording({
                        tabToken,
                        onEvent: (event) => {
                            chrome.runtime.sendMessage({
                                type: 'RECORD_EVENT',
                                tabToken,
                                event,
                            });
                        },
                    });
                    sendResponse({ ok: true });
                })().catch((error) => {
                    sendResponse({ ok: false, error: String(error) });
                });
                return true;
            }
            if (message?.type === 'RECORD_STOP') {
                (async () => {
                    const recorder = await loadRecorder();
                    recorder.stopRecording();
                    sendResponse({ ok: true });
                })().catch((error) => {
                    sendResponse({ ok: false, error: String(error) });
                });
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
    const wsCreate = document.createElement('button');
    wsCreate.textContent = 'Create';
    const wsSetActive = document.createElement('button');
    wsSetActive.textContent = 'Set Active';
    wsActions.append(wsCreate, wsSetActive);

    const tabSection = document.createElement('div');
    tabSection.className = 'panel-section';
    const tabTitle = document.createElement('div');
    tabTitle.className = 'meta';
    tabTitle.textContent = 'Tabs';
    const tabList = document.createElement('div');
    tabList.className = 'list';
    const tabActions = document.createElement('div');
    tabActions.className = 'row';
    const tabCreate = document.createElement('button');
    tabCreate.textContent = 'Create';
    const tabSetActive = document.createElement('button');
    tabSetActive.textContent = 'Set Active';
    const tabClose = document.createElement('button');
    tabClose.textContent = 'Close';
    tabActions.append(tabCreate, tabSetActive, tabClose);

    const logSection = document.createElement('div');
    logSection.className = 'panel-section';
    const logTitle = document.createElement('div');
    logTitle.className = 'meta';
    logTitle.textContent = 'Logs';
    const logList = document.createElement('pre');

    panel.append(meta, row1, row2, row3);
    wsSection.append(wsTitle, wsList, wsActions);
    tabSection.append(tabTitle, tabList, tabActions);
    logSection.append(logTitle, logList);
    panel.append(wsSection, tabSection, logSection);

    wrap.append(ball, panel);
    shadow.append(style, wrap);
    document.documentElement.append(host);

    let open = false;
    ball.addEventListener('click', () => {
        open = !open;
        panel.classList.toggle('open', open);
    });

    const sendCmd = (cmd: string, args?: Record<string, unknown>) =>
        chrome.runtime.sendMessage({ type: 'CMD', cmd, args });

    startBtn.addEventListener('click', () => sendCmd('record.start'));
    stopBtn.addEventListener('click', () => sendCmd('record.stop'));
    showBtn.addEventListener('click', () => sendCmd('record.get'));
    clearBtn.addEventListener('click', () => sendCmd('record.clear'));
    replayBtn.addEventListener('click', () => sendCmd('record.replay'));
    stopReplayBtn.addEventListener('click', () => sendCmd('record.stopReplay'));
    wsCreate.addEventListener('click', () => sendCmd('workspace.create'));
    wsSetActive.addEventListener('click', () => sendCmd('workspace.setActive'));
    tabCreate.addEventListener('click', () => sendCmd('tab.create'));
    tabSetActive.addEventListener('click', () => sendCmd('tab.setActive'));
    tabClose.addEventListener('click', () => sendCmd('tab.close'));

    const render = (state: any) => {
        const logs = state.logs || [];
        logList.textContent = logs.slice(-20).join('\n');
        wsList.innerHTML = '';
        for (const ws of state.workspaces || []) {
            const row = document.createElement('div');
            row.textContent = `${ws.workspaceId.slice(0, 8)}… (${ws.tabCount}) ${ws.activeTabId ? 'active' : ''}`;
            wsList.append(row);
        }
        tabList.innerHTML = '';
        for (const tab of state.tabs || []) {
            const row = document.createElement('div');
            row.textContent = `${tab.tabId.slice(0, 8)}… ${tab.active ? 'active' : ''}`;
            tabList.append(row);
        }
    };

    chrome.runtime.onMessage.addListener((message: any) => {
        if (message?.type === 'PANEL_STATE') {
            render(message.state);
        }
    });
})();
