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
};

export type AgentSessionViewOptions = {
    sessions: readonly AgentSessionSummary[];
    inputs: AgentSessionInputs;
    onInputsChange: (patch: Partial<AgentSessionInputs>) => void;
    handlers: AgentSessionHandlers;
};

const AGENT_SESSION_STATES: readonly AgentSessionState[] = ['running', 'paused', 'completed', 'failed', 'cancelled'];

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

    const head = document.createElement('div');
    head.className = 'hint';
    const mode = session.request.executionMode ? ` · ${session.request.executionMode}` : '';
    head.textContent = `[${STATE_LABELS[session.state]}] ${session.request.model || session.request.provider || session.sessionId}${mode}`;
    item.appendChild(head);

    if (session.state === 'running') {
        const controlsRow = document.createElement('div');
        controlsRow.className = 'row';
        controlsRow.appendChild(createButton('Status', () => { handlers.status(session.sessionId); }));
        controlsRow.appendChild(createButton('Cancel', () => { handlers.cancel(session.sessionId); }));
        item.appendChild(controlsRow);
    }
    if (session.state === 'paused') {
        item.appendChild(hint('Paused — resume/approve is not available in this service.'));
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
    return item;
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

    const listBox = section('Sessions');
    const sessions = [...opts.sessions].sort((a, b) => b.createdAt - a.createdAt);
    if (sessions.length === 0) {
        listBox.appendChild(hint('No agent sessions.'));
    } else {
        sessions.forEach((session) => listBox.appendChild(renderSession(session, opts.handlers)));
    }
    root.appendChild(listBox);

    return root;
};