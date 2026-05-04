const TAB_TOKEN_KEY = '__rpa_tab_token';
const TAB_TOKEN_WIN_NAME_PREFIX = '__RPA_TAB_TOKEN__:';
const WS_URL = 'ws://127.0.0.1:17333';
const MSG_ENSURE_BOUND_TOKEN = 'RPA_ENSURE_BOUND_TOKEN';

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
    type?: string;
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
    workspaceName?: string;
    tabName?: string;
};

type WorkflowRunData = {
    ok?: boolean;
    output?: unknown;
};

type BoundTokenData = {
    ok: boolean;
    tabName?: string;
    workspaceName?: string;
    error?: string;
};
type BoundScope = { tabName: string; workspaceName: string };

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

const parseWsReply = <TData = unknown>(value: unknown): ActionResult<TData> => {
    if (!isRecord(value)) {
        return { ok: false, error: { message: 'invalid action reply' } };
    }
    const type = asString(value.type) || '';
    const payload = value.payload;
    if (type.endsWith('.result')) {
        return { ok: true, data: payload as TData };
    }
    if (type.endsWith('.failed')) {
        const errorPayload = isRecord(payload) ? payload : {};
        return {
            ok: false,
            error: {
                message: asString(errorPayload.message) || 'action failed',
            },
        };
    }
    return parseActionResult<TData>(payload);
};

const setStatus = (text: string, ok = false) => {
    if (wsStatusEl) {
        wsStatusEl.textContent = text;
        wsStatusEl.classList.toggle('ok', ok);
    }
};

const applyTabName = (tabName: string) => {
    sessionStorage.setItem(TAB_TOKEN_KEY, tabName);
    window.name = `${TAB_TOKEN_WIN_NAME_PREFIX}${tabName}`;
    window.__rpa_tab_token = tabName;
    window.__TAB_TOKEN__ = tabName;
};

const ensureBoundToken = async (): Promise<BoundScope> => {
    let currentToken = sessionStorage.getItem(TAB_TOKEN_KEY) ?? '';
    const reply = await new Promise<BoundTokenData>((resolve) => {
        chrome.runtime.sendMessage(
            {
                type: MSG_ENSURE_BOUND_TOKEN,
                source: 'start_extension',
                tabName: currentToken,
                url: location.href,
                title: document.title,
                at: Date.now(),
            },
            (response: unknown) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }
                resolve((response ?? { ok: false }) as BoundTokenData);
            },
        );
    });
    if (!reply.ok || !reply.tabName || !reply.workspaceName) {
        throw new Error(reply.error ?? 'bound tab reference unavailable');
    }
    currentToken = reply.tabName;
    applyTabName(currentToken);
    return {
        tabName: reply.tabName,
        workspaceName: reply.workspaceName,
        ...(reply.tabName ? { tabName: reply.tabName } : {}),
    };
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
            const parsedPayload = parseWsReply<TData>(message);
            log('action.reply', { type, requestId, ok: parsedPayload.ok, payload: parsedPayload });
            done(parsedPayload);
        });
        ws.addEventListener('error', () => {
            clearTimeout(timeout);
            log('action.ws.error', { type, requestId });
            done({ ok: false, error: { message: 'ws action error' } });
        });
    });

const formatTs = (ts: number) => new Date(ts).toLocaleString();

const runWorkflowAction = async (scene: string, type: string, label: string, scope?: Record<string, unknown>) => {
    if (restoreStatusEl) {
        restoreStatusEl.textContent = `${label}...`;
    }
    const result = await sendAction<WorkflowRunData>(type, { scene }, scope);
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

const renderWorkflowList = (items: WorkflowListItem[], scope?: Record<string, unknown>) => {
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
            const opened = await sendAction<WorkflowOpenData>('workflow.open', { scene: item.scene }, scope);
            if (!opened.ok) {
                if (restoreStatusEl) {
                    restoreStatusEl.textContent = `open failed: ${opened.error?.message ?? 'unknown'}`;
                }
                return;
            }
            const workspaceName = opened.data?.workspaceName;
            const tabName = opened.data?.tabName;
            if (!workspaceName) {
                if (restoreStatusEl) {
                    restoreStatusEl.textContent = 'open failed: invalid workflow.open response';
                }
                return;
            }
            if (restoreStatusEl) {
                restoreStatusEl.textContent = `open done: ${workspaceName}`;
            }
        });

        const runBtn = document.createElement('button');
        runBtn.textContent = '运行';
        runBtn.addEventListener('click', async () => {
            await runWorkflowAction(item.scene, 'workflow.releaseRun', 'run', scope);
        });

        const testBtn = document.createElement('button');
        testBtn.textContent = '测试 DSL';
        testBtn.addEventListener('click', async () => {
            await runWorkflowAction(item.scene, 'workflow.dsl.test', 'dsl test', scope);
        });

        const saveRecordBtn = document.createElement('button');
        saveRecordBtn.textContent = '保存录制';
        saveRecordBtn.addEventListener('click', async () => {
            await runWorkflowAction(item.scene, 'workflow.record.save', 'record save', scope);
        });

        actions.append(openBtn, runBtn, testBtn, saveRecordBtn);
        row.append(meta, actions);
        restoreListEl.appendChild(row);
    });
};

const refreshWorkflowList = async (scope?: Record<string, unknown>) => {
    if (restoreStatusEl) {restoreStatusEl.textContent = 'loading...';}
    const result = await sendAction<WorkflowListData>('workflow.list', {}, scope);
    if (!result.ok) {
        if (restoreStatusEl) {
            const errorMessage = result.error?.message ?? 'unknown';
            restoreStatusEl.textContent = `load failed: ${errorMessage}`;
        }
        renderWorkflowList([]);
        return;
    }
    const workflows = Array.isArray(result.data?.workflows) ? result.data?.workflows : [];
    renderWorkflowList(workflows || [], scope);
    if (restoreStatusEl) {restoreStatusEl.textContent = `ready (${String((workflows || []).length)})`;}
};

void (async () => {
    try {
        const bound = await ensureBoundToken();
        if (tokenEl) {tokenEl.textContent = `${bound.tabName.slice(0, 8)}...`;}
        if (urlEl) {urlEl.textContent = location.href;}
        setStatus('connected', true);
        await refreshWorkflowList({
            tabName: bound.tabName,
            workspaceName: bound.workspaceName,
            ...(bound.tabName ? { tabName: bound.tabName } : {}),
        });
    } catch (error) {
        setStatus('offline');
        log('token.init.failed', { message: error instanceof Error ? error.message : String(error) });
        throw error;
    }
})();
refreshRestoreBtn?.addEventListener('click', () => {
    void (async () => {
        const bound = await ensureBoundToken();
        await refreshWorkflowList({
            tabName: bound.tabName,
            workspaceName: bound.workspaceName,
            ...(bound.tabName ? { tabName: bound.tabName } : {}),
        });
    })();
});
