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
    AnnotateStage,
    AnnotateView,
    AutomationSaveState,
    BusinessArea,
    CommandPort,
    GuidanceMode,
    LibrarySummary,
    StartError,
    TeachKind,
    TeachView,
    WorkspaceProductView,
} from '../product/model/contracts.js';
import {
    isTerminalStatus,
    sanitizeActivityEvent,
    sanitizeReservationTeachKind,
    sanitizeReservationValue,
    sanitizeWorkspaceView,
} from '../product/model/projection.js';
import {
    ProductTransportError,
    type BackendEvent,
    type BackendTaskView,
    type BackendWorkspaceView,
    type ProductBackendClient,
} from '../shared/product_transport.js';

/** Coarse recorder state projected by the narrow checkpoint-recorder bridge. */
export type StructuredTeachSnapshot = {
    status: 'idle' | 'recording' | 'review';
    kind: TeachKind;
    stepCount: number;
    stepSummaries: string[];
    businessAreas: BusinessArea[];
    selectedSelector?: string;
};

/** Authoring action outcomes observed from the real recorder/annotator bridges. */
export type AuthoringActionNotice = {
    type: string;
    ok: boolean;
    payload?: Record<string, unknown>;
    reply?: Record<string, unknown>;
};

export type ProductAuthoringBridge = {
    beginStructuredTeach: (kind: 'procedure' | 'recovery', selector?: string) => void;
    stopStructuredTeach: () => void;
    saveStructuredTeach: () => void;
    discardStructuredTeach: () => void;
    readStructuredTeachState: () => Promise<StructuredTeachSnapshot | null>;
    startDemonstration: () => void;
    stopDemonstration: () => void;
    saveDemonstration: () => void;
    discardDemonstration: () => void;
    readDemonstrationState: () => Promise<{status: 'idle' | 'review'; stepCount: number} | null>;
    openAnnotator: (profileName?: string) => Promise<boolean>;
    closeAnnotator: () => void;
    /** Ends any linked (Task-owned) teach activity without touching the Task
     *  reservation: cancels an unsaved checkpoint recording and/or demo. */
    endLinkedTeach: () => void;
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
    /** Feeds one real recorder/annotator action outcome observed by the narrow
     *  content bridge into the authoring projection (never invented locally). */
    noteAuthoringAction(notice: AuthoringActionNotice): void;
    /** Truthful annotator canvas open/close signal from the existing session
     *  controller; never used to fabricate recording state. */
    noteAnnotateCanvas(open: boolean): void;
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

    type StandaloneAuthoring = {
        activity: 'teach' | 'annotate';
        teachKind?: TeachKind;
        recordingConfirmed: boolean;
        savedReference?: string;
        annotateCanvasOpen: boolean;
        annotateStage?: AnnotateStage;
        annotateDirty: boolean;
        annotateSavedSummary?: { profileName: string; entityCount?: number };
    };
    type LinkedAuthoring = {
        taskId: string;
        mode: 'teach' | 'annotate';
        toolLaunched: boolean;
        savedReference?: string;
    };

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
        authoring: StandaloneAuthoring | null;
        linked: LinkedAuthoring | null;
        library: LibrarySummary | undefined;
        libraryUnavailable: boolean;
        teachSnapshot: StructuredTeachSnapshot | null;
        teachPreview: boolean;
        demoReview: {stepCount: number} | null;
        automationSave: AutomationSaveState | undefined;
        currentTaskId: string | undefined;
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
        authoring: null,
        linked: null,
        library: undefined,
        libraryUnavailable: false,
        teachSnapshot: null,
        teachPreview: false,
        demoReview: null,
        automationSave: undefined,
        currentTaskId: undefined,
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

    const bridge = (): ProductAuthoringBridge | undefined => options.authoring;

    let libraryLoadedOnce = false;

    const resetAuthoringLocal = (): void => {
        state.authoring = null;
        state.teachSnapshot = null;
        state.demoReview = null;
    };

    const structuredKind = (kind: TeachKind | undefined): kind is 'procedure' | 'recovery' =>
        kind === 'procedure' || kind === 'recovery';

    const effectiveTeachKind = (authoring: StandaloneAuthoring): TeachKind | undefined =>
        authoring.teachKind
        ?? (state.teachSnapshot && state.teachSnapshot.status !== 'idle' ? state.teachSnapshot.kind : undefined)
        ?? (state.demoReview ? 'demonstration' : undefined);

    const buildTeachView = (): TeachView | undefined => {
        const authoring = state.authoring;
        if (!authoring && state.teachPreview && state.teachSnapshot) {
            const snapshot = state.teachSnapshot;
            return {
                teachKind: snapshot.kind,
                phase: 'setup',
                stepCount: 0,
                businessAreas: snapshot.businessAreas,
                unsavedAsset: false,
            };
        }
        if (authoring?.activity !== 'teach') {
            return undefined;
        }
        const teachKind = effectiveTeachKind(authoring);
        if (!teachKind) {
            return undefined;
        }
        if (structuredKind(teachKind)) {
            const snapshot = state.teachSnapshot;
            const phase: TeachView['phase'] = !snapshot || snapshot.status === 'idle'
                ? 'setup'
                : snapshot.status === 'recording'
                    ? 'recording'
                    : 'review';
            const stepSummaries = snapshot?.stepSummaries ?? [];
            return {
                teachKind,
                phase,
                stepCount: snapshot?.stepCount ?? 0,
                businessAreas: snapshot?.businessAreas ?? [],
                ...(snapshot?.selectedSelector ? {selectedBusinessArea: snapshot.selectedSelector} : {}),
                unsavedAsset: phase === 'recording' || phase === 'review',
                ...(phase === 'recording' && !authoring.recordingConfirmed ? {interrupted: true} : {}),
                ...(phase === 'review'
                    ? {
                        review: {
                            summary: `${String(snapshot?.stepCount ?? 0)} actions recorded`,
                            stepSummaries,
                            canSave: (snapshot?.stepCount ?? 0) > 0,
                        },
                    }
                    : {}),
            };
        }
        const phase: TeachView['phase'] = state.demoReview
            ? 'review'
            : authoring.recordingConfirmed
                ? 'recording'
                : 'setup';
        const stepCount = state.demoReview?.stepCount ?? 0;
        return {
            teachKind,
            phase,
            stepCount,
            businessAreas: [],
            unsavedAsset: phase === 'recording' || phase === 'review',
            ...(phase === 'review'
                ? {
                    review: {
                        summary: `${String(stepCount)} actions recorded`,
                        stepSummaries: [],
                        canSave: stepCount > 0,
                    },
                }
                : {}),
        };
    };

    const buildAnnotateView = (): AnnotateView | undefined => {
        const authoring = state.authoring;
        if (authoring?.activity !== 'annotate') {
            return undefined;
        }
        return {
            active: true,
            canvasOpen: authoring.annotateCanvasOpen,
            ...(authoring.annotateStage ? {stage: authoring.annotateStage} : {}),
            dirty: authoring.annotateDirty,
            ...(authoring.annotateSavedSummary ? {savedSummary: authoring.annotateSavedSummary} : {}),
        };
    };

    const fetchLibrary = async (): Promise<void> => {
        try {
            const raw = await client.librarySummary();
            const merged = sanitizeWorkspaceView({
                workspace: options.workspace,
                reservation: 'idle',
                librarySummary: raw,
            });
            state.library = merged.librarySummary;
            state.libraryUnavailable = false;
        } catch (error) {
            if (error instanceof ProductTransportError && error.code === 'not_found') {
                state.libraryUnavailable = true;
                return;
            }
            // Connectivity/other failures keep the last-known library untouched.
        }
    };

    const syncTeachSnapshot = async (): Promise<void> => {
        const authoring = state.authoring;
        if (authoring?.activity !== 'teach') {
            state.teachSnapshot = null;
            state.demoReview = null;
            return;
        }
        const kind = authoring.teachKind;
        if (kind === 'demonstration') {
            await syncDemonstrationSnapshot(authoring);
            return;
        }
        try {
            state.teachSnapshot = (await bridge()?.readStructuredTeachState()) ?? null;
        } catch {
            // Keep the last-known recorder snapshot; never invent one.
        }
        if (!kind && (!state.teachSnapshot || state.teachSnapshot.status === 'idle')) {
            await syncDemonstrationSnapshot(authoring);
        }
    };

    const syncDemonstrationSnapshot = async (authoring: StandaloneAuthoring): Promise<void> => {
        try {
            const demo = (await bridge()?.readDemonstrationState()) ?? null;
            if (demo?.status === 'review' && demo.stepCount > 0) {
                state.demoReview = { stepCount: demo.stepCount };
                return;
            }
            if (demo?.status === 'idle') {
                // The runtime reports nothing recorded (or capture is gone):
                // truthfully drop back to setup instead of a fake recording.
                authoring.recordingConfirmed = false;
                state.demoReview = null;
            }
        } catch {
            // Same: last-known only.
        }
    };

    /** Releases the standalone reservation for the finished activity. The
     *  outcome decides only whether the Library is re-observed afterwards. */
    const endAuthoringActivity = async (outcome: 'saved' | 'discarded'): Promise<void> => {
        resetAuthoringLocal();
        try {
            await client.endAuthoring(outcome);
            if (outcome === 'saved') {
                await fetchLibrary();
            }
        } catch (error) {
            if (error instanceof ProductTransportError && error.code === 'unreachable') {
                applyDisconnected();
                return;
            }
        }
        await syncOnce();
    };

    const handleAuthoringNotice = (notice: AuthoringActionNotice): void => {
        const { type, ok, payload, reply } = notice;
        const authoring = state.authoring;
        const linked = state.linked;
        if (!ok) {
            if ((type === 'record.start' || type === 'checkpoint.record.start')
                && authoring?.activity === 'teach') {
                const failure = isRecord(reply?.payload) ? reply.payload : {};
                setStartError('service', typeof failure.message === 'string' && failure.message
                    ? failure.message
                    : 'the recording service could not start the activity');
                void endAuthoringActivity('discarded');
            }
            return;
        }
        if (type === 'checkpoint.record.start' || type === 'record.start') {
            if (authoring?.activity === 'teach') {
                authoring.recordingConfirmed = true;
            }
            return;
        }
        if (type === 'checkpoint.record.stop') {
            if (authoring?.activity === 'teach' && structuredKind(authoring.teachKind)) {
                state.demoReview = null;
            }
            return;
        }
        if (type === 'record.stop') {
            if (authoring?.activity === 'teach' && authoring.teachKind === 'demonstration') {
                state.demoReview = { stepCount: typeof reply?.stepCount === 'number' ? reply.stepCount : 0 };
            }
            return;
        }
        if (type === 'checkpoint.record.save') {
            const kind = payload?.kind === 'recovery' ? 'recovery' : 'procedure';
            // The real reply is {saved, checkpointId, name, stepCount};
            // checkpointId is the stable artifact identity (the display name is
            // not used for linkage).
            const checkpointId = typeof reply?.checkpointId === 'string' ? reply.checkpointId : undefined;
            const savedReference = checkpointId ? `${kind}:${checkpointId}` : undefined;
            if (authoring?.activity === 'teach') {
                void endAuthoringActivity('saved');
            } else if (linked?.mode === 'teach') {
                linked.savedReference = savedReference;
            }
            return;
        }
        if (type === 'checkpoint.record.cancel') {
            if (authoring?.activity === 'teach') {
                void endAuthoringActivity('discarded');
            }
            return;
        }
        if (type === 'record.save') {
            if (authoring?.activity === 'teach') {
                void endAuthoringActivity('saved');
            } else if (linked?.mode === 'teach') {
                const name = typeof reply?.recordingName === 'string' ? reply.recordingName : undefined;
                linked.savedReference = name ? `demonstration:${name}` : 'demonstration';
            }
            return;
        }
        if (type === 'record.clear') {
            if (authoring?.activity === 'teach') {
                void endAuthoringActivity('discarded');
            }
            return;
        }
        if (type === 'entity_rules.annotator.open') {
            if (authoring?.activity === 'annotate') {
                authoring.annotateCanvasOpen = true;
                authoring.annotateStage = 'scope';
            }
            return;
        }
        if (type === 'entity_rules.annotator.pick') {
            if (authoring?.activity === 'annotate') {
                authoring.annotateStage = 'scope';
                authoring.annotateDirty = true;
            }
            return;
        }
        if (type === 'entity_rules.annotator.recognize') {
            if (authoring?.activity === 'annotate') {
                authoring.annotateStage = 'recognize';
            }
            return;
        }
        if (type === 'entity_rules.annotator.apply') {
            if (authoring?.activity === 'annotate') {
                authoring.annotateStage = 'edit';
                authoring.annotateDirty = true;
            }
            return;
        }
        if (type === 'entity_rules.annotator.check') {
            if (authoring?.activity === 'annotate') {
                authoring.annotateStage = 'review';
            }
            return;
        }
        if (type === 'entity_rules.annotator.save') {
            if (authoring?.activity === 'annotate' || linked?.mode === 'annotate') {
                // Real canvas-v1 protocol: the request carries `canvasDraft`
                // (no `draft`), and the authoritative saved identity is the
                // reply's `profileName`. entityCount only comes from the real
                // canvas draft when present; otherwise it stays unknown.
                const savedProfile = typeof reply?.profileName === 'string' ? reply.profileName : undefined;
                const canvasDraft = isRecord(payload?.canvasDraft) ? payload.canvasDraft : undefined;
                const entityCount = canvasDraft && Array.isArray(canvasDraft.entities)
                    ? canvasDraft.entities.length
                    : undefined;
                if (authoring?.activity === 'annotate') {
                    authoring.annotateDirty = false;
                    if (savedProfile) {
                        authoring.annotateSavedSummary = {
                            profileName: savedProfile,
                            ...(entityCount === undefined ? {} : { entityCount }),
                        };
                        authoring.savedReference = `page_knowledge:${savedProfile}`;
                    }
                }
                if (linked?.mode === 'annotate' && savedProfile) {
                    linked.savedReference = `page_knowledge:${savedProfile}`;
                }
            }
            return;
        }
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

    /** Requirement: linked guidance reuses the Task reservation and launches
     *  the existing human tool — it never acquires a second reservation. */
    const launchLinkedTool = (task: AgentTaskView): void => {
        const linked = state.linked;
        if (linked?.taskId !== task.taskId || linked.toolLaunched) {
            return;
        }
        const interaction = task.interaction;
        if (interaction?.kind !== 'takeover' || interaction.stage !== 'active') {
            return;
        }
        const activeMode = interaction.activeMode ?? state.tookMode?.mode;
        if (!activeMode) {
            return;
        }
        linked.toolLaunched = true;
        const authoring = bridge();
        if (!authoring) {
            return;
        }
        if (linked.mode === 'teach' && activeMode === 'teach') {
            const kind = interaction.teachKind === 'demonstration'
                ? 'demonstration'
                : interaction.teachKind === 'recovery'
                    ? 'recovery'
                    : 'procedure';
            if (kind === 'demonstration') {
                authoring.startDemonstration();
            } else {
                authoring.beginStructuredTeach(kind);
            }
            return;
        }
        if (linked.mode === 'annotate' && activeMode === 'annotate') {
            void authoring.openAnnotator();
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
            launchLinkedTool(sanitized.activeTask);
        }
        // The authoring projection is assembled from real bridge snapshots and
        // the standalone reservation; it is never a locally invented activity.
        const teach = buildTeachView();
        const annotate = buildAnnotateView();
        sanitized.authoring = teach || annotate
            ? { ...(teach ? { teach } : {}), ...(annotate ? { annotate } : {}) }
            : undefined;
        sanitized.libraryUnavailable = state.libraryUnavailable || undefined;
        if (state.library) {
            sanitized.librarySummary = state.library;
        }
        if (state.automationSave) {
            sanitized.automationSave = state.automationSave;
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

    /** Reservation-driven adoption: a reloaded surface takes over the backend
     *  reservation truthfully; when the backend no longer owns an authoring
     *  activity, the local activity state is cleared, never carried over. */
    const adoptReservation = (rawReservation: unknown): void => {
        const reservation = sanitizeReservationValue(rawReservation);
        const teachKind = sanitizeReservationTeachKind(rawReservation);
        if (reservation === 'teach') {
            if (state.authoring?.activity !== 'teach') {
                state.authoring = {
                    activity: 'teach',
                    ...(teachKind ? { teachKind } : {}),
                    recordingConfirmed: false,
                    annotateCanvasOpen: false,
                    annotateDirty: false,
                };
            } else if (!state.authoring.teachKind && teachKind) {
                state.authoring.teachKind = teachKind;
            }
        } else if (reservation === 'annotate') {
            if (state.authoring?.activity !== 'annotate') {
                state.authoring = {
                    activity: 'annotate',
                    recordingConfirmed: false,
                    annotateCanvasOpen: false,
                    annotateDirty: false,
                };
            }
        } else if (state.authoring) {
            resetAuthoringLocal();
        }
        if (reservation !== 'task') {
            state.linked = null;
        }
    };

    const syncOnce = async (): Promise<void> => {
        if (state.inFlight) {
            return;
        }
        state.inFlight = true;
        try {
            const rawWorkspace = await client.workspaceView();
            let rawActive = isRecord(rawWorkspace.activeTask) ? rawWorkspace.activeTask : undefined;
            if (rawActive && typeof rawActive.taskId === 'string') {
                state.currentTaskId = rawActive.taskId;
            } else if (state.currentTaskId) {
                try {
                    rawActive = await client.taskView(state.currentTaskId);
                } catch (error) {
                    if (error instanceof ProductTransportError && error.code === 'not_found') {
                        state.currentTaskId = undefined;
                    }
                }
            }
            if (rawActive) {
                await syncActiveTaskEvents(rawActive);
            }
            adoptReservation(rawWorkspace.reservation);
            if (state.authoring?.activity === 'teach') {
                await syncTeachSnapshot();
            }
            if (!libraryLoadedOnce && !state.libraryUnavailable) {
                libraryLoadedOnce = true;
                await fetchLibrary();
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
                        state.currentTaskId = taskId;
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
        pauseTask: () => {
            const task = state.view.activeTask;
            if (task?.status !== 'running') {return;}
            void (async () => {
                try {
                    await client.pauseTask(task.taskId);
                } catch (error) {
                    if (error instanceof ProductTransportError && error.code === 'unreachable') {
                        applyDisconnected();
                        return;
                    }
                }
                await syncOnce();
            })();
        },
        resumeTask: () => {
            const task = state.view.activeTask;
            if (task?.status !== 'paused') {return;}
            void (async () => {
                try {
                    await client.resumeTask(task.taskId);
                } catch (error) {
                    if (error instanceof ProductTransportError && error.code === 'unreachable') {
                        applyDisconnected();
                        return;
                    }
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
            if (mode === 'teach' || mode === 'annotate') {
                // Linked guidance reuses the Task reservation; it never begins
                // a standalone authoring activity.
                state.linked = { taskId: target.taskId, mode, toolLaunched: false };
            }
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
                const linked = state.linked;
                const authoring = options.authoring;
                if (linked?.taskId === taskId && authoring) {
                    if (linked.mode === 'teach') {
                        authoring.endLinkedTeach();
                    } else {
                        authoring.closeAnnotator();
                    }
                }
                const savedReference = linked?.taskId === taskId ? linked.savedReference : undefined;
                const updated = await client.returnControl(taskId, token, mode, savedReference);
                state.tookMode = null;
                state.linked = null;
                return updated;
            });
        },
        reconnect: () => {
            state.failures = 0;
            void syncOnce();
        },
        openTeach: () => {
            void (async () => {
                state.teachPreview = true;
                try {
                    const snapshot = await bridge()?.readStructuredTeachState();
                    if (snapshot) {state.teachSnapshot = snapshot;}
                } catch {
                    // The surface simply shows no areas; nothing is invented.
                }
                await syncOnce();
            })();
        },
        openAnnotate: () => {
            const authoring = state.authoring;
            if (authoring?.activity === 'annotate') {
                void (async () => {
                    const opened = await options.authoring?.openAnnotator();
                    if (opened) {
                        authoring.annotateCanvasOpen = true;
                    }
                    await syncOnce();
                })();
                return;
            }
            void beginStandalone({ activity: 'annotate' });
        },
        closeAnnotate: () => {
            if (state.authoring?.activity !== 'annotate') {
                return;
            }
            void (async () => {
                options.authoring?.closeAnnotator();
                await endAuthoringActivity(state.authoring?.savedReference ? 'saved' : 'discarded');
            })();
        },
        openCurrentActivity: () => {
            const authoring = state.authoring;
            if (authoring?.activity === 'annotate' && !authoring.annotateCanvasOpen) {
                void options.authoring?.openAnnotator();
            }
        },
        startTeach: (kind, businessArea) => {
            void beginStandalone(
                kind === 'demonstration'
                    ? { activity: 'teach', teachKind: 'demonstration' }
                    : { activity: 'teach', teachKind: kind },
                kind === 'demonstration' ? undefined : businessArea,
            );
        },
        stopTeach: () => {
            const authoring = state.authoring;
            if (authoring?.activity !== 'teach') {
                return;
            }
            if (structuredKind(authoring.teachKind ?? state.teachSnapshot?.kind)) {
                options.authoring?.stopStructuredTeach();
            } else {
                options.authoring?.stopDemonstration();
            }
            void syncOnce();
        },
        saveTeach: () => {
            const authoring = state.authoring;
            if (authoring?.activity !== 'teach') {
                return;
            }
            if (structuredKind(authoring.teachKind ?? state.teachSnapshot?.kind)) {
                options.authoring?.saveStructuredTeach();
            } else {
                options.authoring?.saveDemonstration();
            }
            void syncOnce();
        },
        discardTeach: () => {
            const authoring = state.authoring;
            if (authoring?.activity !== 'teach') {
                return;
            }
            const structured = structuredKind(authoring.teachKind ?? state.teachSnapshot?.kind);
            const unsaved = state.view.authoring?.teach?.unsavedAsset === true;
            if (structured) {
                options.authoring?.discardStructuredTeach();
            } else {
                options.authoring?.discardDemonstration();
            }
            if (!unsaved) {
                // Nothing was recorded (setup phase): the tool's cancel is a
                // no-op on the backend, so release the reservation directly.
                void endAuthoringActivity('discarded');
                return;
            }
            void syncOnce();
        },
        newTask: () => {
            state.automationSave = undefined;
            state.currentTaskId = undefined;
            state.startError = undefined;
            state.view = {...state.view, activeTask: undefined, automationSave: undefined, startError: undefined};
            emit();
        },
        saveAutomation: (name) => {
            const task = state.view.activeTask;
            const cleanName = name.trim();
            if (task?.status !== 'completed' || task.result?.saveEligible !== true || !cleanName) {return;}
            state.automationSave = {status: 'saving', name: cleanName};
            state.view = {...state.view, automationSave: state.automationSave};
            emit();
            void (async () => {
                try {
                    const saved = await client.saveAutomation(task.taskId, cleanName);
                    state.automationSave = saved.saved
                        ? {status: 'saved', name: saved.name}
                        : {status: 'conflict', name: saved.name, message: 'An automation with this name already exists.'};
                    if (saved.saved) {await fetchLibrary();}
                } catch (error) {
                    state.automationSave = {
                        status: 'failed',
                        name: cleanName,
                        message: error instanceof Error ? error.message : 'Saving failed.',
                    };
                }
                await syncOnce();
            })();
        },
        editPageKnowledge: (ref) => {
            void beginStandalone({ activity: 'annotate' }, undefined, ref.profileName);
        },
        navigate: () => undefined,
        collapse: () => undefined,
        openDeveloper: () => undefined,
        closeDeveloper: () => undefined,
        resize: () => undefined,
    };

    /** Begins a standalone authoring activity: the backend reservation first,
     *  then the existing human tool. Conflicts are surfaced, never queued. */
    const beginStandalone = async (
        input: {activity: 'annotate'} | {activity: 'teach'; teachKind: TeachKind},
        selector?: string,
        profileName?: string,
    ): Promise<void> => {
        if (state.view.reservation !== 'idle' || state.authoring) {
            setStartError('workspace', 'this workspace is already in use by another activity');
            return;
        }
        const authoring = options.authoring;
        if (!authoring) {
            setStartError('service', 'authoring tools are not available on this page');
            return;
        }
        try {
            await client.beginAuthoring(input);
        } catch (error) {
            setStartError(startErrorFor(error).kind, error instanceof Error ? error.message : String(error));
            await syncOnce();
            return;
        }
        state.startError = undefined;
        state.authoring = input.activity === 'teach'
            ? {
                activity: 'teach',
                teachKind: input.teachKind,
                // Nothing is "recording" until the real record.start succeeds;
                // the observed notice flips this flag, never the reservation.
                recordingConfirmed: false,
                annotateCanvasOpen: false,
                annotateDirty: false,
            }
            : { activity: 'annotate', recordingConfirmed: false, annotateCanvasOpen: false, annotateDirty: false };
        if (input.activity === 'teach') {
            try {
                if (input.teachKind === 'demonstration') {
                    authoring.startDemonstration();
                } else {
                    authoring.beginStructuredTeach(input.teachKind, selector);
                }
            } catch (error) {
                setStartError(startErrorFor(error).kind, error instanceof Error ? error.message : String(error));
                await endAuthoringActivity('discarded');
                return;
            }
            await syncOnce();
            return;
        }
        const opened = await authoring.openAnnotator(profileName).catch(() => false);
        if (!opened) {
            setStartError('service', 'the annotator could not be opened on this page');
            await endAuthoringActivity('discarded');
            return;
        }
        state.authoring.annotateCanvasOpen = true;
        await syncOnce();
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
        noteAuthoringAction: (notice) => {
            handleAuthoringNotice(notice);
            void syncOnce();
        },
        noteAnnotateCanvas: (open) => {
            const authoring = state.authoring;
            if (authoring?.activity === 'annotate') {
                authoring.annotateCanvasOpen = open;
                if (!open) {
                    authoring.annotateStage = undefined;
                }
            }
            void syncOnce();
        },
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