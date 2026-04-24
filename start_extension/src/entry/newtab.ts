const TAB_TOKEN_KEY = '__rpa_tab_token';
const TAB_TOKEN_WIN_NAME_PREFIX = '__RPA_TAB_TOKEN__:';
const WS_URL = 'ws://127.0.0.1:17333';

const wsStatusEl = document.getElementById('wsStatus');
const tokenEl = document.getElementById('token');
const urlEl = document.getElementById('url');
const restoreStatusEl = document.getElementById('restoreStatus');
const restoreListEl = document.getElementById('restoreList');
const refreshRestoreBtn = document.getElementById('refreshRestore');
const log = (...args: unknown[]) => { console.log('[RPA:start]', ...args); };
type RestoreItem = {
    workspaceId?: string;
    stepCount?: number;
    updatedAt?: number;
    entryUrl?: string;
};

const setStatus = (text: string, ok = false) => {
    if (wsStatusEl) {
        wsStatusEl.textContent = text;
        wsStatusEl.classList.toggle('ok', ok);
    }
};

const ensureTabToken = () => {
    return sessionStorage.getItem(TAB_TOKEN_KEY) || '';
};

const sendAction = async (type: string, payload: Record<string, unknown> = {}, scope?: Record<string, unknown>) =>
    await new Promise<any>((resolve) => {
        let settled = false;
        let ws: WebSocket | null = null;
        const requestId = crypto.randomUUID();
        const done = (result: any) => {
            if (settled) {return;}
            settled = true;
            ws?.close();
            resolve(result);
        };
        const timeout = setTimeout(() => {
            log('action.timeout', { type, requestId, payload, scope: scope || {} });
            done({ ok: false, error: { message: 'ws action timeout' } });
        }, 5000);
        ws = new WebSocket(WS_URL);
        log('action.ws.connecting', { type, requestId, payload, scope: scope || {} });
        ws.addEventListener('open', () => {
            log('action.ws.open', { type, requestId });
            ws?.send(
                JSON.stringify({
                    v: 1,
                    id: requestId,
                    type,
                    payload,
                    scope: scope || {},
                }),
            );
            log('action.sent', { type, requestId });
        });
        ws.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data || '{}'));
            if (message?.replyTo !== requestId) {return;}
            clearTimeout(timeout);
            log('action.reply', { type, requestId, ok: message?.payload?.ok, payload: message?.payload });
            done(message?.payload || { ok: false, error: { message: 'empty payload' } });
        });
        ws.addEventListener('error', () => {
            clearTimeout(timeout);
            log('action.ws.error', { type, requestId });
            done({ ok: false, error: { message: 'ws action error' } });
        });
    });

const ensureTabTokenFromAgent = async () => {
    let token = ensureTabToken();
    if (!token) {
        const initialized = await sendAction('tab.init', {
            source: 'start_extension',
            url: location.href,
            at: Date.now(),
        });
        if (!initialized?.ok || !initialized?.data?.tabToken) {
            throw new Error(initialized?.error?.message || 'tab token init failed');
        }
        token = String(initialized.data.tabToken);
        sessionStorage.setItem(TAB_TOKEN_KEY, token);
    }
    window.name = `${TAB_TOKEN_WIN_NAME_PREFIX}${token}`;
    (window as any).__rpa_tab_token = token;
    (window as any).__TAB_TOKEN__ = token;
    log('token.ensure', { token, url: location.href });
    return token;
};

const formatTs = (ts: number) => new Date(ts).toLocaleString();

const renderRestoreList = (items: RestoreItem[]) => {
    if (!restoreListEl) {return;}
    restoreListEl.innerHTML = '';
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'restore-meta';
        empty.textContent = '当前没有可恢复的 workspace 录制。';
        restoreListEl.appendChild(empty);
        return;
    }
    items.forEach((item) => {
        const workspaceId = item.workspaceId ?? '-';
        const stepCount = item.stepCount ?? 0;
        const updatedAt = item.updatedAt ?? 0;
        const entryUrl = item.entryUrl ?? '-';
        const row = document.createElement('div');
        row.className = 'restore-item';
        const meta = document.createElement('div');
        meta.className = 'restore-meta';
        meta.innerHTML = [
            `<div><strong>${workspaceId}</strong></div>`,
            `<div>steps: ${String(stepCount)} | updated: ${formatTs(updatedAt)}</div>`,
            `<div>${entryUrl}</div>`,
        ].join('');
        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'primary';
        restoreBtn.textContent = '恢复 Workspace';
        restoreBtn.addEventListener('click', () => {
            void (async () => {
                if (restoreStatusEl) {restoreStatusEl.textContent = 'restoring...';}
                const restored = await sendAction('workspace.restore', {
                    workspaceId: workspaceId === '-' ? '' : workspaceId,
                });
                if (!restored?.ok) {
                    if (restoreStatusEl) {
                        const errorMessage = restored?.error?.message ?? 'unknown';
                        restoreStatusEl.textContent = `restore failed: ${String(errorMessage)}`;
                    }
                    return;
                }
                if (restoreStatusEl) {restoreStatusEl.textContent = 'restore done';}
            })();
        });
        row.append(meta, restoreBtn);
        restoreListEl.appendChild(row);
    });
};

const refreshRestoreList = async () => {
    if (restoreStatusEl) {restoreStatusEl.textContent = 'loading...';}
    const result = await sendAction('record.list');
    if (!result?.ok) {
        if (restoreStatusEl) {
            const errorMessage = result?.error?.message ?? 'unknown';
            restoreStatusEl.textContent = `load failed: ${String(errorMessage)}`;
        }
        renderRestoreList([]);
        return;
    }
    const items = Array.isArray(result?.data?.recordings) ? (result.data.recordings as RestoreItem[]) : [];
    renderRestoreList(items);
    if (restoreStatusEl) {restoreStatusEl.textContent = `ready (${String(items.length)})`;}
};

const bootstrapWorkspaceBinding = async (tabToken: string) => {
    const search = new URL(location.href).searchParams;
    const requestedWorkspaceId = (search.get('workspaceId') ?? '').trim();
    let workspaceId = requestedWorkspaceId || undefined;
    if (!workspaceId) {
        const listed = await sendAction('workspace.list', {
            source: 'start_extension',
            at: Date.now(),
        });
        const listedWorkspaceId = listed?.ok ? String(listed?.data?.activeWorkspaceId || '') : '';
        workspaceId = listedWorkspaceId || undefined;
    }
    if (!workspaceId) {
        throw new Error('workspace binding missing');
    }
    const opened = await sendAction(
        'tab.opened',
        {
            source: 'start_extension',
            url: location.href,
            title: document.title,
            at: Date.now(),
            ...(workspaceId ? { workspaceId } : {}),
        },
        workspaceId ? { tabToken, workspaceId } : { tabToken },
    );
    if (!opened?.ok) {
        throw new Error(opened?.error?.message || 'tab.opened bootstrap failed');
    }
};

void (async () => {
    try {
        const token = await ensureTabTokenFromAgent();
        await bootstrapWorkspaceBinding(token);
        if (tokenEl) {tokenEl.textContent = `${token.slice(0, 8)}...`;}
        if (urlEl) {urlEl.textContent = location.href;}
        setStatus('connected', true);
    } catch (error) {
        setStatus('offline');
        log('token.init.failed', { message: error instanceof Error ? error.message : String(error) });
        throw error;
    }
})();
refreshRestoreBtn?.addEventListener('click', () => {
    void refreshRestoreList();
});
void refreshRestoreList();
