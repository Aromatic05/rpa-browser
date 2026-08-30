/**
 * Product controller — the adapter between the real `/agent/product` backend
 * (via a `ProductBackendClient`) and the typed product surfaces. It maintains
 * the sanitized `WorkspaceProductView` (last-known projection is preserved when
 * the service is unreachable), owns the bounded event-cursor sync, and is the
 * only component that maps user intents onto backend commands. Components never
 * see raw request verbs or task/session/run identities.
 */
import type {
    ActivityEvent,
    AgentTaskView,
    CommandPort,
    GuidanceMode,
    StartError,
    TeachKind,
    WorkspaceProductView,
} from '../product/model/contracts.js';
import { isTerminalStatus, sanitizeActivityEvent, sanitizeWorkspaceView } from '../product/model/projection.js';
import {
    ProductTransportError,
    type BackendEvent,
    type BackendTaskView,
    type BackendWorkspaceView,
    type ProductBackendClient,
} from '../shared/product_transport.js';

export type ProductAuthoringBridge = {
    openAnnotator?: (profileName?: string) => unknown;
    closeAnnotator?: () => unknown;
    startTeach?: (kind: TeachKind, businessArea?: string) => unknown;
    stopTeach?: () => unknown;
    saveTeach?: () => unknown;
    discardTeach?: () => unknown;
};

export type ProductControllerOptions = {
    client: ProductBackendClient;
    workspace: string;
    now?: () => number;
    /** Refresh cadence while a task is active (conservative, event-driven). */
    pollIntervalMs?: number;
    /** Slow housekeeping cadence while idle. */
    idlePollIntervalMs?: number;
    /** Backoff between automatic reconnect attempts while offline. */
    offlineRetryMs?: number;
    /** Bounded automatic reconnects before a manual Retry is required. */
    maxAutoReconnects?: number;
    authoring?: ProductAuthoringBridge;
};

export type ProductControllerHandle = {
    getView(): WorkspaceProductView;
    subscribe(handler: (view: WorkspaceProductView) => void): () => void;
    commands: CommandPort;
    start(): void;
    stop(): void;
    /** One authoritative sync + event cursor pass. Exposed for tests/integration. */
    refresh(): Promise<void>;
};

const emptyLibrary = (): WorkspaceProductView['librarySummary'] => ({
    automations: [],
    procedures: [],
    recoveries: [],
    demonstrations: [],
    pageKnowledge: [],
});

const TERMINAL_STATUSES = new Set<string>(['completed', 'failed', 'cancelled', 'interrupted']);

const toHistoryEntry = (view: BackendTaskView): Record<string, unknown> => ({
    taskId: view.taskId,
    outcome: view.status,
    title: view.title,
    endedAt: typeof view.endedAt === 'number' ? view.endedAt : 0,
});

export const createProductController = (options: ProductControllerOptions): ProductControllerHandle => {
    const client = options.client;
    const now = options.now ?? (() => Date.now());
    const pollIntervalMs = options.pollIntervalMs ?? 1500;
    const idlePollIntervalMs = options.idlePollIntervalMs ?? 8000;
    const offlineRetryMs = options.offlineRetryMs ?? 5000;
    const maxAutoReconnects = options.maxAutoReconnects ?? 3;

    const state: {
        view: WorkspaceProductView;
        timelines: Map<string, ActivityEvent[]>;
        lastSeq: Map<string, number>;
        tookMode: { taskId: string; mode: GuidanceMode } | null;
        startError: StartError | undefined;
        timer: ReturnType<typeof setTimeout> | null;
        running: boolean;
        failures: number;
        inFlight: boolean;
    } = {
        view: {
            workspace: options.workspace,
            reservation: 'idle',
            connection: 'disconnected',
            librarySummary: emptyLibrary(),
            history: [],
            reconnectAttempts: 0,
        },
        timelines: new Map(),
        lastSeq: new Map(),
        tookMode: null,
        startError: undefined,
        timer: null,
        running: false,
        failures: 0,
        inFlight: false,
    };

    const listeners = new Set<(view: WorkspaceProductView) => void>();
    const emit = (): void => {
        const snapshot = state.view;
        for (const listener of listeners) {
            listener(snapshot);
        }
    };

    const isOffline = (): boolean => state.view.connection !== 'connected';
    const hasActiveWork = (): boolean =>
        Boolean(state.view.activeTask && !isTerminalStatus(state.view.activeTask.status));

    const setStartError = (kind: StartError['kind'], message: string): void => {
        state.startError = { kind, message };
        state.view = { ...state.view, startError: state.startError };
        emit();
    };

    const startErrorFor = (error: unknown): StartError => {
        if (error instanceof ProductTransportError) {
            if (error.code === 'auth') {
                return { kind: 'auth', message: error.message };
            }
            if (error.code === 'conflict') {
                return { kind: 'workspace', message: error.message };
            }
            return { kind: 'service', message: error.message };
        }
        return { kind: 'service', message: error instanceof Error ? error.message : String(error) };
    };

    const syncActiveTaskEvents = async (rawTask: BackendTaskView): Promise<void> => {
        const taskId = typeof rawTask.taskId === 'string' ? rawTask.taskId : '';
        if (!taskId) {
            return;
        }
        if (!state.timelines.has(taskId) || !state.lastSeq.has(taskId)) {
            try {
                const full = await client.events(taskId, 0);
                state.lastSeq.set(taskId, full.nextSeq);
                state.timelines.set(taskId, sanitizeEvents(full.events));
            } catch {
                state.timelines.set(taskId, []);
                state.lastSeq.set(taskId, typeof rawTask.lastSeq === 'number' ? rawTask.lastSeq : 0);
            }
            return;
        }
        const after = state.lastSeq.get(taskId) ?? 0;
        try {
            const response = await client.events(taskId, after);
            if (response.gap) {
                const rebuilt = await client.events(taskId, 0);
                state.lastSeq.set(taskId, rebuilt.nextSeq);
                state.timelines.set(taskId, sanitizeEvents(rebuilt.events));
                return;
            }
            if (response.events.length > 0) {
                const existing = state.timelines.get(taskId) ?? [];
                state.timelines.set(taskId, [...existing, ...sanitizeEvents(response.events)]);
                state.lastSeq.set(taskId, response.nextSeq);
            }
        } catch {
            // The next full sync refreshes the authoritative task projection.
        }
    };

    const applyTookMode = (task: AgentTaskView): void => {
        const interaction = task.interaction;
        const active = interaction?.kind === 'takeover' && interaction.stage === 'active';
        if (!active) {
            if (state.tookMode?.taskId === task.taskId) {
                state.tookMode = null;
            }
            return;
        }
        if (interaction.activeMode || state.tookMode?.taskId !== task.taskId) {
            return;
        }
        if (interaction.guidanceModes.includes(state.tookMode.mode)) {
            interaction.activeMode = state.tookMode.mode;
        }
    };

    const applyConnected = (
        rawWorkspace: BackendWorkspaceView,
        rawActive: Record<string, unknown> | undefined,
        historyRaw: unknown[] | undefined,
    ): void => {
        const taskId = isRecord(rawActive) && typeof rawActive.taskId === 'string' ? rawActive.taskId : undefined;
        const record = {
            workspace: rawWorkspace.workspace,
            reservation: rawWorkspace.reservation,
            ...(taskId ? { activeTask: rawActive } : {}),
            history: historyRaw ?? [],
            connection: 'connected',
            reconnectAttempts: 0,
            lastKnownAt: now(),
            ...(state.startError ? { startError: state.startError } : {}),
        };
        const sanitized = sanitizeWorkspaceView(record);
        if (sanitized.activeTask) {
            const targetTaskId = taskId ?? sanitized.activeTask.taskId;
            sanitized.activeTask.timeline = state.timelines.get(targetTaskId) ?? [];
            applyTookMode(sanitized.activeTask);
        }
        // A workspace-conflict start error is only truthful while the workspace
        // is still occupied; clear it as soon as the projection returns to idle.
        if (
            state.startError?.kind === 'workspace'
            && sanitized.reservation === 'idle'
            && sanitized.activeTask === undefined
        ) {
            state.startError = undefined;
        }
        if (state.startError) {
            sanitized.startError = state.startError;
        }
        state.failures = 0;
        state.view = sanitized;
        emit();
        scheduleNext();
    };

    const applyDisconnected = (): void => {
        state.failures += 1;
        state.view = {
            ...state.view,
            connection: 'disconnected',
            lastKnownAt: now(),
            reconnectAttempts: state.failures,
        };
        emit();
        scheduleNext();
    };

    const scheduleNext = (): void => {
        if (!state.running) {
            return;
        }
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        if (isOffline()) {
            if (state.failures >= maxAutoReconnects) {
                return; // bounded automatic attempts exhausted; manual Retry only
            }
            state.timer = setTimeout(() => { void syncOnce(); }, offlineRetryMs);
            return;
        }
        state.timer = setTimeout(
            () => { void syncOnce(); },
            hasActiveWork() ? pollIntervalMs : idlePollIntervalMs,
        );
    };

    const syncOnce = async (): Promise<void> => {
        if (state.inFlight) {
            return;
        }
        state.inFlight = true;
        try {
            const rawWorkspace = await client.workspaceView();
            const rawActive = isRecord(rawWorkspace.activeTask) ? rawWorkspace.activeTask : undefined;
            if (rawActive) {
                await syncActiveTaskEvents(rawActive);
            }
            let historyRaw: unknown[] | undefined;
            // History only changes at terminal boundaries; skip the extra list
            // call while a non-terminal task actively runs.
            const rawStatus = rawActive && typeof rawActive.status === 'string' ? rawActive.status : '';
            const terminal = rawActive ? TERMINAL_STATUSES.has(rawStatus) : false;
            if (!rawActive || terminal) {
                try {
                    const listed = await client.listTasks();
                    historyRaw = listed.history.map(toHistoryEntry);
                } catch {
                    historyRaw = undefined;
                }
            }
            applyConnected(rawWorkspace, rawActive, historyRaw);
        } catch (error) {
            if (error instanceof ProductTransportError && error.code === 'unreachable') {
                applyDisconnected();
            } else {
                // Non-connectivity failure: keep the last-known projection
                // unchanged; never fabricate an empty connected view.
                state.view = { ...state.view, lastKnownAt: now() };
                emit();
            }
        } finally {
            state.inFlight = false;
        }
    };

    const activeInteraction = (): { taskId: string; token: string } | null => {
        const task = state.view.activeTask;
        const interaction = task?.interaction;
        if (!task || !interaction) {
            return null;
        }
        return { taskId: task.taskId, token: interaction.interactionToken };
    };

    const decide = async (run: (target: { taskId: string; token: string }) => Promise<BackendTaskView>): Promise<void> => {
        const target = activeInteraction();
        if (!target) {
            return;
        }
        try {
            await run(target);
            await syncOnce();
        } catch (error) {
            if (error instanceof ProductTransportError && error.code === 'unreachable') {
                applyDisconnected();
                return;
            }
            if (error instanceof ProductTransportError && error.code === 'stale') {
                // The token no longer matches the current interaction: refresh the
                // authoritative projection and never auto-retry a stale resolution.
                await syncOnce();
                return;
            }
            await syncOnce().catch(() => undefined);
        }
    };

    const commands: CommandPort = {
        startTask: (prompt) => {
            const value = prompt.trim();
            if (value.length === 0) {
                return;
            }
            void (async () => {
                try {
                    const rawTask = await client.startTask(value);
                    const taskId = typeof rawTask.taskId === 'string' ? rawTask.taskId : '';
                    if (taskId) {
                        state.timelines.set(taskId, []);
                        state.lastSeq.set(
                            taskId,
                            typeof rawTask.lastSeq === 'number' ? rawTask.lastSeq : 0,
                        );
                    }
                    state.startError = undefined;
                } catch (error) {
                    setStartError(startErrorFor(error).kind, error instanceof Error ? error.message : String(error));
                }
                await syncOnce();
            })();
        },
        stopTask: () => {
            const task = state.view.activeTask;
            if (!task) {
                return;
            }
            void (async () => {
                try {
                    await client.stopTask(task.taskId);
                } catch (error) {
                    if (error instanceof ProductTransportError && error.code === 'unreachable') {
                        applyDisconnected();
                        return;
                    }
                }
                await syncOnce();
            })();
        },
        approve: () => {
            void decide(({ taskId, token }) => client.approve(taskId, token));
        },
        deny: (reason, requestedAlternative) => {
            if (!reason.trim()) {
                return; // deny requires a reason (enforced by the surface too)
            }
            void decide(({ taskId, token }) =>
                client.deny(taskId, token, reason.trim(), requestedAlternative?.trim()),
            );
        },
        answerClarification: (value) => {
            void decide(({ taskId, token }) => client.answer(taskId, token, value));
        },
        chooseRecovery: (optionId) => {
            void decide(({ taskId, token }) => client.chooseRecovery(taskId, token, optionId));
        },
        beginHumanGuidance: (mode) => {
            const target = activeInteraction();
            if (!target) {
                return;
            }
            state.tookMode = { taskId: target.taskId, mode };
            void decide(({ taskId, token }) => client.beginGuidance(taskId, token, mode));
        },
        returnControl: () => {
            const task = state.view.activeTask;
            const interaction = task?.interaction;
            if (interaction?.kind !== 'takeover') {
                return;
            }
            const mode = interaction.activeMode ?? 'manual';
            void decide(async ({ taskId, token }) => {
                const updated = await client.returnControl(taskId, token, mode);
                state.tookMode = null;
                return updated;
            });
        },
        reconnect: () => {
            state.failures = 0;
            void syncOnce();
        },
        openTeach: () => undefined,
        openAnnotate: () => {
            options.authoring?.openAnnotator?.();
        },
        closeAnnotate: () => {
            options.authoring?.closeAnnotator?.();
        },
        openCurrentActivity: () => undefined,
        startTeach: (kind, businessArea) => {
            options.authoring?.startTeach?.(kind, businessArea);
        },
        stopTeach: () => {
            options.authoring?.stopTeach?.();
        },
        saveTeach: () => {
            options.authoring?.saveTeach?.();
        },
        discardTeach: () => {
            options.authoring?.discardTeach?.();
        },
        newTask: () => {
            state.startError = undefined;
            state.view = { ...state.view, startError: undefined };
            emit();
        },
        retry: () => undefined,
        saveAutomation: () => undefined,
        viewDetails: () => undefined,
        replayDemonstration: () => undefined,
        editPageKnowledge: () => undefined,
        selectHistoryEntry: () => undefined,
        navigate: () => undefined,
        collapse: () => undefined,
        openDeveloper: () => undefined,
        closeDeveloper: () => undefined,
        resize: () => undefined,
    };

    const start = (): void => {
        if (state.running) {
            return;
        }
        state.running = true;
        void syncOnce();
    };

    const stop = (): void => {
        state.running = false;
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        listeners.clear();
    };

    return {
        getView: () => state.view,
        subscribe: (handler) => {
            listeners.add(handler);
            return () => {
                listeners.delete(handler);
            };
        },
        commands,
        start,
        stop,
        refresh: syncOnce,
    };
};

const sanitizeEvents = (events: readonly BackendEvent[]): ActivityEvent[] => {
    const sanitized: ActivityEvent[] = [];
    for (const event of events) {
        const item = sanitizeActivityEvent(event);
        if (item) {
            sanitized.push(item);
        }
    }
    return sanitized;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);