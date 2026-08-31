export {};

const TAB_TOKEN_KEY = '__rpa_tab_token';
const TAB_NAME_KEY = '__rpa_tab_name';
const TAB_NAME_CONFIRMED_KEY = '__rpa_tab_name_confirmed';
const TAB_NAME_WIN_NAME_PREFIX = '__RPA_TAB_NAME__:';

const wsStatusEl = document.getElementById('wsStatus');
const connectionPillEl = document.getElementById('connectionPill');
const restoreStatusEl = document.getElementById('restoreStatus');
const restoreListEl = document.getElementById('restoreList');
const refreshRestoreBtn = document.getElementById('refreshRestore');
const log = (...args: unknown[]) => { console.warn('[RPA:newtab]', ...args); };

declare global {
    interface Window {
        __rpa_tab_token?: string;
        __rpa_tab_name?: string;
        __TAB_TOKEN__?: string;
        __rpa_start_error?: string;
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
    workflowName: string;
    entryDslName?: string | null;
    runnable?: boolean;
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
type ActionScope = {
    sessionWorkspace?: boolean;
    workspaceName?: string;
};

type BoundTokenData = {
    tabName?: string;
    workspaceName?: string;
    stale?: boolean;
};
type RuntimeTabListData = {
    workspaceName?: string;
    tabs?: Array<{
        tabName?: string;
        url?: string;
        active?: boolean;
    }>;
};
type BoundScope = { tabName: string; workspaceName: string };
type SessionConfig = { workspaceName: string; wsPort: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const readSessionConfigFromUrl = (): SessionConfig | null => {
    const params = new URLSearchParams(location.search);
    const workspaceName = (params.get('rpaWorkspaceName') ?? '').trim();
    const wsPort = Number(params.get('rpaWsPort') ?? '');
    if (!workspaceName || !Number.isInteger(wsPort) || wsPort <= 0) {return null;}
    return { workspaceName, wsPort };
};
const persistSessionConfig = async (config: SessionConfig | null) => {
    if (!config) {return;}
    await chrome.storage.local.set({
        rpaWorkspaceName: config.workspaceName,
        rpaWsPort: config.wsPort,
    });
};
const readSessionConfig = async (): Promise<SessionConfig> => {
    const fromUrl = readSessionConfigFromUrl();
    await persistSessionConfig(fromUrl);
    const values = await chrome.storage.local.get(['rpaWorkspaceName', 'rpaWsPort']);
    const workspaceName = typeof values.rpaWorkspaceName === 'string' ? values.rpaWorkspaceName.trim() : '';
    const rawWsPort = values.rpaWsPort as unknown;
    const wsPort = typeof rawWsPort === 'number' ? rawWsPort : typeof rawWsPort === 'string' ? Number(rawWsPort) : NaN;
    if (!workspaceName || !Number.isInteger(wsPort) || wsPort <= 0) {
        throw new Error('session config unavailable');
    }
    return { workspaceName, wsPort };
};
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
    const type = asString(value.type) ?? '';
    const payload = value.payload;
    if (type.endsWith('.result')) {
        return { ok: true, data: payload as TData };
    }
    if (type.endsWith('.failed')) {
        const errorPayload = isRecord(payload) ? payload : {};
        return {
            ok: false,
            error: {
                message: asString(errorPayload.message) ?? 'action failed',
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
    connectionPillEl?.classList.toggle('ok', ok);
};

const applyTabName = (tabName: string) => {
    sessionStorage.setItem(TAB_TOKEN_KEY, tabName);
    sessionStorage.setItem(TAB_NAME_KEY, tabName);
    sessionStorage.setItem(TAB_NAME_CONFIRMED_KEY, '1');
    window.name = `${TAB_NAME_WIN_NAME_PREFIX}${tabName}`;
    window.__rpa_tab_token = tabName;
    window.__TAB_TOKEN__ = tabName;
    window.__rpa_tab_name = tabName;
};

const resolvePublishedTabName = async (): Promise<string> => {
    const deadline = Date.now() + 5000;
    let lastError = 'workspace tab is not published yet';
    while (Date.now() < deadline) {
        const listed = await sendAction<RuntimeTabListData>('tab.list', {}, {sessionWorkspace: true});
        if (listed.ok) {
            const tabs = Array.isArray(listed.data?.tabs) ? listed.data.tabs : [];
            const candidate = tabs.find((tab) => tab.active === true)
                ?? tabs.find((tab) => {
                    const url = tab.url ?? '';
                    return url.startsWith('chrome://newtab') || url.includes('/newtab.html');
                })
                ?? (tabs.length === 1 ? tabs[0] : undefined);
            const tabName = candidate?.tabName?.trim() ?? '';
            if (tabName) {return tabName;}
            lastError = `no unique active start tab in workspace (${String(tabs.length)} tabs)`;
        } else {
            lastError = listed.error?.message ?? 'tab.list failed';
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(lastError);
};

const ensureBoundToken = async (): Promise<BoundScope> => {
    const sessionConfig = await readSessionConfig();
    const currentToken = sessionStorage.getItem(TAB_TOKEN_KEY) ?? '';
    if (currentToken) {
        const reported = await sendAction<BoundTokenData>('tab.report', {
            tabName: currentToken,
            source: 'extension.newtab',
            url: location.href,
            title: document.title,
            at: Date.now(),
        }, {sessionWorkspace: true});
        if (reported.ok && reported.data?.stale !== true) {
            applyTabName(currentToken);
            return {tabName: currentToken, workspaceName: sessionConfig.workspaceName};
        }
    }

    const tabName = await resolvePublishedTabName();
    const reported = await sendAction<BoundTokenData>('tab.report', {
        tabName,
        source: 'extension.newtab',
        url: location.href,
        title: document.title,
        at: Date.now(),
    }, {sessionWorkspace: true});
    if (!reported.ok || reported.data?.stale === true) {
        throw new Error(reported.error?.message ?? 'published tab reference is stale');
    }
    applyTabName(tabName);
    return {
        tabName,
        workspaceName: reported.data?.workspaceName ?? sessionConfig.workspaceName,
    };
};

const sendHeartbeat = async (scope: BoundScope): Promise<void> => {
    await sendAction('tab.ping', {
        tabName: scope.tabName,
        source: 'extension.newtab',
        url: location.href,
        title: document.title,
        at: Date.now(),
    }, {sessionWorkspace: true});
};

const sendAction = async <TData = unknown>(
    type: string,
    payload: Record<string, unknown> = {},
    scope: ActionScope = {},
) =>
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
            log('action.timeout', { type, requestId, payload, scope });
            done({ ok: false, error: { message: 'ws action timeout' } });
        }, 5000);
        readSessionConfig()
            .then((sessionConfig) => {
                ws = new WebSocket(`ws://127.0.0.1:${String(sessionConfig.wsPort)}`);
                log('action.ws.connecting', { type, requestId, payload });
                ws.addEventListener('open', () => {
                    log('action.ws.open', { type, requestId });
                    ws?.send(
                        JSON.stringify({
                            v: 1,
                            id: requestId,
                            type,
                            payload,
                            workspaceName: scope.workspaceName
                                ?? (scope.sessionWorkspace ? sessionConfig.workspaceName : undefined),
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
            })
            .catch((error: unknown) => {
                clearTimeout(timeout);
                done({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
            });
    });

const runWorkflow = async (workflowName: string) => {
    if (restoreStatusEl) {
        restoreStatusEl.textContent = `Running ${workflowName}…`;
    }
    const opened = await sendAction<WorkflowOpenData>('workflow.open', {workflowName});
    const workspaceName = opened.data?.workspaceName;
    if (!opened.ok || !workspaceName) {
        if (restoreStatusEl) {
            restoreStatusEl.textContent = `Could not run: ${opened.error?.message ?? 'failed to load automation'}`;
        }
        return;
    }
    const result = await sendAction<WorkflowRunData>('dsl.run', {}, {workspaceName});
    if (!result.ok) {
        if (restoreStatusEl) {
            restoreStatusEl.textContent = `Run failed: ${result.error?.message ?? 'unknown error'}`;
        }
        return;
    }
    if (restoreStatusEl) {
        restoreStatusEl.textContent = `${workflowName} completed`;
    }
};

const renderWorkflowList = (items: WorkflowListItem[]) => {
    if (!restoreListEl) {return;}
    restoreListEl.innerHTML = '';
    const runnableItems = items
        .filter((item) => item.runnable === true)
        .sort((left, right) => left.workflowName.localeCompare(right.workflowName));
    if (!runnableItems.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No runnable automations yet.';
        restoreListEl.appendChild(empty);
        return;
    }
    runnableItems.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'restore-item';

        const meta = document.createElement('div');
        meta.className = 'restore-meta';
        const title = document.createElement('strong');
        title.textContent = item.workflowName;
        const entry = document.createElement('div');
        entry.className = 'state-ready';
        entry.textContent = 'Ready to run';
        meta.append(title, entry);

        const actions = document.createElement('div');
        actions.className = 'row';

        const runBtn = document.createElement('button');
        runBtn.className = 'primary';
        runBtn.textContent = 'Run';
        runBtn.addEventListener('click', () => {
            void runWorkflow(item.workflowName);
        });
        actions.append(runBtn);
        row.append(meta, actions);
        restoreListEl.appendChild(row);
    });
};

const refreshWorkflowList = async () => {
    if (restoreStatusEl) {restoreStatusEl.textContent = 'Loading…';}
    const result = await sendAction<WorkflowListData>('workflow.list');
    if (!result.ok) {
        if (restoreStatusEl) {
            const errorMessage = result.error?.message ?? 'unknown';
            restoreStatusEl.textContent = `Load failed: ${errorMessage}`;
        }
        renderWorkflowList([]);
        return;
    }
    const workflows = result.data && Array.isArray(result.data.workflows) ? result.data.workflows : [];
    renderWorkflowList(workflows);
    const runnableCount = workflows.filter((item) => item.runnable === true).length;
    if (restoreStatusEl) {restoreStatusEl.textContent = `${String(runnableCount)} ready`;}
};

void (async () => {
    try {
        const bound = await ensureBoundToken();
        setStatus('Connected', true);
        await refreshWorkflowList();
        setInterval(() => {
            void sendHeartbeat(bound);
        }, 15_000);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.__rpa_start_error = message;
        setStatus('Offline');
        log('token.init.failed', {message});
        throw error;
    }
})();
refreshRestoreBtn?.addEventListener('click', () => {
    void (async () => {
        await ensureBoundToken();
        await refreshWorkflowList();
    })();
});
