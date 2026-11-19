import type { Action } from '../shared/types.js';
import { preparePanelAction, pushPanelLog, type PanelLogEntry } from './panel_actions.js';
import { updatePlaybackStatus, type PlaybackStatus } from './playback_status.js';
import {mountCheckpointRecorderUI} from './checkpoint_recorder_ui.js';
import {mountEntityRulesBrowserUI} from './entity_rules_browser_ui.js';
import type {EntityRuleSelection} from '../../../shared/entity-rules-contract/index.js';
import {
    AGENT_APPROVAL_ACTOR,
    buildAgentSessionView,
    normalizeAgentInteraction,
    normalizeAgentSession,
    normalizeAgentSessionReport,
    sanitizeForDisplay,
    type AgentInteraction,
    type AgentSessionReportViewState,
    type AgentSessionSummary,
    type AgentSessionViewStatus,
} from './agent_session_ui.js';

export type FloatingUIOptions = {
    tabName: string;
    workspaceName: string;
    onAction: (
        type: string,
        payload?: Record<string, unknown>,
        address?: { workspaceName?: string; tabName?: string },
    ) => Promise<Action>;
    onEvent?: (handler: (action: Action) => void) => void;
    onEnterAnnotation?: (profileName?: string) => void;
    onEntityRulePreview?: (selection: EntityRuleSelection | null) => Promise<boolean>;
    onCheckpointEntityRulePreview?: (selection: EntityRuleSelection | null) => Promise<boolean>;
};

export type FloatingUIHandle = {
    unmount: () => void;
    scheduleRefresh: () => void;
    onPageChanged: () => void;
    setPageWorkspace: (workspaceName: string) => void;
    setAnnotatorDebugState: (detail: string) => void;
};

type WorkspaceItem = { workspaceName: string; activeTabName?: string; tabCount: number };
type TabItem = { tabName: string; url: string; title: string; active: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

type ViewKey = 'Conn' | 'WS' | 'Tabs' | 'Rec' | 'Play' | 'Flow' | 'ER' | 'Agent' | 'Log';
const UUIDorUnsafe = (): string => {
    if (typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    const now = Date.now().toString(16).padStart(12, '0');
    return `${rand()}-${rand().slice(0, 4)}-4${rand().slice(0, 3)}-a${rand().slice(0, 3)}-${now}${rand().slice(0, 4)}`.slice(0, 36);
};

export const mountFloatingUI = (opts: FloatingUIOptions): FloatingUIHandle => {
    const ROOT_ID = 'rpa-floating-panel';
    if (document.getElementById(ROOT_ID)) {
        return {
            unmount: () => undefined,
            scheduleRefresh: () => undefined,
            onPageChanged: () => undefined,
            setPageWorkspace: () => undefined,
            setAnnotatorDebugState: () => undefined,
        };
    }
    const manifest = chrome.runtime.getManifest();
    const buildId = manifest.version_name ?? manifest.version;

    const state = {
        activeView: 'Conn' as ViewKey,
        activeWorkspaceName: opts.workspaceName,
        activeTabName: '',
        workspaces: [] as WorkspaceItem[],
        tabs: [] as TabItem[],
        workflowName: '',
        targetName: '',
        recordingName: '',
        lastReply: '' as string,
        logs: [] as PanelLogEntry[],
        playbackByWorkspace: new Map<string, PlaybackStatus>(),
        replaySource: 'unsaved' as string,
        savedRecordings: [] as Array<{ recordingName: string; stepCount: number }>,
        unsavedStepCount: 0,
        dslRaw: '{}',
        checkpointRaw: '{}',
        annotatorDebug: null as unknown,
        agentSessions: [] as AgentSessionSummary[],
        agentStatus: {kind: 'idle'} as AgentSessionViewStatus,
        agentSelectedSessionId: null as string | null,
        agentReport: null as AgentSessionReportViewState | null,
        agentPendingCancels: new Set<string>(),
        agentListInFlight: false,
        agentReportInFlight: false,
        agentInteractions: [] as AgentInteraction[],
        agentInteractionsSessionId: null as string | null,
        agentInteractionsInFlight: false,
        agentInteractionsRequestSessionId: null as string | null,
        agentInteractionsQueuedSessionId: null as string | null,
        agentInteractionError: null as {kind: 'decision' | 'list'; message: string} | null,
        agentPendingDecisions: new Set<string>(),
        agentDenyReasons: {} as Record<string, string>,
        agentInputs: {
            prompt: '',
            provider: '',
            model: '',
            executionMode: '',
        },
    };
    let pageWorkspaceName = opts.workspaceName;
    let agentSessionPollTimer: ReturnType<typeof setTimeout> | null = null;

    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.setAttribute('data-rpa-panel', 'true');
    host.setAttribute('data-rpa-snapshot-ignore', 'true');
    host.style.position = 'fixed';
    host.style.top = '16px';
    host.style.right = '16px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .wrap { pointer-events:none; display:flex; flex-direction:column; align-items:flex-end; gap:8px; font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
      .launchers { pointer-events:auto; display:flex; align-items:center; gap:8px; }
      .ball { width:44px; height:44px; border-radius:999px; border:none; background:#111827; color:#f9fafb; font-size:12px; font-weight:700; cursor:pointer; box-shadow:0 8px 20px rgba(15,23,42,.22); }
      .panel { pointer-events:auto; width:420px; border-radius:12px; background:#fff; border:1px solid #e2e8f0; box-shadow:0 12px 28px rgba(15,23,42,.24); display:none; overflow:hidden; }
      .panel.open { display:block; }
      .tabs { display:flex; border-bottom:1px solid #e2e8f0; background:#f8fafc; }
      .tabs button { border:none; border-right:1px solid #e2e8f0; border-radius:0; background:transparent; padding:8px 10px; font-size:12px; cursor:pointer; }
      .tabs button.active { background:#dbeafe; color:#1d4ed8; font-weight:700; }
      .body { padding:10px; max-height:360px; overflow:auto; }
      .row { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:6px; align-items:center; }
      .row3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-bottom:6px; align-items:center; }
      .section { margin-bottom:10px; border:1px solid #e2e8f0; border-radius:8px; padding:8px; }
      .title { font-size:11px; color:#475569; margin-bottom:6px; font-weight:700; }
      button { padding:6px 8px; font-size:12px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; cursor:pointer; }
      button.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
      input, textarea, select { width:100%; box-sizing:border-box; padding:6px 8px; font-size:12px; border-radius:8px; border:1px solid #cbd5e1; background:#fff; }
      textarea { min-height:72px; resize:vertical; }
      .hint { font-size:11px; color:#64748b; margin-bottom:6px; }
      .list { display:flex; flex-direction:column; gap:6px; }
      .footer { border-top:1px solid #e2e8f0; padding:8px; background:#0f172a; color:#e2e8f0; }
      .footer pre { margin:0; max-height:120px; overflow:auto; white-space:pre-wrap; font-size:11px; }
      .log-list { display:flex; flex-direction:column; gap:6px; }
      .log-item { font-size:11px; border:1px solid #e2e8f0; border-radius:6px; padding:6px; }
      .log-item .selectable { cursor:pointer; }
      .log-item .selectable:hover { color:#1d4ed8; }
      .agent-error { color:#b91c1c; font-weight:600; }
      button:disabled { opacity:.55; cursor:default; }
      .debug-json { margin:0; max-height:300px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; color:#0f172a; }
    `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const launchers = document.createElement('div');
    launchers.className = 'launchers';
    const ball = document.createElement('button');
    ball.className = 'ball';
    ball.textContent = 'RPA';
    const panel = document.createElement('div');
    panel.className = 'panel';
    const tabsBar = document.createElement('div');
    tabsBar.className = 'tabs';
    const body = document.createElement('div');
    body.className = 'body';
    const footer = document.createElement('div');
    footer.className = 'footer';
    const out = document.createElement('pre');
    footer.appendChild(out);

    panel.append(tabsBar, body, footer);
    launchers.append(ball);
    wrap.append(launchers, panel);
    shadow.append(style, wrap);
    document.documentElement.appendChild(host);

    let isOpen = false;
    ball.addEventListener('click', () => {
        isOpen = !isOpen;
        panel.classList.toggle('open', isOpen);
    });

    const setOutput = (value: unknown) => {
        state.lastReply = JSON.stringify(sanitizeForDisplay(value), null, 2);
        out.textContent = state.lastReply;
    };

    const logAction = (kind: PanelLogEntry['kind'], action: Action) => {
        state.logs = pushPanelLog(state.logs, { at: Date.now(), kind, action });
    };

    let checkpointRecorder: ReturnType<typeof mountCheckpointRecorderUI> | null = null;
    let entityRulesBrowser: ReturnType<typeof mountEntityRulesBrowserUI> | null = null;

    const sendPanelActionForWorkspace = async (
        type: string,
        payload: Record<string, unknown> | undefined,
        workspaceName: string | null,
    ): Promise<Action> => {
        const prepared = preparePanelAction(type, payload, workspaceName);
        if ('error' in prepared) {
            setOutput(prepared.error);
            logAction('failed', prepared.error);
            renderActiveView();
            return prepared.error;
        }
        const request: Action = {
            v: 1,
            id: UUIDorUnsafe(),
            type: prepared.type,
            ...(prepared.address?.workspaceName ? { workspaceName: prepared.address.workspaceName } : {}),
            ...(prepared.payload ? { payload: prepared.payload } : {}),
        };
        logAction('request', request);
        const reply = await opts.onAction(prepared.type, prepared.payload, prepared.address);
        logAction(reply.type.endsWith('.failed') ? 'failed' : 'reply', reply);
        setOutput(reply);
        interceptAction(reply, prepared.type, prepared.address?.workspaceName);
        renderActiveView();
        return reply;
    };

    const sendPanelAction = async (type: string, payload?: Record<string, unknown>): Promise<Action> =>
        await sendPanelActionForWorkspace(type, payload, state.activeWorkspaceName || null);

    const sendPageWorkspaceAction = async (type: string, payload?: Record<string, unknown>): Promise<Action> =>
        await sendPanelActionForWorkspace(type, payload, pageWorkspaceName);

    entityRulesBrowser = mountEntityRulesBrowserUI({
        launchers,
        surface: wrap,
        before: ball,
        pageUrl: () => location.href,
        sendAction: sendPageWorkspaceAction,
        onCreate: () => opts.onEnterAnnotation?.(),
        onEdit: (profileName) => opts.onEnterAnnotation?.(profileName),
        onPreview: async (selection) => await opts.onEntityRulePreview?.(selection) ?? false,
        onActiveChange: (active) => {
            checkpointRecorder?.setVisible(!active);
        },
    });

    checkpointRecorder = mountCheckpointRecorderUI({
        launchers,
        surface: wrap,
        before: ball,
        sendAction: sendPageWorkspaceAction,
        onActiveChange: (active) => {
            entityRulesBrowser.setVisible(!active);
        },
        onEntityRulePreview: async (selection) => {
            await opts.onCheckpointEntityRulePreview?.(selection);
        },
    });

    const refreshWorkspaces = async () => {
        await sendPanelAction('workspace.list', {});
    };
    const refreshTabs = async () => {
        await sendPanelAction('tab.list', {});
    };
    const refreshRecordings = async () => {
        await sendPanelAction('record.list', {});
    };
    const refreshAgentSessions = async () => {
        await sendPanelAction('agent.sessions.list', {});
    };
    const clearAgentPoll = () => {
        if (agentSessionPollTimer !== null) {
            clearTimeout(agentSessionPollTimer);
            agentSessionPollTimer = null;
        }
    };
    const ensureAgentPoll = () => {
        if (agentSessionPollTimer !== null) {return;}
        if (!state.agentSessions.some((session) => session.state === 'running')) {return;}
        agentSessionPollTimer = setTimeout(() => {
            agentSessionPollTimer = null;
            void refreshAgentSessions();
        }, 2500);
    };

    const refreshAgentInteractions = async (sessionId: string) => {
        if (state.agentInteractionsInFlight) {
            if (state.agentInteractionsRequestSessionId !== sessionId) {
                state.agentInteractionsQueuedSessionId = sessionId;
            }
            return;
        }
        state.agentInteractionsInFlight = true;
        state.agentInteractionsRequestSessionId = sessionId;
        state.agentInteractionsSessionId = sessionId;
        if (state.activeView === 'Agent') {renderActiveView();}
        try {
            await sendPanelAction('agent.interactions.list', {sessionId});
        } finally {
            state.agentInteractionsInFlight = false;
            state.agentInteractionsRequestSessionId = null;
            const queued = state.agentInteractionsQueuedSessionId;
            state.agentInteractionsQueuedSessionId = null;
            if (queued) {
                void refreshAgentInteractions(queued);
            }
        }
    };

    const maybeLoadSelectedPausedInteractions = () => {
        const selected = state.agentSelectedSessionId;
        const selectedSession = selected
            ? state.agentSessions.find((session) => session.sessionId === selected)
            : undefined;
        if (selectedSession?.state === 'paused') {
            void refreshAgentInteractions(selectedSession.sessionId);
            return;
        }
        if (!selected) {
            const paused = [...state.agentSessions]
                .filter((session) => session.state === 'paused')
                .sort((a, b) => b.createdAt - a.createdAt);
            if (paused.length > 0) {
                state.agentSelectedSessionId = paused[0].sessionId;
                void refreshAgentInteractions(paused[0].sessionId);
            }
        }
    };

    const parseJsonOrErr = (raw: string): Record<string, unknown> | null => {
        try {
            const parsed = JSON.parse(raw.trim() ? raw : '{}') as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                setOutput({ code: 'ERR_BAD_ARGS', message: 'JSON must be object' });
                return null;
            }
            return parsed as Record<string, unknown>;
        } catch {
            setOutput({ code: 'ERR_BAD_ARGS', message: 'Invalid JSON' });
            return null;
        }
    };

    const interceptAction = (action: Action, requestType?: string, requestWorkspace?: string) => {
        const payload = (action.payload && typeof action.payload === 'object') ? action.payload as Record<string, unknown> : {};
        if (Array.isArray(payload.workspaces)) {
            state.workspaces = payload.workspaces as WorkspaceItem[];
            const activeWs = typeof payload.activeWorkspaceName === 'string' ? payload.activeWorkspaceName : '';
            if (activeWs) {
                state.activeWorkspaceName = activeWs;
            } else if (!state.activeWorkspaceName && state.workspaces.length > 0) {
                state.activeWorkspaceName = state.workspaces[0].workspaceName;
            }
        }
        if (Array.isArray(payload.tabs)) {
            state.tabs = payload.tabs as TabItem[];
            const activeTab = state.tabs.find((t) => t.active);
            state.activeTabName = activeTab?.tabName ?? '';
        }
        if (Array.isArray(payload.recordings)) {
            state.savedRecordings = payload.recordings
                .filter((item) => item && typeof item === 'object')
                .map((item) => {
                    const row = item as Record<string, unknown>;
                    return {
                        recordingName: typeof row.recordingName === 'string' ? row.recordingName : '',
                        stepCount: typeof row.stepCount === 'number' && Number.isFinite(row.stepCount)
                            ? row.stepCount
                            : 0,
                    };
                })
                .filter((item) => Boolean(item.recordingName));
        }
        if (payload.unsaved && typeof payload.unsaved === 'object') {
            const unsaved = payload.unsaved as Record<string, unknown>;
            state.unsavedStepCount = typeof unsaved.stepCount === 'number' && Number.isFinite(unsaved.stepCount)
                ? unsaved.stepCount
                : 0;
        }
        if (Array.isArray(payload.sessions)) {
            const incoming = payload.sessions.flatMap((item) => {
                const normalized = normalizeAgentSession(item);
                return normalized ? [normalized] : [];
            });
            const previous = state.agentSessions;
            state.agentSessions = incoming.map((session) => {
                const existing = previous.find((item) => item.sessionId === session.sessionId);
                if (existing && existing.endedAt !== null && session.state === 'running') {
                    return existing;
                }
                return session;
            });
            state.agentStatus = {kind: 'idle'};
            state.agentListInFlight = false;
            maybeLoadSelectedPausedInteractions();
        }
        const snapshot = normalizeAgentSession(payload);
        if (!Array.isArray(payload.sessions) && snapshot) {
            const existing = state.agentSessions.find((session) => session.sessionId === snapshot.sessionId);
            const accepted = existing && existing.endedAt !== null && snapshot.state === 'running' ? existing : snapshot;
            state.agentSessions = [
                ...state.agentSessions.filter((session) => session.sessionId !== accepted.sessionId),
                accepted,
            ];
            if (requestType === 'agent.sessions.cancel') {
                state.agentPendingCancels.delete(snapshot.sessionId);
            }
            maybeLoadSelectedPausedInteractions();
        }
        if (requestType === 'agent.sessions.list' && !Array.isArray(payload.sessions)) {
            state.agentListInFlight = false;
            state.agentStatus = {kind: 'idle'};
        }
        if (requestType === 'agent.sessions.report') {
            const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : state.agentSelectedSessionId ?? '';
            state.agentSelectedSessionId = sessionId || state.agentSelectedSessionId;
            if (action.type.endsWith('.failed')) {
                state.agentReport = {sessionId, status: 'missing'};
            } else {
                const report = normalizeAgentSessionReport(payload.report);
                state.agentReport = report
                    ? {sessionId, status: 'loaded', report}
                    : {sessionId, status: 'missing'};
            }
            state.agentReportInFlight = false;
            state.agentStatus = {kind: 'idle'};
        }
        if (requestType === 'agent.interactions.list') {
            const sessionId = typeof payload.sessionId === 'string' && payload.sessionId
                ? payload.sessionId
                : (state.agentInteractionsRequestSessionId ?? state.agentInteractionsSessionId ?? '');
            if (action.type.endsWith('.failed')) {
                const message = isRecord(payload) && typeof payload.message === 'string'
                    ? payload.message
                    : action.type;
                state.agentInteractions = [];
                state.agentInteractionsSessionId = sessionId || null;
                state.agentInteractionError = {kind: 'list', message: `interactions unavailable: ${message}`};
            } else {
                state.agentInteractions = (Array.isArray(payload.interactions) ? payload.interactions : [])
                    .flatMap((item) => {
                        const normalized = normalizeAgentInteraction(item);
                        return normalized ? [normalized] : [];
                    });
                state.agentInteractionsSessionId = sessionId || null;
                if (state.agentInteractionError?.kind === 'list') {
                    state.agentInteractionError = null;
                }
            }
            state.agentInteractionsInFlight = false;
            state.agentInteractionsRequestSessionId = null;
        }
        if (requestType === 'agent.interactions.approve' || requestType === 'agent.interactions.deny') {
            if (action.type.endsWith('.failed')) {
                const message = isRecord(payload) && typeof payload.message === 'string'
                    ? payload.message
                    : action.type;
                state.agentInteractionError = {kind: 'decision', message};
                void refreshAgentSessions();
                const boundSessionId = state.agentInteractionsSessionId ?? state.agentSelectedSessionId;
                if (boundSessionId) {
                    void refreshAgentInteractions(boundSessionId);
                }
            } else {
                state.agentInteractionError = null;
                const sessionRaw = isRecord(payload.session) ? payload.session : null;
                const snapshot = sessionRaw ? normalizeAgentSession(sessionRaw) : null;
                if (snapshot) {
                    const existing = state.agentSessions.find((session) => session.sessionId === snapshot.sessionId);
                    const accepted = existing && existing.endedAt !== null && snapshot.state === 'running' ? existing : snapshot;
                    state.agentSessions = [
                        ...state.agentSessions.filter((session) => session.sessionId !== accepted.sessionId),
                        accepted,
                    ];
                }
                void refreshAgentSessions();
                if (state.agentSelectedSessionId === snapshot?.sessionId) {
                    void refreshAgentInteractions(snapshot.sessionId);
                }
            }
        }
        if (action.type.endsWith('.failed')) {
            const message = isRecord(payload) && typeof payload.message === 'string'
                ? payload.message
                : action.type;
            if (
                requestType === 'agent.sessions.list'
                || requestType === 'agent.sessions.start'
                || requestType === 'agent.sessions.cancel'
            ) {
                state.agentListInFlight = false;
                state.agentStatus = {kind: 'error', message};
            }
        }
        if (requestType === 'workspace.setActive' && !action.type.endsWith('.failed')) {
            const workspaceName = typeof payload.workspaceName === 'string' ? payload.workspaceName : '';
            if (workspaceName) {
                state.activeWorkspaceName = workspaceName;
                const activeWorkspace = state.workspaces.find((workspace) => workspace.workspaceName === workspaceName);
                state.activeTabName = activeWorkspace?.activeTabName ?? '';
            }
            void refreshTabs();
        }
        if (requestType === 'workflow.open' && !action.type.endsWith('.failed')) {
            void refreshWorkspaces();
            void refreshTabs();
            void refreshRecordings();
        }
        if (requestType === 'tab.setActive' && !action.type.endsWith('.failed')) {
            const tabName = typeof payload.tabName === 'string' ? payload.tabName : '';
            if (tabName) {
                state.activeTabName = tabName;
                state.tabs = state.tabs.map((tab) => ({ ...tab, active: tab.tabName === tabName }));
            }
            void refreshTabs();
        }
        if (requestType === 'record.save' && !action.type.endsWith('.failed')) {
            void refreshRecordings();
        }
        if (requestType === 'workflow.saveAs' && !action.type.endsWith('.failed')) {
            void refreshWorkspaces();
            void refreshTabs();
            void refreshRecordings();
        }
        if (requestType === 'workflow.resetDefault' && !action.type.endsWith('.failed')) {
            void refreshWorkspaces();
            void refreshTabs();
            void refreshRecordings();
        }
        if (action.type.startsWith('play.')) {
            const workspaceName = action.workspaceName
                || (typeof payload.workspaceName === 'string' ? payload.workspaceName : requestWorkspace);
            if (workspaceName) {
                const playback = updatePlaybackStatus(state.playbackByWorkspace.get(workspaceName), action, requestType);
                if (playback) {state.playbackByWorkspace.set(workspaceName, playback);}
            }
        }
    };

    const createButton = (label: string, onClick: () => unknown, primary = false): HTMLButtonElement => {
        const btn = document.createElement('button');
        btn.textContent = label;
        if (primary) {btn.classList.add('primary');}
        btn.addEventListener('click', () => {
            void Promise.resolve(onClick());
        });
        return btn;
    };

    const renderConn = () => {
        const box = document.createElement('div');
        box.className = 'section';
        box.innerHTML = `
          <div class="title">Connection</div>
          <div class="hint">activeWorkspaceName: ${state.activeWorkspaceName || '-'}</div>
          <div class="hint">activeTabName: ${state.activeTabName || '-'}</div>
          <div class="hint">tabName: ${opts.tabName}</div>
          <div class="hint">url: ${location.href}</div>
          <div class="hint">title: ${document.title}</div>
          <div class="hint">extensionBuild: ${buildId}</div>
        `;
        const row = document.createElement('div');
        row.className = 'row';
        row.append(
            createButton('Refresh', async () => { await refreshWorkspaces(); await refreshTabs(); }, true),
            createButton('Reset Default', async () => { await sendPanelAction('workflow.resetDefault', {}); }),
        );
        const row2 = document.createElement('div');
        row2.className = 'row';
        row2.append(
            createButton('Clear Output', () => { setOutput({}); }),
            createButton('record.list', refreshRecordings),
        );
        box.appendChild(row2);
        box.appendChild(row);
        return box;
    };

    const renderWS = () => {
        const root = document.createElement('div');
        const wsBox = document.createElement('div');
        wsBox.className = 'section';
        wsBox.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Workspaces' }));
        const wsList = document.createElement('div');
        wsList.className = 'list';
        state.workspaces.forEach((ws) => {
            wsList.appendChild(createButton(`${ws.workspaceName} (${String(ws.tabCount)})`, async () => {
                state.activeWorkspaceName = ws.workspaceName;
                await sendPanelAction('workspace.setActive', { workspaceName: ws.workspaceName });
            }, ws.workspaceName === state.activeWorkspaceName));
        });
        wsBox.append(wsList);
        const wsRow = document.createElement('div');
        wsRow.className = 'row';
        wsRow.append(
            createButton('Refresh WS', refreshWorkspaces),
            createButton('Create WS', async () => { await sendPanelAction('workspace.create', {}); await refreshWorkspaces(); }),
        );
        wsBox.append(wsRow);

        const wfBox = document.createElement('div');
        wfBox.className = 'section';
        wfBox.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Workflow' }));
        const workflowInput = document.createElement('input');
        workflowInput.placeholder = 'workflowName';
        workflowInput.value = state.workflowName;
        workflowInput.addEventListener('input', () => { state.workflowName = workflowInput.value; });
        wfBox.append(workflowInput);
        const wfRow1 = document.createElement('div');
        wfRow1.className = 'row';
        wfRow1.append(
            createButton('workflow.list', () => sendPanelAction('workflow.list', {})),
            createButton('workflow.create', () => sendPanelAction('workflow.create', { workflowName: state.workflowName.trim() })),
        );
        const wfRow2 = document.createElement('div');
        wfRow2.className = 'row';
        wfRow2.append(createButton('workflow.open', async () => {
            const reply = await sendPanelAction('workflow.open', { workflowName: state.workflowName.trim() });
            if (!reply.type.endsWith('.failed')) { await refreshWorkspaces(); await refreshTabs(); }
        }, true));
        wfBox.append(wfRow1, wfRow2);
        const resetRow = document.createElement('div');
        resetRow.className = 'row';
        resetRow.append(createButton('workflow.resetDefault', () => sendPanelAction('workflow.resetDefault', {})));
        wfBox.append(resetRow);

        const saveAsBox = document.createElement('div');
        saveAsBox.className = 'section';
        saveAsBox.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Save As' }));
        const targetInput = document.createElement('input');
        targetInput.placeholder = 'targetName';
        targetInput.value = state.targetName;
        targetInput.addEventListener('input', () => { state.targetName = targetInput.value; });
        saveAsBox.append(targetInput);
        const saveAsRow = document.createElement('div');
        saveAsRow.className = 'row';
        saveAsRow.append(createButton('workflow.saveAs', async () => {
            const reply = await sendPanelAction('workflow.saveAs', {
                sourceName: state.activeWorkspaceName.trim(),
                targetName: state.targetName.trim(),
            });
            if (!reply.type.endsWith('.failed')) {
                await refreshWorkspaces();
                await refreshTabs();
                await refreshRecordings();
            }
        }, true));
        saveAsBox.append(saveAsRow);
        root.append(wsBox, wfBox, saveAsBox);
        return root;
    };

    const renderTabsTab = () => {
        const root = document.createElement('div');
        const box = document.createElement('div');
        box.className = 'section';
        box.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: `Tabs @ ${state.activeWorkspaceName || '-'}` }));
        const list = document.createElement('div');
        list.className = 'list';
        state.tabs.forEach((tab) => {
            list.appendChild(createButton(`${tab.tabName} ${tab.title || tab.url || ''}`.slice(0, 60), () => sendPanelAction('tab.setActive', { tabName: tab.tabName }), tab.active));
        });
        box.append(list);
        const row1 = document.createElement('div');
        row1.className = 'row';
        row1.append(
            createButton('tab.list', refreshTabs),
            createButton('tab.create', () => { void chrome.tabs.create({}); }),
        );
        const row2 = document.createElement('div');
        row2.className = 'row';
        row2.append(createButton('tab.close', () => {
            if (!state.activeTabName) {return;}
            return sendPanelAction('tab.close', { tabName: state.activeTabName });
        }));
        box.append(row1, row2);
        root.append(box);
        return root;
    };

    const renderRec = () => {
        const box = document.createElement('div');
        box.className = 'section';
        box.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Record' }));
        const row1 = document.createElement('div');
        row1.className = 'row';
        row1.append(createButton('record.start', () => sendPanelAction('record.start', {}), true), createButton('record.stop', () => sendPanelAction('record.stop', {})));
        const row2 = document.createElement('div');
        row2.className = 'row';
        row2.append(createButton('Get Unsaved', () => sendPanelAction('record.get', {})), createButton('Clear Unsaved', () => sendPanelAction('record.clear', {})));
        const row3 = document.createElement('div');
        row3.className = 'row3';
        const input = document.createElement('input');
        input.placeholder = 'recordingName';
        input.value = state.recordingName;
        input.addEventListener('input', () => { state.recordingName = input.value; });
        row3.append(
            input,
            createButton('Save Recording', () => sendPanelAction('record.save', { recordingName: state.recordingName.trim(), includeStepResolve: true }), true),
            createButton('record.list', () => sendPanelAction('record.list', {})),
        );
        const list = document.createElement('div');
        list.className = 'list';
        const unsaved = document.createElement('div');
        unsaved.className = 'hint';
        unsaved.textContent = `unsaved stepCount: ${String(state.unsavedStepCount)}`;
        list.append(unsaved);
        state.savedRecordings.forEach((item) => {
            const line = document.createElement('div');
            line.className = 'hint';
            line.textContent = `${item.recordingName} (${String(item.stepCount)})`;
            list.append(line);
        });
        box.append(row1, row2, row3, list);
        return box;
    };

    const renderPlay = () => {
        const root = document.createElement('div');
        const box = document.createElement('div');
        box.className = 'section';
        box.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Play' }));
        const source = document.createElement('select');
        source.innerHTML = '';
        const unsavedOption = document.createElement('option');
        unsavedOption.value = 'unsaved';
        unsavedOption.textContent = 'Unsaved current recording';
        source.appendChild(unsavedOption);
        state.savedRecordings.forEach((item) => {
            const option = document.createElement('option');
            option.value = item.recordingName;
            option.textContent = `${item.recordingName} (${String(item.stepCount)})`;
            source.appendChild(option);
        });
        source.value = state.replaySource;
        source.addEventListener('change', () => { state.replaySource = source.value; });
        box.append(source);
        const row = document.createElement('div');
        row.className = 'row';
        row.append(
            createButton('Play', () => sendPanelAction('play.start', state.replaySource === 'unsaved' ? {} : { recordingName: state.replaySource }), true),
            createButton('Stop', () => sendPanelAction('play.stop', {})),
        );
        box.append(row);
        const playback = state.playbackByWorkspace.get(state.activeWorkspaceName);
        if (playback) {
            const summary = document.createElement('div');
            summary.className = 'list';
            summary.dataset.playbackStatus = playback.phase;
            summary.setAttribute('role', 'status');
            const title = document.createElement('strong');
            title.textContent = {
                running: 'Playback in progress',
                completed: playback.failure ? 'Playback completed with errors' : 'Playback completed',
                failed: 'Playback stopped',
                canceled: 'Playback canceled',
                'start-failed': 'Could not start playback',
            }[playback.phase];
            const progress = document.createElement('div');
            progress.className = 'hint';
            progress.textContent = playback.total === undefined
                ? `${playback.completed} steps processed`
                : `${playback.completed} / ${playback.total} steps processed`;
            summary.append(title);
            if (playback.phase !== 'start-failed') {summary.append(progress);}
            if (playback.current) {
                const current = document.createElement('div');
                current.textContent = `Running step ${playback.current.index + 1} ${playback.current.name}`.trim();
                summary.append(current);
            }
            if (playback.failure) {
                const {step, code, reason} = playback.failure;
                const failure = document.createElement('div');
                const label = step ? `Step ${step.index + 1} ${step.name}`.trim() : 'Playback error';
                failure.textContent = `${label}${code ? ` (${code})` : ''}. ${reason}`;
                summary.append(failure);
            }
            box.append(summary);
        }
        root.append(box);
        return root;
    };

    const renderFlow = () => {
        const root = document.createElement('div');
        const renderSub = (title: string, raw: string, setRaw: (v: string) => void, actions: Array<{ label: string; type: string }>) => {
            const box = document.createElement('div');
            box.className = 'section';
            box.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: title }));
            const ta = document.createElement('textarea');
            ta.value = raw;
            ta.addEventListener('input', () => { setRaw(ta.value); });
            box.append(ta);
            const rows = document.createElement('div');
            rows.className = 'row';
            actions.forEach((it) => {
                rows.appendChild(createButton(it.label, () => {
                    if (it.type.endsWith('.save') || it.type.endsWith('.delete') || it.type.endsWith('.test') || it.type.endsWith('.run') || it.type.endsWith('.get')) {
                        const parsed = parseJsonOrErr(ta.value);
                        if (!parsed) {return;}
                        return sendPanelAction(it.type, parsed);
                    }
                    return sendPanelAction(it.type, {});
                }));
            });
            box.append(rows);
            return box;
        };
        root.append(
            renderSub('DSL', state.dslRaw, (v) => { state.dslRaw = v; }, [
                { label: 'dsl.get', type: 'dsl.get' },
                { label: 'dsl.save', type: 'dsl.save' },
                { label: 'dsl.test', type: 'dsl.test' },
                { label: 'dsl.run', type: 'dsl.run' },
            ]),
            renderSub('Checkpoint', state.checkpointRaw, (v) => { state.checkpointRaw = v; }, [
                { label: 'checkpoint.list', type: 'checkpoint.list' },
                { label: 'checkpoint.get', type: 'checkpoint.get' },
                { label: 'checkpoint.save', type: 'checkpoint.save' },
                { label: 'checkpoint.delete', type: 'checkpoint.delete' },
            ]),
        );
        return root;
    };

    const renderEntityRules = () => {
        const root = document.createElement('div');
        const box = document.createElement('div');
        box.className = 'section';
        box.appendChild(Object.assign(document.createElement('div'), {
            className: 'title',
            textContent: 'Entity Rules State',
        }));
        const row = document.createElement('div');
        row.className = 'row';
        row.append(
            createButton('Copy JSON', async () => {
                await navigator.clipboard.writeText(JSON.stringify(state.annotatorDebug, null, 2));
            }),
            createButton('Clear View', () => { state.annotatorDebug = null; renderActiveView(); }),
        );
        const pre = document.createElement('pre');
        pre.className = 'debug-json';
        pre.textContent = state.annotatorDebug
            ? JSON.stringify(state.annotatorDebug, null, 2)
            : 'Open the annotator to inspect CanvasDraft, internal keys, bindings and validation results.';
        box.append(row, pre);
        root.append(box);
        return root;
    };

    const renderAgent = () => {
        const reportSession = async (sessionId: string) => {
            if (state.agentReportInFlight) {return;}
            state.agentSelectedSessionId = sessionId;
            state.agentReportInFlight = true;
            if (state.activeView === 'Agent') {renderActiveView();}
            try {
                await sendPanelAction('agent.sessions.report', {sessionId});
            } finally {
                state.agentReportInFlight = false;
                state.agentStatus = {kind: 'idle'};
            }
        };
        const handlers = {
            start: async () => {
                if (state.agentStatus.kind === 'loading' && state.agentStatus.loading === 'start') {return;}
                const inputs = state.agentInputs;
                const payload: Record<string, unknown> = {
                    prompt: inputs.prompt.trim(),
                    provider: inputs.provider.trim(),
                    model: inputs.model.trim(),
                };
                if (inputs.executionMode) {payload.executionMode = inputs.executionMode;}
                state.agentStatus = {kind: 'loading', loading: 'start'};
                state.agentSelectedSessionId = null;
                state.agentReport = null;
                renderActiveView();
                try {
                    await sendPanelAction('agent.sessions.start', payload);
                } finally {
                    state.agentStatus = {kind: 'idle'};
                    if (state.activeView === 'Agent') {renderActiveView();}
                }
            },
            list: async () => {
                if (state.agentListInFlight) {return;}
                state.agentListInFlight = true;
                state.agentStatus = {kind: 'loading', loading: 'list'};
                renderActiveView();
                try {
                    await refreshAgentSessions();
                } finally {
                    state.agentListInFlight = false;
                    state.agentStatus = {kind: 'idle'};
                }
            },
            status: async (sessionId: string) => {
                await sendPanelAction('agent.sessions.status', {sessionId});
            },
            cancel: async (sessionId: string) => {
                if (state.agentPendingCancels.has(sessionId)) {return;}
                state.agentPendingCancels = new Set([...state.agentPendingCancels, sessionId]);
                renderActiveView();
                try {
                    await sendPanelAction('agent.sessions.cancel', {sessionId});
                } finally {
                    const next = new Set(state.agentPendingCancels);
                    next.delete(sessionId);
                    state.agentPendingCancels = next;
                    state.agentStatus = {kind: 'idle'};
                }
            },
            select: async (sessionId: string) => {
                state.agentSelectedSessionId = sessionId;
                const session = state.agentSessions.find((item) => item.sessionId === sessionId);
                if (session?.state === 'paused') {
                    state.agentReport = null;
                    state.agentInteractionError = null;
                    await refreshAgentInteractions(sessionId);
                    if (state.activeView === 'Agent') {renderActiveView();}
                    return;
                }
                state.agentInteractions = [];
                state.agentInteractionsSessionId = null;
                state.agentInteractionError = null;
                if (session?.reportAvailable) {
                    await reportSession(sessionId);
                } else {
                    state.agentReport = null;
                    if (state.activeView === 'Agent') {renderActiveView();}
                }
            },
            report: reportSession,
            approve: async (input: {sessionId: string; interactionId: string; revision: number}) => {
                if (state.agentPendingDecisions.has(input.interactionId)) {return;}
                state.agentPendingDecisions = new Set([...state.agentPendingDecisions, input.interactionId]);
                state.agentInteractionError = null;
                if (state.activeView === 'Agent') {renderActiveView();}
                try {
                    await sendPanelAction('agent.interactions.approve', {
                        sessionId: input.sessionId,
                        interactionId: input.interactionId,
                        revision: input.revision,
                        approvedBy: AGENT_APPROVAL_ACTOR,
                    });
                } finally {
                    const next = new Set(state.agentPendingDecisions);
                    next.delete(input.interactionId);
                    state.agentPendingDecisions = next;
                    if (state.activeView === 'Agent') {renderActiveView();}
                }
            },
            deny: async (input: {sessionId: string; interactionId: string; revision: number; reason: string}) => {
                if (state.agentPendingDecisions.has(input.interactionId)) {return;}
                state.agentPendingDecisions = new Set([...state.agentPendingDecisions, input.interactionId]);
                state.agentInteractionError = null;
                if (state.activeView === 'Agent') {renderActiveView();}
                try {
                    await sendPanelAction('agent.interactions.deny', {
                        sessionId: input.sessionId,
                        interactionId: input.interactionId,
                        revision: input.revision,
                        deniedBy: AGENT_APPROVAL_ACTOR,
                        reason: input.reason.trim(),
                    });
                } finally {
                    const next = new Set(state.agentPendingDecisions);
                    next.delete(input.interactionId);
                    state.agentPendingDecisions = next;
                    if (state.activeView === 'Agent') {renderActiveView();}
                }
            },
            prune: async (maxCount: number) => {
                await sendPanelAction('agent.sessions.prune', {maxCount});
                await refreshAgentSessions();
            },
            clear: () => {
                state.agentSessions = [];
                state.agentStatus = {kind: 'idle'};
                state.agentSelectedSessionId = null;
                state.agentReport = null;
                state.agentPendingCancels = new Set();
                state.agentListInFlight = false;
                state.agentReportInFlight = false;
                state.agentInteractions = [];
                state.agentInteractionsSessionId = null;
                state.agentInteractionsInFlight = false;
                state.agentInteractionsRequestSessionId = null;
                state.agentInteractionsQueuedSessionId = null;
                state.agentInteractionError = null;
                state.agentPendingDecisions = new Set();
                state.agentDenyReasons = {};
                renderActiveView();
            },
        };
        const root = buildAgentSessionView({
            sessions: state.agentSessions,
            inputs: state.agentInputs,
            onInputsChange: (patch) => {
                state.agentInputs = {...state.agentInputs, ...patch};
            },
            handlers,
            report: state.agentReport,
            status: state.agentStatus,
            selectedSessionId: state.agentSelectedSessionId,
            pendingCancelSessionIds: state.agentPendingCancels,
            pruneMaxCount: 20,
            interactions: state.agentInteractions,
            interactionsSessionId: state.agentInteractionsSessionId,
            interactionsLoading: state.agentInteractionsInFlight,
            pendingDecisionInteractionIds: state.agentPendingDecisions,
            denyReasons: state.agentDenyReasons,
            onDenyReasonChange: (interactionId: string, reason: string) => {
                state.agentDenyReasons = {...state.agentDenyReasons, [interactionId]: reason};
            },
            interactionError: state.agentInteractionError?.message ?? null,
        });
        ensureAgentPoll();
        return root;
    };

    const renderLog = () => {
        const root = document.createElement('div');
        const box = document.createElement('div');
        box.className = 'section';
        box.appendChild(Object.assign(document.createElement('div'), { className: 'title', textContent: 'Recent Actions (50)' }));
        const row = document.createElement('div');
        row.className = 'row';
        row.append(
            createButton('Clear Log', () => { state.logs = []; renderActiveView(); }),
            createButton('Copy Last', async () => {
                const last = state.logs.at(-1);
                if (!last) {return;}
                await navigator.clipboard.writeText(JSON.stringify(last.action));
            }),
        );
        box.append(row);
        const list = document.createElement('div');
        list.className = 'log-list';
        state.logs.slice().reverse().forEach((item) => {
            const el = document.createElement('div');
            el.className = 'log-item';
            const p = (item.action.payload && typeof item.action.payload === 'object') ? JSON.stringify(sanitizeForDisplay(item.action.payload)).slice(0, 100) : '';
            el.textContent = `[${item.kind}] ${item.action.type} ws=${item.action.workspaceName ?? '-'} replyTo=${item.action.replyTo ?? '-'} payload=${p}`;
            list.appendChild(el);
        });
        box.append(list);
        root.append(box);
        return root;
    };

    const renderActiveView = () => {
        body.innerHTML = '';
        if (state.activeView === 'Conn') {body.appendChild(renderConn());}
        if (state.activeView === 'WS') {body.appendChild(renderWS());}
        if (state.activeView === 'Tabs') {body.appendChild(renderTabsTab());}
        if (state.activeView === 'Rec') {body.appendChild(renderRec());}
        if (state.activeView === 'Play') {body.appendChild(renderPlay());}
        if (state.activeView === 'Flow') {body.appendChild(renderFlow());}
        if (state.activeView === 'ER') {body.appendChild(renderEntityRules());}
        if (state.activeView === 'Agent') {body.appendChild(renderAgent());}
        if (state.activeView === 'Log') {body.appendChild(renderLog());}
    };

    const views: ViewKey[] = ['Conn', 'WS', 'Tabs', 'Rec', 'Play', 'Flow', 'ER', 'Agent', 'Log'];
    views.forEach((name) => {
        const btn = document.createElement('button');
        btn.textContent = name;
        btn.addEventListener('click', () => {
            state.activeView = name;
            Array.from(tabsBar.children).forEach((c) => { c.classList.remove('active'); });
            btn.classList.add('active');
            renderActiveView();
        });
        if (name === state.activeView) {btn.classList.add('active');}
        tabsBar.appendChild(btn);
    });

    opts.onEvent?.((action) => {
        logAction('event', action);
        setOutput(action);
        interceptAction(action);
        renderActiveView();
    });

    void refreshWorkspaces();
    void refreshTabs();
    void refreshRecordings();
    void refreshAgentSessions();
    renderActiveView();

    let refreshPending = false;
    const scheduleRefresh = () => {
        if (refreshPending) {return;}
        refreshPending = true;
        queueMicrotask(() => {
            refreshPending = false;
            void refreshWorkspaces();
            void refreshTabs();
            void entityRulesBrowser.refresh();
        });
    };

    return {
        unmount: () => {
            entityRulesBrowser.unmount();
            checkpointRecorder.unmount();
            clearAgentPoll();
            host.remove();
        },
        scheduleRefresh,
        onPageChanged: () => {
            void entityRulesBrowser.close();
            checkpointRecorder.onPageChanged();
        },
        setPageWorkspace: (workspaceName) => {
            pageWorkspaceName = workspaceName;
        },
        setAnnotatorDebugState: (raw: string) => {
            try {
                state.annotatorDebug = JSON.parse(raw) as unknown;
            } catch {
                state.annotatorDebug = {parseError: true, raw};
            }
            if (state.activeView === 'ER') {renderActiveView();}
        },
    };
};
