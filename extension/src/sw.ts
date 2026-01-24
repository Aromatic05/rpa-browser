const tabState = new Map<number, { tabToken: string; lastUrl: string; updatedAt: number }>();
let activeTabId: number | null = null;

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

const sendToAgent = (
    command: Record<string, unknown>,
    sendResponse: (payload: unknown) => void,
) => {
    log('ws open', command);
    const ws = new WebSocket('ws://127.0.0.1:17333');
    let responded = false;
    const timeoutId = setTimeout(() => {
        respondOnce({ ok: false, error: 'ws timeout' });
    }, 20000);

    const respondOnce = (payload: unknown) => {
        if (responded) return;
        responded = true;
        clearTimeout(timeoutId);
        sendResponse(payload);
        try {
            ws.close();
        } catch {
            // ignore close errors
        }
    };

    ws.addEventListener('open', () => {
        log('ws send', command);
        ws.send(JSON.stringify({ cmd: command }));
    });

    ws.addEventListener('message', (event) => {
        log('ws message', event.data);
        let payload: unknown = event.data;
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch {
                respondOnce({ ok: false, error: 'invalid response' });
                return;
            }
        }
        respondOnce(payload);
    });

    ws.addEventListener('error', () => {
        log('ws error');
        respondOnce({ ok: false, error: 'ws error' });
    });

    ws.addEventListener('close', () => {
        if (!responded) {
            log('ws close');
            respondOnce({ ok: false, error: 'ws closed' });
        }
    });
};

const getActiveTabToken = async () => {
    const tabId = await getActiveTabId();
    if (tabId == null) return null;
    const tabInfo = await ensureTabToken(tabId);
    if (!tabInfo?.tabToken) return null;
    return { tabId, tabToken: tabInfo.tabToken, urlHint: tabInfo.lastUrl };
};

chrome.tabs.onActivated.addListener((info: chrome.tabs.TabActiveInfo) => {
    activeTabId = info.tabId;
    log('active tab', activeTabId);
});

chrome.tabs.onRemoved.addListener((tabId: number) => {
    tabState.delete(tabId);
    if (activeTabId === tabId) {
        activeTabId = null;
    }
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
            return;
        }

        if (message.type === 'CMD') {
            (async () => {
                const requestId = crypto.randomUUID();
                let tabToken = message.tabToken as string | undefined;
                let tabId = message.tabId as number | undefined;
                if (!tabToken) {
                    const active = await getActiveTabToken();
                    if (!active) {
                        sendResponse({ ok: false, error: 'tab token unavailable' });
                        return;
                    }
                    tabToken = active.tabToken;
                    tabId = active.tabId;
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
                    tabId,
                };
                log('panel command', command);
                sendToAgent(command, sendResponse);
            })();
            return true;
        }
    },
);
