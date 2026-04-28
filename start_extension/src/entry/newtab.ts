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

type WorkflowListItem = {
    scene: string;
    id: string;
    name?: string;
    entryDsl: string;
    entryInputs?: string;
    recordCount: number;
    checkpointCount: number;
};

type WorkflowListData = {
    workflows?: WorkflowListItem[];
};

type WorkflowOpenData = {
    workspaceId?: string;
    tabId?: string;
    tabToken?: string;
};

type WorkflowRunData = {
    ok?: boolean;
    output?: unknown;
};

type TabInitData = { tabToken?: string };

type WorkspaceListData = { activeWorkspaceId?: string };

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

const applyTabToken = (tabToken: string) => {
    sessionStorage.setItem(TAB_TOKEN_KEY, tabToken);
    window.name = `${TAB_TOKEN_WIN_NAME_PREFIX}${tabToken}`;
    window.__rpa_tab_token = tabToken;
    window.__TAB_TOKEN__ = tabToken;
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
    applyTabToken(token);
    log('token.ensure', { token, url: location.href });
    return token;
};

const formatTs = (ts: number) => new Date(ts).toLocaleString();

const runWorkflowAction = async (scene: string, type: string, label: string) => {
    if (restoreStatusEl) {
        restoreStatusEl.textContent = `${label}...`;
    }
    const result = await sendAction<WorkflowRunData>(type, { scene });
    if (!result.ok) {
        if (restoreStatusEl) {
            restoreStatusEl.textContent = `${label} failed: ${result.error?.message ?? 'unknown'}`;
        }
        return;
    }
    if (restoreStatusEl) {
        restoreStatusEl.textContent = `${label} done`;
    }
};

const renderWorkflowList = (items: WorkflowListItem[]) => {
    if (!restoreListEl) {return;}
    restoreListEl.innerHTML = '';
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'restore-meta';
        empty.textContent = '当前没有可用 workflow。';
        restoreListEl.appendChild(empty);
        return;
    }
    items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'restore-item';

        const meta = document.createElement('div');
        meta.className = 'restore-meta';
        meta.innerHTML = [
            `<div><strong>${item.scene}</strong> ${item.name ? `(${item.name})` : ''}</div>`,
            `<div>id: ${item.id} | records: ${String(item.recordCount)} | checkpoints: ${String(item.checkpointCount)}</div>`,
            `<div>entry: ${item.entryDsl}${item.entryInputs ? ` | inputs: ${item.entryInputs}` : ''}</div>`,
            `<div>updated: ${formatTs(Date.now())}</div>`,
        ].join('');

        const actions = document.createElement('div');
        actions.className = 'row';

        const openBtn = document.createElement('button');
        openBtn.className = 'primary';
        openBtn.textContent = '打开 workflow';
        openBtn.addEventListener('click', async () => {
            const opened = await sendAction<WorkflowOpenData>('workflow.open', { scene: item.scene });
            if (!opened.ok) {
                if (restoreStatusEl) {
                    restoreStatusEl.textContent = `open failed: ${opened.error?.message ?? 'unknown'}`;
                }
                return;
            }
            const workspaceId = opened.data?.workspaceId;
            const tabId = opened.data?.tabId;
            const tabToken = opened.data?.tabToken;
            if (!workspaceId || !tabToken) {
                if (restoreStatusEl) {
                    restoreStatusEl.textContent = 'open failed: invalid workflow.open response';
                }
                return;
            }
            const rebound = await sendAction(
                'tab.opened',
                {
                    source: 'start_extension',
                    url: location.href,
                    title: document.title,
                    at: Date.now(),
                    workspaceId,
                    ...(tabId ? { tabId } : {}),
                },
                {
                    tabToken,
                    workspaceId,
                },
            );
            if (!rebound.ok) {
                if (restoreStatusEl) {
                    restoreStatusEl.textContent = `open failed: ${rebound.error?.message ?? 'tab.opened failed'}`;
                }
                return;
            }
            applyTabToken(tabToken);
            if (restoreStatusEl) {
                restoreStatusEl.textContent = `open done: ${workspaceId}`;
            }
        });

        const runBtn = document.createElement('button');
        runBtn.textContent = '运行';
        runBtn.addEventListener('click', async () => {
            await runWorkflowAction(item.scene, 'workflow.releaseRun', 'run');
        });

        const testBtn = document.createElement('button');
        testBtn.textContent = '测试 DSL';
        testBtn.addEventListener('click', async () => {
            await runWorkflowAction(item.scene, 'workflow.dsl.test', 'dsl test');
        });

        const saveRecordBtn = document.createElement('button');
        saveRecordBtn.textContent = '保存录制';
        saveRecordBtn.addEventListener('click', async () => {
            await runWorkflowAction(item.scene, 'workflow.record.save', 'record save');
        });

        actions.append(openBtn, runBtn, testBtn, saveRecordBtn);
        row.append(meta, actions);
        restoreListEl.appendChild(row);
    });
};

const refreshWorkflowList = async () => {
    if (restoreStatusEl) {restoreStatusEl.textContent = 'loading...';}
    const result = await sendAction<WorkflowListData>('workflow.list');
    if (!result.ok) {
        if (restoreStatusEl) {
            const errorMessage = result.error?.message ?? 'unknown';
            restoreStatusEl.textContent = `load failed: ${errorMessage}`;
        }
        renderWorkflowList([]);
        return;
    }
    const workflows = Array.isArray(result.data?.workflows) ? result.data?.workflows : [];
    renderWorkflowList(workflows || []);
    if (restoreStatusEl) {restoreStatusEl.textContent = `ready (${String((workflows || []).length)})`;}
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
    void refreshWorkflowList();
});
void refreshWorkflowList();
