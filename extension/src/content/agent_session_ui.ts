export type AgentSessionState = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type AgentSessionProgramSummary = Readonly<{
    source: string;
    status: string;
    text?: string;
    error?: Readonly<{code: string; message: string}> | null;
}>;

export type AgentSessionSummary = Readonly<{
    sessionId: string;
    state: AgentSessionState;
    createdAt: number;
    startedAt: number;
    endedAt: number | null;
    request: Readonly<{
        prompt: string;
        provider: string;
        model: string;
        executionMode?: string;
        source?: string;
    }>;
    result: Readonly<{
        text: string;
        executionMode?: string;
        programs?: readonly AgentSessionProgramSummary[];
    }> | null;
    error: Readonly<{code: string; message: string}> | null;
    reportAvailable: boolean;
    resumable: boolean;
}>;

export type AgentSessionReportStatus = 'completed' | 'paused' | 'failed' | 'aborted' | 'invalid';

export type AgentSessionReportSummary = Readonly<{
    run: Readonly<{provider: string; model: string; executionMode: string}>;
    terminal: Readonly<{
        status: AgentSessionReportStatus;
        output?: string;
        error?: Readonly<{code: string; message: string}> | null;
    }>;
    toolMetrics: Readonly<{
        turns: number | null;
        toolCalls: number | null;
        effectCalls: number | null;
        failedToolCalls: number | null;
        repair: Readonly<{
            rewindCalls: number | null;
            rollbackCalls: number | null;
            patchCalls: number | null;
            recomputeCalls: number | null;
            refreshCalls: number | null;
        }>;
    }> | null;
    effects: Readonly<{
        availability: string;
        worldEffectCalls: number | null;
        failedWorldChangingEffects: number | null;
        compensationEffects: number | null;
    }> | null;
    programs: readonly Readonly<{
        index: number | null;
        status: string;
        source: string;
        output?: string;
        error?: Readonly<{code: string; message: string}> | null;
        effectsExposed: boolean;
        effectCount: number | null;
    }>[];
    savedArtifacts: readonly Readonly<{kind: string; name: string; artifactRevision: string}>[];
    toolCallCount: number | null;
}>;

export type AgentSessionReportViewState = Readonly<{
    sessionId: string;
    status: 'loaded' | 'missing';
    report?: AgentSessionReportSummary | null;
}>;

export type AgentSessionInputs = {
    prompt: string;
    provider: string;
    model: string;
    executionMode: string;
};

export type AgentSessionHandlers = {
    start: (inputs: AgentSessionInputs) => void | Promise<void>;
    list: () => void | Promise<void>;
    status: (sessionId: string) => void | Promise<void>;
    cancel: (sessionId: string) => void | Promise<void>;
    clear: () => void;
    report?: (sessionId: string) => void | Promise<void>;
    prune?: (maxCount: number) => void | Promise<void>;
};

export type AgentSessionViewOptions = {
    sessions: readonly AgentSessionSummary[];
    inputs: AgentSessionInputs;
    onInputsChange: (patch: Partial<AgentSessionInputs>) => void;
    handlers: AgentSessionHandlers;
    report?: AgentSessionReportViewState | null;
    pruneMaxCount?: number;
};

const AGENT_SESSION_STATES: readonly AgentSessionState[] = ['running', 'paused', 'completed', 'failed', 'cancelled'];

const DEFAULT_PRUNE_MAX_COUNT = 20;

export const isAgentSessionState = (value: unknown): value is AgentSessionState =>
    typeof value === 'string' && (AGENT_SESSION_STATES as readonly string[]).includes(value);

const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|passwd|authorization|credential|bearer|private[_-]?key)/i;

export const isSecretField = (key: string): boolean => SECRET_KEY_RE.test(key);

export const sanitizeForDisplay = (value: unknown, seen?: Set<object>): unknown => {
    if (value === null || typeof value !== 'object') {return value;}
    if (Array.isArray(value)) {return value.map((item) => sanitizeForDisplay(item, seen));}
    const visited = seen ?? new Set<object>();
    if (visited.has(value)) {return value;}
    visited.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (isSecretField(key)) {
            out[key] = '***';
        } else {
            out[key] = sanitizeForDisplay(item, visited);
        }
    }
    return out;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const normalizeProgram = (raw: unknown): AgentSessionProgramSummary | null => {
    if (!isRecord(raw)) {return null;}
    const status = str(raw.status);
    if (!status) {return null;}
    return {
        source: str(raw.source),
        status,
        text: typeof raw.text === 'string' ? raw.text : undefined,
        error: isRecord(raw.error) ? {code: str(raw.error.code), message: str(raw.error.message)} : undefined,
    };
};

export const normalizeAgentSession = (raw: unknown): AgentSessionSummary | null => {
    if (!isRecord(raw)) {return null;}
    const sessionId = str(raw.sessionId);
    if (!sessionId || !isAgentSessionState(raw.state)) {return null;}
    const requestRaw = isRecord(raw.request) ? raw.request : {};
    const resultRaw = isRecord(raw.result) ? raw.result : null;
    const errorRaw = isRecord(raw.error) ? raw.error : null;
    return {
        sessionId,
        state: raw.state,
        createdAt: num(raw.createdAt) ?? 0,
        startedAt: num(raw.startedAt) ?? 0,
        endedAt: num(raw.endedAt),
        request: {
            prompt: str(requestRaw.prompt),
            provider: str(requestRaw.provider),
            model: str(requestRaw.model),
            executionMode: typeof requestRaw.executionMode === 'string' ? requestRaw.executionMode : undefined,
            source: typeof requestRaw.source === 'string' ? requestRaw.source : undefined,
        },
        result: resultRaw === null
            ? null
            : {
                  text: str(resultRaw.text),
                  executionMode: typeof resultRaw.executionMode === 'string' ? resultRaw.executionMode : undefined,
                  programs: Array.isArray(resultRaw.programs)
                      ? resultRaw.programs.flatMap((program) => {
                            const normalized = normalizeProgram(program);
                            return normalized ? [normalized] : [];
                        })
                      : undefined,
              },
        error: errorRaw === null
            ? null
            : {code: str(errorRaw.code), message: str(errorRaw.message)},
        reportAvailable: raw.reportAvailable === true,
        resumable: raw.resumable === true,
    };
};

const REPORT_TERMINAL_STATUSES: readonly AgentSessionReportStatus[] = ['completed', 'paused', 'failed', 'aborted', 'invalid'];

const isReportTerminalStatus = (value: string): value is AgentSessionReportStatus =>
    (REPORT_TERMINAL_STATUSES as readonly string[]).includes(value);

const reportNum = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const reportError = (raw: unknown): Readonly<{code: string; message: string}> | null =>
    isRecord(raw) ? {code: str(raw.code), message: str(raw.message)} : null;

export const normalizeAgentSessionReport = (raw: unknown): AgentSessionReportSummary | null => {
    if (!isRecord(raw)) {return null;}
    const terminalRaw = isRecord(raw.terminal) ? raw.terminal : null;
    if (!terminalRaw) {return null;}
    const terminalStatus = str(terminalRaw.status);
    if (!isReportTerminalStatus(terminalStatus)) {return null;}
    const runRaw = isRecord(raw.run) ? raw.run : null;
    const toolMetricsRaw = isRecord(raw.toolMetrics) ? raw.toolMetrics : null;
    const repairRaw = isRecord(toolMetricsRaw?.repair) ? toolMetricsRaw.repair : null;
    const effectsRaw = isRecord(raw.effects) ? raw.effects : null;
    return {
        run: {
            provider: runRaw ? str(runRaw.provider) : '',
            model: runRaw ? str(runRaw.model) : '',
            executionMode: runRaw ? str(runRaw.executionMode) : '',
        },
        terminal: {
            status: terminalStatus,
            output: typeof terminalRaw.output === 'string' && terminalRaw.output.trim() ? terminalRaw.output : undefined,
            error: reportError(terminalRaw.error),
        },
        toolMetrics: toolMetricsRaw === null ? null : {
            turns: reportNum(toolMetricsRaw.turns),
            toolCalls: reportNum(toolMetricsRaw.toolCalls),
            effectCalls: reportNum(toolMetricsRaw.effectCalls),
            failedToolCalls: reportNum(toolMetricsRaw.failedToolCalls),
            repair: {
                rewindCalls: repairRaw ? reportNum(repairRaw.rewindCalls) : null,
                rollbackCalls: repairRaw ? reportNum(repairRaw.rollbackCalls) : null,
                patchCalls: repairRaw ? reportNum(repairRaw.patchCalls) : null,
                recomputeCalls: repairRaw ? reportNum(repairRaw.recomputeCalls) : null,
                refreshCalls: repairRaw ? reportNum(repairRaw.refreshCalls) : null,
            },
        },
        effects: effectsRaw === null ? null : {
            availability: str(effectsRaw.availability) || 'not-exposed',
            worldEffectCalls: reportNum(effectsRaw.worldEffectCalls),
            failedWorldChangingEffects: Array.isArray(effectsRaw.failedWorldChangingEffects)
                ? effectsRaw.failedWorldChangingEffects.length
                : null,
            compensationEffects: Array.isArray(effectsRaw.compensationEffects)
                ? effectsRaw.compensationEffects.length
                : null,
        },
        programs: (Array.isArray(raw.programs) ? raw.programs : []).flatMap((program) => {
            if (!isRecord(program)) {return [];}
            const status = str(program.status);
            if (!status) {return [];}
            const error = reportError(program.error);
            return [{
                index: reportNum(program.index),
                status,
                source: str(program.source),
                output: typeof program.output === 'string' && program.output.trim() ? program.output : undefined,
                ...(error === null ? {} : {error}),
                effectsExposed: program.effectsExposed === true,
                effectCount: reportNum(program.effectCount),
            }];
        }),
        savedArtifacts: (Array.isArray(raw.savedArtifacts) ? raw.savedArtifacts : []).flatMap((artifact) => {
            if (!isRecord(artifact)) {return [];}
            const name = str(artifact.name);
            if (!name) {return [];}
            return [{
                kind: str(artifact.kind) || 'program',
                name,
                artifactRevision: str(artifact.artifactRevision),
            }];
        }),
        toolCallCount: Array.isArray(raw.toolCalls) ? raw.toolCalls.length : null,
    };
};

const STATE_LABELS: Record<AgentSessionState, string> = {
    running: 'running',
    paused: 'paused',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
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

const hint = (text: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'hint';
    el.textContent = text;
    return el;
};

const section = (title: string): HTMLElement => {
    const box = document.createElement('div');
    box.className = 'section';
    box.appendChild(Object.assign(document.createElement('div'), {className: 'title', textContent: title}));
    return box;
};

const renderProgramStatus = (session: AgentSessionSummary): HTMLElement[] => {
    const programs = session.result?.programs ?? [];
    if (programs.length === 0) {return [];}
    return programs.map((program) => {
        const line = document.createElement('div');
        line.className = 'hint';
        line.textContent = `${program.status}: ${program.source || session.request.prompt.slice(0, 40)}`;
        if (program.error?.message) {line.textContent += ` — ${program.error.message}`;}
        return line;
    });
};

const renderSession = (
    session: AgentSessionSummary,
    handlers: AgentSessionHandlers,
): HTMLElement => {
    const item = document.createElement('div');
    item.className = 'log-item';
    item.dataset.sessionId = session.sessionId;
    item.dataset.sessionState = session.state;
    item.dataset.reportAvailable = String(session.reportAvailable);
    item.dataset.resumable = String(session.resumable);

    const head = document.createElement('div');
    head.className = 'hint';
    const mode = session.request.executionMode ? ` · ${session.request.executionMode}` : '';
    head.textContent = `[${STATE_LABELS[session.state]}] ${session.request.model || session.request.provider || session.sessionId}${mode}`;
    item.appendChild(head);

    const controlsRow = document.createElement('div');
    controlsRow.className = 'row';
    if (session.state === 'running') {
        controlsRow.appendChild(createButton('Status', () => handlers.status(session.sessionId)));
        controlsRow.appendChild(createButton('Cancel', () => handlers.cancel(session.sessionId)));
    }
    const report = handlers.report;
    if (report) {
        controlsRow.appendChild(createButton('Report', () => report(session.sessionId)));
    }
    if (controlsRow.childElementCount > 0) {
        item.appendChild(controlsRow);
    }
    if (session.state === 'paused') {
        item.appendChild(hint(session.resumable
            ? 'Paused — resume/approve is not available in this service.'
            : 'Paused — resume/approve is not available (resumable: false).'));
    }
    if (session.state === 'failed' && session.error) {
        item.appendChild(hint(`${session.error.code}: ${session.error.message}`));
    }
    if (session.result?.text.trim()) {
        item.appendChild(hint(`text: ${session.result.text.slice(0, 200)}`));
    }
    for (const line of renderProgramStatus(session)) {
        item.appendChild(line);
    }
    item.appendChild(hint(`report: ${session.reportAvailable ? 'available' : 'unavailable'}`));
    return item;
};

const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

const metricLabel = (label: string, value: number | null): string | null =>
    value === null ? null : `${label}: ${String(value)}`;

const renderReport = (
    reportState: AgentSessionReportViewState,
    handlers: AgentSessionHandlers,
): HTMLElement => {
    const box = section(`Report — ${reportState.sessionId}`);
    const reportHandler = handlers.report;
    if (reportHandler) {
        const row = document.createElement('div');
        row.className = 'row';
        row.appendChild(createButton('Refresh Report', () => reportHandler(reportState.sessionId)));
        box.appendChild(row);
    }
    if (reportState.status === 'missing' || !reportState.report) {
        box.appendChild(hint('Report unavailable for this session.'));
        return box;
    }
    const report = reportState.report;
    const terminal = report.terminal;
    const terminalText = terminal.output ?? '';
    box.appendChild(hint(
        `terminal: ${terminal.status}${terminalText ? ` — ${truncate(terminalText, 400)}` : ''}`,
    ));
    if (terminal.error?.message) {
        box.appendChild(hint(`error: ${terminal.error.code}: ${terminal.error.message}`));
    }
    const runInfo = [report.run.provider, report.run.model, report.run.executionMode].filter(Boolean).join(' · ');
    if (runInfo) {box.appendChild(hint(`run: ${runInfo}`));}

    box.appendChild(hint('governance: unavailable'));

    if (report.toolMetrics) {
        const metrics = report.toolMetrics;
        const repair = metrics.repair;
        const parts = [
            metricLabel('turns', metrics.turns),
            metricLabel('toolCalls', metrics.toolCalls),
            metricLabel('effectCalls', metrics.effectCalls),
            metricLabel('failedToolCalls', metrics.failedToolCalls),
            metricLabel('rewind', repair.rewindCalls),
            metricLabel('rollback', repair.rollbackCalls),
            metricLabel('patch', repair.patchCalls),
            metricLabel('recompute', repair.recomputeCalls),
            metricLabel('refresh', repair.refreshCalls),
        ].filter((part): part is string => part !== null);
        box.appendChild(hint(`tool metrics: ${parts.length > 0 ? parts.join(' · ') : 'none'}`));
    } else {
        box.appendChild(hint('tool metrics: unavailable'));
    }

    if (report.effects) {
        const effects = report.effects;
        if (effects.availability === 'not-exposed') {
            box.appendChild(hint('effects: not exposed (unavailable)'));
        } else {
            const parts = [
                metricLabel('world effect calls', effects.worldEffectCalls),
                metricLabel('failed effects', effects.failedWorldChangingEffects),
                metricLabel('compensations', effects.compensationEffects),
            ].filter((part): part is string => part !== null);
            box.appendChild(hint(`effects: ${parts.length > 0 ? parts.join(' · ') : 'none'}`));
        }
    } else {
        box.appendChild(hint('effects: unavailable'));
    }

    if (report.programs.length > 0) {
        for (const program of report.programs) {
            const index = program.index === null ? '?' : String(program.index);
            const effectsNote = program.effectsExposed && program.effectCount !== null
                ? ` · effects: ${String(program.effectCount)}`
                : '';
            const errorNote = program.error?.message ? ` — ${program.error.code}: ${program.error.message}` : '';
            box.appendChild(hint(`program ${index}: ${program.status} — ${program.source}${effectsNote}${errorNote}`));
        }
    } else {
        box.appendChild(hint('programs: none'));
    }

    if (report.savedArtifacts.length > 0) {
        for (const artifact of report.savedArtifacts) {
            box.appendChild(hint(`artifact: ${artifact.name} (${artifact.artifactRevision})`));
        }
    } else {
        box.appendChild(hint('saved artifacts: none'));
    }

    if (report.toolCallCount !== null) {
        box.appendChild(hint(`tool calls recorded: ${String(report.toolCallCount)} (arguments not shown)`));
    }
    return box;
};

export const buildAgentSessionView = (opts: AgentSessionViewOptions): HTMLElement => {
    const root = document.createElement('div');

    const runBox = section('Agent Session');
    const promptInput = document.createElement('textarea');
    promptInput.placeholder = 'prompt';
    promptInput.value = opts.inputs.prompt;
    promptInput.addEventListener('input', () => {
        opts.onInputsChange({prompt: promptInput.value});
    });
    runBox.appendChild(promptInput);

    const providerInput = document.createElement('input');
    providerInput.placeholder = 'provider';
    providerInput.value = opts.inputs.provider;
    providerInput.addEventListener('input', () => {
        opts.onInputsChange({provider: providerInput.value});
    });
    runBox.appendChild(providerInput);

    const modelInput = document.createElement('input');
    modelInput.placeholder = 'model';
    modelInput.value = opts.inputs.model;
    modelInput.addEventListener('input', () => {
        opts.onInputsChange({model: modelInput.value});
    });
    runBox.appendChild(modelInput);

    const modeSelect = document.createElement('select');
    const autoOption = document.createElement('option');
    autoOption.value = '';
    autoOption.textContent = 'executionMode: auto';
    modeSelect.appendChild(autoOption);
    for (const mode of ['program', 'react-baseline']) {
        const option = document.createElement('option');
        option.value = mode;
        option.textContent = mode;
        modeSelect.appendChild(option);
    }
    modeSelect.value = opts.inputs.executionMode;
    modeSelect.addEventListener('change', () => {
        opts.onInputsChange({executionMode: modeSelect.value});
    });
    runBox.appendChild(modeSelect);

    const runRow = document.createElement('div');
    runRow.className = 'row';
    runRow.appendChild(createButton('Start', () => opts.handlers.start(opts.inputs), true));
    runRow.appendChild(createButton('Refresh', () => opts.handlers.list()));
    runBox.appendChild(runRow);
    const listRow = document.createElement('div');
    listRow.className = 'row';
    listRow.appendChild(createButton('agent.sessions.list', () => opts.handlers.list()));
    listRow.appendChild(createButton('Clear View', () => { opts.handlers.clear(); }));
    runBox.appendChild(listRow);
    root.appendChild(runBox);

    if (opts.report) {
        root.appendChild(renderReport(opts.report, opts.handlers));
    }

    const listBox = section('Sessions');
    const prune = opts.handlers.prune;
    if (prune) {
        const maxCount = opts.pruneMaxCount ?? DEFAULT_PRUNE_MAX_COUNT;
        const pruneRow = document.createElement('div');
        pruneRow.className = 'row';
        pruneRow.appendChild(createButton('Prune', () => {
            // eslint-disable-next-line no-alert
            if (!window.confirm(`Delete all but the most recent ${String(maxCount)} settled sessions? This cannot be undone.`)) {return;}
            return prune(maxCount);
        }));
        listBox.appendChild(pruneRow);
    }
    const sessions = [...opts.sessions].sort((a, b) => b.createdAt - a.createdAt);
    if (sessions.length === 0) {
        listBox.appendChild(hint('No agent sessions.'));
    } else {
        sessions.forEach((session) => listBox.appendChild(renderSession(session, opts.handlers)));
    }
    root.appendChild(listBox);

    return root;
};