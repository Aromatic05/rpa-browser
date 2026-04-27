const TAB_TOKEN_KEY = '__rpa_tab_token';
const TAB_TOKEN_WIN_NAME_PREFIX = '__RPA_TAB_TOKEN__:';
const WS_URL = 'ws://127.0.0.1:17333';

const wsStatusEl = document.getElementById('wsStatus');
const tokenEl = document.getElementById('token');
const urlEl = document.getElementById('url');
const restoreStatusEl = document.getElementById('restoreStatus');
const restoreListEl = document.getElementById('restoreList');
const refreshRestoreBtn = document.getElementById('refreshRestore');
const log = (...args: unknown[]) => { console.warn('[RPA:start]', ...args); };

declare global {
    interface Window {
        __rpa_tab_token?: string;
        __TAB_TOKEN__?: string;
    }
}

type ActionError = { message?: string };
type ActionResult<TData = unknown> = {
    ok: boolean;
    data?: TData;
    error?: ActionError;
};

type WsActionEnvelope = {
    replyTo?: string;
    payload?: unknown;
};

type RestoreItem = {
    workspaceId?: string;
    stepCount?: number;
    updatedAt?: number;
    entryUrl?: string;
};
type TabInitData = { tabToken?: string };
type WorkspaceListData = { activeWorkspaceId?: string };
type RecordListData = { recordings?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const parseActionResult = <TData = unknown>(value: unknown): ActionResult<TData> => {
    if (!isRecord(value)) {
        return { ok: false, error: { message: 'invalid payload' } };
    }
    const ok = value.ok === true;
    const errorRaw = value.error;
    const error = isRecord(errorRaw) ? { message: asString(errorRaw.message) } : undefined;
    const data = (value.data as TData | undefined);
    return { ok, data, error };
};

const setStatus = (text: string, ok = false) => {
    if (wsStatusEl) {
        wsStatusEl.textContent = text;
        wsStatusEl.classList.toggle('ok', ok);
    }
};

const ensureTabToken = () => {
    return sessionStorage.getItem(TAB_TOKEN_KEY) ?? '';
};

const sendAction = async <TData = unknown>(type: string, payload: Record<string, unknown> = {}, scope?: Record<string, unknown>) =>
    await new Promise<ActionResult<TData>>((resolve) => {
        let settled = false;
        let ws: WebSocket | null = null;
        const requestId = crypto.randomUUID();
        const done = (result: ActionResult<TData>) => {
            if (settled) {return;}
            settled = true;
            ws?.close();
            resolve(result);
        };
        const timeout = setTimeout(() => {
            log('action.timeout', { type, requestId, payload, scope: scope ?? {} });
            done({ ok: false, error: { message: 'ws action timeout' } });
        }, 5000);
        ws = new WebSocket(WS_URL);
        log('action.ws.connecting', { type, requestId, payload, scope: scope ?? {} });
        ws.addEventListener('open', () => {
            log('action.ws.open', { type, requestId });
            ws.send(
                JSON.stringify({
                    v: 1,
                    id: requestId,
                    type,
                    payload,
                    scope: scope ?? {},
                }),
            );
            log('action.sent', { type, requestId });
        });
        ws.addEventListener('message', (event) => {
            const raw = typeof event.data === 'string' ? event.data : '{}';
            const parsed = JSON.parse(raw) as unknown;
            if (!isRecord(parsed)) {return;}
            const message = parsed as WsActionEnvelope;
            if (message.replyTo !== requestId) {return;}
            clearTimeout(timeout);
            const parsedPayload = parseActionResult<TData>(message.payload);
            log('action.reply', { type, requestId, ok: parsedPayload.ok, payload: parsedPayload });
            done(parsedPayload);
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
        const initialized = await sendAction<TabInitData>('tab.init', {
            source: 'start_extension',
            url: location.href,
            at: Date.now(),
        });
        const initializedToken = asString(initialized.data?.tabToken);
        if (!initialized.ok || !initializedToken) {
            throw new Error(initialized.error?.message ?? 'tab token init failed');
        }
        token = initializedToken;
        sessionStorage.setItem(TAB_TOKEN_KEY, token);
    }
    window.name = `${TAB_TOKEN_WIN_NAME_PREFIX}${token}`;
    window.__rpa_tab_token = token;
    window.__TAB_TOKEN__ = token;
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
                if (!restored.ok) {
                    if (restoreStatusEl) {
                        const errorMessage = restored.error?.message ?? 'unknown';
                        restoreStatusEl.textContent = `restore failed: ${errorMessage}`;
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
    const result = await sendAction<RecordListData>('record.list');
    if (!result.ok) {
        if (restoreStatusEl) {
            const errorMessage = result.error?.message ?? 'unknown';
            restoreStatusEl.textContent = `load failed: ${errorMessage}`;
        }
        renderRestoreList([]);
        return;
    }
    const recordings = result.data?.recordings;
    const items = Array.isArray(recordings) ? (recordings as RestoreItem[]) : [];
    renderRestoreList(items);
    if (restoreStatusEl) {restoreStatusEl.textContent = `ready (${String(items.length)})`;}
};

const bootstrapWorkspaceBinding = async (tabToken: string) => {
    const search = new URL(location.href).searchParams;
    const requestedWorkspaceId = (search.get('workspaceId') ?? '').trim();
    let workspaceId = requestedWorkspaceId || undefined;
    if (!workspaceId) {
        const listed = await sendAction<WorkspaceListData>('workspace.list', {
            source: 'start_extension',
            at: Date.now(),
        });
        const listedWorkspaceId = listed.ok ? asString(listed.data?.activeWorkspaceId) ?? '' : '';
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
    if (!opened.ok) {
        throw new Error(opened.error?.message ?? 'tab.opened bootstrap failed');
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
