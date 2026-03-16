const TAB_TOKEN_KEY = '__rpa_tab_token';
const WS_URL = 'ws://127.0.0.1:17333';

const wsStatusEl = document.getElementById('wsStatus');
const tokenEl = document.getElementById('token');
const urlEl = document.getElementById('url');

const setStatus = (text: string, ok = false) => {
    if (wsStatusEl) {
        wsStatusEl.textContent = text;
        wsStatusEl.classList.toggle('ok', ok);
    }
};

const ensureTabToken = () => {
    let token = '';
    try {
        token = sessionStorage.getItem(TAB_TOKEN_KEY) || '';
    } catch {
        // ignore
    }
    if (!token) {
        token = crypto.randomUUID();
        try {
            sessionStorage.setItem(TAB_TOKEN_KEY, token);
        } catch {
            // ignore
        }
    }
    try {
        (window as any).__rpa_tab_token = token;
        (window as any).__TAB_TOKEN__ = token;
    } catch {
        // ignore
    }
    return token;
};

const sendLifecycle = (tabToken: string, type: 'tab.opened' | 'tab.ping') => {
    try {
        const ws = new WebSocket(WS_URL);
        ws.addEventListener('open', () => {
            setStatus('connected', true);
            ws.send(
                JSON.stringify({
                    v: 1,
                    id: crypto.randomUUID(),
                    type,
                    tabToken,
                    scope: { tabToken },
                    payload: {
                        source: 'start_extension',
                        url: location.href,
                        title: document.title,
                        at: Date.now(),
                    },
                }),
            );
            setTimeout(() => {
                try {
                    ws.close();
                } catch {
                    // ignore
                }
            }, 300);
        });
        ws.addEventListener('error', () => {
            setStatus('offline');
        });
    } catch {
        setStatus('offline');
    }
};

const token = ensureTabToken();
if (tokenEl) tokenEl.textContent = `${token.slice(0, 8)}...`;
if (urlEl) urlEl.textContent = location.href;
setStatus('connecting...');
sendLifecycle(token, 'tab.opened');
setInterval(() => {
    sendLifecycle(token, 'tab.ping');
}, 15000);
