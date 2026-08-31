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
const modelSetupEl = document.getElementById('modelSetup');
const modelProviderEl = document.getElementById('modelProvider') as HTMLInputElement | null;
const modelNameEl = document.getElementById('modelName') as HTMLInputElement | null;
const modelBaseUrlEl = document.getElementById('modelBaseUrl') as HTMLInputElement | null;
const modelApiKeyEl = document.getElementById('modelApiKey') as HTMLInputElement | null;
const modelSetupStatusEl = document.getElementById('modelSetupStatus');
const saveModelSetupBtn = document.getElementById('saveModelSetup') as HTMLButtonElement | null;
const modelSettingsBtn = document.getElementById('modelSettingsBtn') as HTMLButtonElement | null;
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

type AutomationItem = {
    name: string;
    description?: string;
    status?: 'ready' | 'needs_review' | 'broken' | 'unknown';
};

type ProductLibrarySummary = {
    automations?: AutomationItem[];
};

type AutomationRunData = {
    ok?: boolean;
    output?: unknown;
};
type ModelSetupStatus = {
    configured?: boolean;
    credentialConfigured?: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
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
let boundScope: BoundScope | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const payloadForLog = (type: string, payload: Record<string, unknown>): Record<string, unknown> => {
    if (type !== 'agent.product' || payload.verb !== 'configureModel' || !Object.hasOwn(payload, 'apiKey')) {
        return payload;
    }
    return {...payload, apiKey: '[redacted]'};
};
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

const offlineCopy = 'Agent service is offline. Start RPA Browser, then retry.';

const applyOfflineState = (message: string): void => {
    boundScope = null;
    window.__rpa_start_error = message;
    setStatus('Offline');
    if (modelSetupEl) {modelSetupEl.hidden = true;}
    if (modelSetupStatusEl) {modelSetupStatusEl.textContent = offlineCopy;}
    if (restoreStatusEl) {restoreStatusEl.textContent = offlineCopy;}
    renderAutomationList([]);
    if (refreshRestoreBtn) {refreshRestoreBtn.textContent = 'Retry';}
    if (modelSettingsBtn) {modelSettingsBtn.disabled = true;}
    if (saveModelSetupBtn) {saveModelSetupBtn.disabled = true;}
};

const applyConnectedState = (): void => {
    window.__rpa_start_error = undefined;
    setStatus('Connected', true);
    if (refreshRestoreBtn) {refreshRestoreBtn.textContent = 'Refresh';}
    if (modelSettingsBtn) {modelSettingsBtn.disabled = false;}
    if (saveModelSetupBtn) {saveModelSetupBtn.disabled = false;}
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
    const result = await sendAction('tab.ping', {
        tabName: scope.tabName,
        source: 'extension.newtab',
        url: location.href,
        title: document.title,
        at: Date.now(),
    }, {sessionWorkspace: true});
    if (!result.ok) {
        throw new Error(result.error?.message ?? 'Agent heartbeat failed');
    }
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
            log('action.timeout', { type, requestId, payload: payloadForLog(type, payload), scope });
            done({ ok: false, error: { message: 'ws action timeout' } });
        }, 5000);
        readSessionConfig()
            .then((sessionConfig) => {
                ws = new WebSocket(`ws://127.0.0.1:${String(sessionConfig.wsPort)}`);
                log('action.ws.connecting', { type, requestId, payload: payloadForLog(type, payload) });
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

const applyModelStatus = (status: ModelSetupStatus, showConfigured = false): boolean => {
    const configured = status.configured === true;
    if (modelProviderEl && status.provider) {modelProviderEl.value = status.provider;}
    if (modelNameEl && status.model) {modelNameEl.value = status.model;}
    if (modelBaseUrlEl && status.baseUrl) {modelBaseUrlEl.value = status.baseUrl;}
    if (modelApiKeyEl) {
        modelApiKeyEl.value = '';
        modelApiKeyEl.placeholder = status.credentialConfigured === true
            ? 'Leave blank to keep the current key'
            : 'Required for first setup';
    }
    if (modelSetupEl) {modelSetupEl.hidden = configured && !showConfigured;}
    if (modelSetupStatusEl) {
        modelSetupStatusEl.textContent = configured
            ? 'Model is ready. Save only if you want to change these settings.'
            : 'Model setup is required before starting agent tasks.';
    }
    return configured;
};

const refreshModelStatus = async (scope: BoundScope, showConfigured = false): Promise<boolean> => {
    const result = await sendAction<ModelSetupStatus>(
        'agent.product',
        {verb: 'modelStatus'},
        {workspaceName: scope.workspaceName},
    );
    if (!result.ok || !result.data) {
        if (modelSetupEl) {modelSetupEl.hidden = false;}
        if (modelSetupStatusEl) {
            modelSetupStatusEl.textContent = `Could not read model setup: ${result.error?.message ?? 'unknown error'}`;
        }
        return false;
    }
    return applyModelStatus(result.data, showConfigured);
};

const saveModelSetup = async (): Promise<void> => {
    const scope = boundScope;
    if (!scope || !modelProviderEl || !modelNameEl || !modelBaseUrlEl || !modelApiKeyEl) {return;}
    const provider = modelProviderEl.value.trim();
    const model = modelNameEl.value.trim();
    const baseUrl = modelBaseUrlEl.value.trim();
    if (!provider || !model || !baseUrl) {
        if (modelSetupStatusEl) {modelSetupStatusEl.textContent = 'Provider, model, and base URL are required.';}
        return;
    }
    if (saveModelSetupBtn) {saveModelSetupBtn.disabled = true;}
    if (modelSetupStatusEl) {modelSetupStatusEl.textContent = 'Saving setup…';}
    try {
        const result = await sendAction<ModelSetupStatus>(
            'agent.product',
            {
                verb: 'configureModel',
                provider,
                model,
                baseUrl,
                ...(modelApiKeyEl.value.length > 0 ? {apiKey: modelApiKeyEl.value} : {}),
            },
            {workspaceName: scope.workspaceName},
        );
        if (!result.ok || !result.data) {
            if (modelSetupStatusEl) {modelSetupStatusEl.textContent = `Setup failed: ${result.error?.message ?? 'unknown error'}`;}
            return;
        }
        applyModelStatus(result.data, false);
    } finally {
        if (saveModelSetupBtn) {saveModelSetupBtn.disabled = false;}
    }
};

const runAutomation = async (automationName: string) => {
    if (restoreStatusEl) {
        restoreStatusEl.textContent = `Running ${automationName}…`;
    }
    const result = await sendAction<AutomationRunData>(
        'dsl.run',
        {dslName: automationName},
        {sessionWorkspace: true},
    );
    if (!result.ok) {
        if (restoreStatusEl) {
            restoreStatusEl.textContent = `Run failed: ${result.error?.message ?? 'unknown error'}`;
        }
        return;
    }
    if (restoreStatusEl) {
        restoreStatusEl.textContent = `${automationName} completed`;
    }
};

const statusLabel = (status: AutomationItem['status']): string => {
    if (status === 'ready') {return 'Ready to run';}
    if (status === 'needs_review') {return 'Needs review';}
    if (status === 'broken') {return 'Broken dependency';}
    return 'Not checked yet';
};

const renderAutomationList = (items: AutomationItem[]) => {
    if (!restoreListEl) {return;}
    restoreListEl.innerHTML = '';
    const automations = [...items].sort((left, right) => left.name.localeCompare(right.name));
    if (!automations.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No saved automations yet.';
        restoreListEl.appendChild(empty);
        return;
    }
    automations.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'restore-item';

        const meta = document.createElement('div');
        meta.className = 'restore-meta';
        const title = document.createElement('strong');
        title.textContent = item.name;
        const entry = document.createElement('div');
        if (item.status === 'ready') {entry.className = 'state-ready';}
        entry.textContent = statusLabel(item.status);
        meta.append(title);
        if (item.description && item.description !== item.name) {
            const description = document.createElement('div');
            description.textContent = item.description;
            meta.append(description);
        }
        meta.append(entry);

        const actions = document.createElement('div');
        actions.className = 'row';

        const runBtn = document.createElement('button');
        runBtn.className = 'primary';
        runBtn.textContent = 'Run';
        runBtn.disabled = item.status === 'broken';
        runBtn.addEventListener('click', () => {
            void runAutomation(item.name);
        });
        actions.append(runBtn);
        row.append(meta, actions);
        restoreListEl.appendChild(row);
    });
};

const refreshAutomationList = async () => {
    if (restoreStatusEl) {restoreStatusEl.textContent = 'Loading…';}
    const result = await sendAction<ProductLibrarySummary>(
        'agent.product',
        {verb: 'librarySummary'},
        {sessionWorkspace: true},
    );
    if (!result.ok) {
        if (restoreStatusEl) {
            const errorMessage = result.error?.message ?? 'unknown';
            restoreStatusEl.textContent = `Load failed: ${errorMessage}`;
        }
        renderAutomationList([]);
        return;
    }
    const automations = result.data && Array.isArray(result.data.automations) ? result.data.automations : [];
    renderAutomationList(automations);
    if (restoreStatusEl) {restoreStatusEl.textContent = `${String(automations.length)} saved`;}
};

const connectAndRefresh = async (): Promise<BoundScope | null> => {
    setStatus('Connecting…');
    try {
        const bound = await ensureBoundToken();
        boundScope = bound;
        applyConnectedState();
        await refreshModelStatus(bound);
        await refreshAutomationList();
        return bound;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        applyOfflineState(message);
        log('connection.failed', {message});
        return null;
    }
};

void (async () => {
    await connectAndRefresh();
    setInterval(() => {
        void (async () => {
            if (!boundScope) {
                await connectAndRefresh();
                return;
            }
            try {
                await sendHeartbeat(boundScope);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                applyOfflineState(message);
                log('heartbeat.failed', {message});
            }
        })();
    }, 15_000);
})();
refreshRestoreBtn?.addEventListener('click', () => {
    void connectAndRefresh();
});
modelSettingsBtn?.addEventListener('click', () => {
    void (async () => {
        const bound = boundScope ?? await connectAndRefresh();
        if (!bound) {return;}
        await refreshModelStatus(bound, true);
        modelSetupEl?.scrollIntoView({behavior: 'smooth', block: 'start'});
    })();
});
saveModelSetupBtn?.addEventListener('click', () => {void saveModelSetup();});
