const TAB_TOKEN_KEY = '__rpa_tab_token';
const WS_URL = 'ws://127.0.0.1:17333';

const wsStatusEl = document.getElementById('wsStatus');
const tokenEl = document.getElementById('token');
const urlEl = document.getElementById('url');
const restoreStatusEl = document.getElementById('restoreStatus');
const restoreListEl = document.getElementById('restoreList');
const refreshRestoreBtn = document.getElementById('refreshRestore');

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

const sendAction = async (type: string, payload: Record<string, unknown> = {}, scope?: Record<string, unknown>) =>
    new Promise<any>((resolve) => {
        let settled = false;
        let ws: WebSocket | null = null;
        const requestId = crypto.randomUUID();
        const done = (result: any) => {
            if (settled) return;
            settled = true;
            try {
                ws?.close();
            } catch {
                // ignore
            }
            resolve(result);
        };
        const timeout = setTimeout(() => {
            done({ ok: false, error: { message: 'ws action timeout' } });
        }, 5000);
        try {
            ws = new WebSocket(WS_URL);
            ws.addEventListener('open', () => {
                ws?.send(
                    JSON.stringify({
                        v: 1,
                        id: requestId,
                        type,
                        payload,
                        scope: scope || {},
                    }),
                );
            });
            ws.addEventListener('message', (event) => {
                try {
                    const message = JSON.parse(String(event.data || '{}'));
                    if (message?.replyTo !== requestId) return;
                    clearTimeout(timeout);
                    done(message?.payload || { ok: false, error: { message: 'empty payload' } });
                } catch {
                    // ignore parse error
                }
            });
            ws.addEventListener('error', () => {
                clearTimeout(timeout);
                done({ ok: false, error: { message: 'ws action error' } });
            });
        } catch {
            clearTimeout(timeout);
            done({ ok: false, error: { message: 'ws action init failed' } });
        }
    });

const formatTs = (ts: number) => {
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return '-';
    }
};

const renderRestoreList = (items: Array<any>) => {
    if (!restoreListEl) return;
    restoreListEl.innerHTML = '';
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'restore-meta';
        empty.textContent = '当前没有可恢复的 workspace 录制。';
        restoreListEl.appendChild(empty);
        return;
    }
    items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'restore-item';
        const meta = document.createElement('div');
        meta.className = 'restore-meta';
        meta.innerHTML = [
            `<div><strong>${String(item.workspaceId || '-')}</strong></div>`,
            `<div>steps: ${Number(item.stepCount || 0)} | updated: ${formatTs(Number(item.updatedAt || 0))}</div>`,
            `<div>${String(item.entryUrl || '-')}</div>`,
        ].join('');
        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'primary';
        restoreBtn.textContent = '恢复 Workspace';
        restoreBtn.addEventListener('click', async () => {
            if (restoreStatusEl) restoreStatusEl.textContent = 'restoring...';
            const restored = await sendAction('workspace.restore', {
                workspaceId: String(item.workspaceId || ''),
            });
            if (!restored?.ok) {
                if (restoreStatusEl) {
                    restoreStatusEl.textContent = `restore failed: ${restored?.error?.message || 'unknown'}`;
                }
                return;
            }
            if (restoreStatusEl) restoreStatusEl.textContent = 'restore done';
        });
        row.append(meta, restoreBtn);
        restoreListEl.appendChild(row);
    });
};

const refreshRestoreList = async () => {
    if (restoreStatusEl) restoreStatusEl.textContent = 'loading...';
    const result = await sendAction('record.list');
    if (!result?.ok) {
        if (restoreStatusEl) restoreStatusEl.textContent = `load failed: ${result?.error?.message || 'unknown'}`;
        renderRestoreList([]);
        return;
    }
    const items = Array.isArray(result?.data?.recordings) ? result.data.recordings : [];
    renderRestoreList(items);
    if (restoreStatusEl) restoreStatusEl.textContent = `ready (${items.length})`;
};

const token = ensureTabToken();
if (tokenEl) tokenEl.textContent = `${token.slice(0, 8)}...`;
if (urlEl) urlEl.textContent = location.href;
setStatus('connecting...');
sendLifecycle(token, 'tab.opened');
setInterval(() => {
    sendLifecycle(token, 'tab.ping');
}, 15000);
refreshRestoreBtn?.addEventListener('click', () => {
    void refreshRestoreList();
});
void refreshRestoreList();
