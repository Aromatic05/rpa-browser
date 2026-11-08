/**
 * Product model contracts: the typed projection and command boundary for the
 * task-centric product UI. Pure types only — no runtime logic.
 *
 * Authority: docs/Architecture/AgentProductUI.md and
 * docs/Architecture/AgentProductInteraction.md. The product surface consumes a
 * sanitized `WorkspaceProductView` projection and emits typed product intents
 * through a `CommandPort`. No raw RPC names, session/run/continuation ids,
 * provider/model/executionMode, or internal action names appear in this layer.
 */

export type WorkspaceReservation = 'idle' | 'task' | 'teach' | 'annotate' | 'playback';

export type ConnectionState = 'connected' | 'disconnected';

export type ProductSurface = 'home' | 'task' | 'library' | 'history' | 'teach' | 'annotate' | 'developer';

export type TaskLifecycleStatus =
    | 'draft'
    | 'running'
    | 'paused'
    | 'waiting_for_user'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

export type TaskPhase = 'planning' | 'observing' | 'executing' | 'recovering' | 'interacting';

export type TaskOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type TeachKind = 'procedure' | 'recovery' | 'demonstration';

export type TeachPhase = 'setup' | 'recording' | 'review' | 'saving';

export type AnnotateStage = 'scope' | 'recognize' | 'review' | 'edit';

/** Real Library dependency-health vocabulary; never fabricated. */
export type LibraryHealth = 'ready' | 'needs_review' | 'broken' | 'unknown';

export type GuidanceMode = 'manual' | 'teach' | 'annotate';

export type StartErrorKind = 'service' | 'auth' | 'workspace';

export type StartError = {
    kind: StartErrorKind;
    message: string;
};

/** Sanitized observable task activity (AgentProductInteraction §12.2). */
export type ActivityEvent =
    | { kind: 'task_created'; summary: string; at: number }
    | { kind: 'phase_changed'; phase: TaskPhase; at: number }
    | { kind: 'activity'; summary: string; at: number }
    | { kind: 'interaction_requested'; summary: string; at: number }
    | { kind: 'interaction_resolved'; summary: string; at: number }
    | { kind: 'human_guidance_started'; mode: GuidanceMode; summary: string; at: number }
    | {
          kind: 'human_guidance_completed';
          mode: GuidanceMode;
          summary: string;
          /** Sanitized saved-asset kind/ref only (spec §12.2); no ids or bodies. */
          savedAssetKind?: string;
          savedAssetRef?: string;
          at: number;
      }
    | { kind: 'effect_applied'; summary: string; status: 'ok' | 'failed'; at: number }
    | { kind: 'world_conflict'; summary: string; at: number }
    | { kind: 'task_terminated'; outcome: TaskOutcome; at: number }
    | { kind: 'report_ready'; at: number };

/** Bounded clarification input schema (AgentProductInteraction §6). */
export type ClarificationSchema = {
    field: string;
    type: 'text' | 'number' | 'date' | 'select';
    allowed?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
    maxLength?: number;
    default?: string;
};

/** Recovery option exactly as the backend assessment supplied it (spec §7.3). */
export type RecoveryOption = {
    id: string;
    kind: 'retry' | 'repair' | 'rollback' | 'rewind' | 'terminate';
    label: string;
    eligible: boolean;
    block?: string;
};

export type InteractionRequest =
    | {
          kind: 'approval';
          interactionToken: string;
          effectName: string;
          risk: string;
          evidence?: string;
          details?: string[];
      }
    | {
          kind: 'clarification';
          interactionToken: string;
          question: string;
          schema: ClarificationSchema;
      }
    | {
          kind: 'recovery_decision';
          interactionToken: string;
          failureSummary: string;
          evidence?: string;
          details?: string[];
          options: RecoveryOption[];
          recommendedOptionId?: string;
      }
    | {
          kind: 'takeover';
          interactionToken: string;
          reason: string;
          scope: 'workspace' | 'tab';
          guidanceModes: GuidanceMode[];
          /** Backend-declared stage; `active` means human control was taken. */
          stage?: 'offered' | 'active';
          activeMode?: GuidanceMode;
          teachKind?: TeachKind;
      };

export type TaskResultView = {
    outcome: TaskOutcome;
    output?: string;
    errorMessage?: string;
    effectsCount: number;
    reportAvailable: boolean;
    saveEligible: boolean;
    recoverySummary?: string;
};

export type AutomationSaveState = {
    status: 'saving' | 'saved' | 'conflict' | 'failed';
    name: string;
    message?: string;
};

/** Sanitized AgentTaskView (AgentProductInteraction §12.1). */
export type AgentTaskView = {
    taskId: string;
    status: TaskLifecycleStatus;
    phase?: TaskPhase;
    interaction?: InteractionRequest;
    title: string;
    promptSummary: string;
    timeline: ActivityEvent[];
    result?: TaskResultView;
    error?: { code?: string; message: string };
    reportAvailable: boolean;
    resumable: boolean;
    devOverride?: { model?: string; executionMode?: string };
};

export type BusinessArea = {
    profileName: string;
    label: string;
    entityCount: number;
    /** Opaque recorder-entity selector (`profileName` + business tag); never
     *  rendered and never an internal checkpoint/session id. */
    selector?: string;
};

/** Sanitized structured Teach projection (AgentProductInteraction §12.1). */
export type TeachView = {
    teachKind: TeachKind;
    phase: TeachPhase;
    stepCount: number;
    businessAreas: BusinessArea[];
    selectedBusinessArea?: string;
    unsavedAsset: boolean;
    /** Truthful reload semantics: the recording service still reports an
     *  active recording the page cannot re-arm — offer Stop & Review/Discard,
     *  never a fake continuing recording. */
    interrupted?: boolean;
    review?: {
        summary: string;
        stepSummaries: string[];
        canSave: boolean;
    };
};

export type AnnotateView = {
    /** The standalone Annotate activity is owned (reservation held). */
    active: boolean;
    /** The existing Annotator Canvas is currently open for this activity. */
    canvasOpen: boolean;
    stage?: AnnotateStage;
    dirty: boolean;
    savedSummary?: { profileName: string; entityCount?: number };
};

export type AutomationSummary = { name: string; description?: string; status?: string; health?: LibraryHealth };

export type ProcedureSummary = { name: string; health?: LibraryHealth };

export type RecoverySummary = { name: string; health?: LibraryHealth };

export type DemonstrationSummary = { name: string; stepCount: number; health?: LibraryHealth };

export type PageKnowledgeSummary = {
    profileName: string;
    label: string;
    pageKind?: string;
    urlPattern?: string;
    entityCount: number;
    health?: LibraryHealth;
};

export type LibrarySummary = {
    automations: AutomationSummary[];
    procedures: ProcedureSummary[];
    recoveries: RecoverySummary[];
    demonstrations: DemonstrationSummary[];
    pageKnowledge: PageKnowledgeSummary[];
};

export type TaskHistoryEntry = {
    taskId: string;
    outcome: TaskOutcome;
    title: string;
    endedAt: number;
};

/**
 * Authoritative workspace projection consumed by the product shell
 * (AgentProductInteraction §12.1). Fields are already sanitized; the UI never
 * renders internal ids or raw artifact bodies from it.
 */
export type WorkspaceProductView = {
    workspace: string;
    /** Explicit false means first-run model setup is still required. Missing is
     * accepted for compatibility with older/test projections. */
    modelConfigured?: boolean;
    reservation: WorkspaceReservation;
    /** Coarse Teach kind while a standalone Teach owns the reservation; lets a
     *  reloaded surface adopt the activity truthfully instead of guessing. */
    reservationTeachKind?: TeachKind;
    connection: ConnectionState;
    activeTask?: AgentTaskView;
    playbackAvailable?: boolean;
    playback?: {
        phase: 'running' | 'completed' | 'failed' | 'canceled';
        recordingName?: string;
        completed: number;
        total: number;
        failure?: {index?: number; code?: string; fallbackConflict?: boolean};
    };
    playbackPending?: boolean;
    playbackError?: string;
    authoring?: { teach?: TeachView; annotate?: AnnotateView };
    librarySummary: LibrarySummary;
    /** True when the backend reports no real Library projection is available;
     *  the surface must say so instead of rendering an empty-but-complete look. */
    libraryUnavailable?: boolean;
    history: TaskHistoryEntry[];
    automationSave?: AutomationSaveState;
    startError?: StartError;
    reconnectAttempts?: number;
    lastKnownAt?: number;
};

export type PageKnowledgeRef = { profileName: string };

/**
 * Typed product intents. Components emit these and nothing else; the controller
 * is the only place that knows raw RPC names (spec §16).
 */
export type CommandPort = {
    replayDemonstration(name: string): void;
    stopPlayback(): void;
    startTask(prompt: string): void;
    pauseTask(): void;
    resumeTask(): void;
    stopTask(): void;
    openTeach(): void;
    openAnnotate(): void;
    closeAnnotate(): void;
    openCurrentActivity(): void;
    startTeach(kind: TeachKind, businessArea?: string): void;
    stopTeach(): void;
    saveTeach(name?: string): void;
    discardTeach(): void;
    newTask(): void;
    saveAutomation(name: string): void;
    editPageKnowledge(ref: PageKnowledgeRef): void;
    approve(): void;
    deny(reason: string, requestedAlternative?: string): void;
    answerClarification(value: string): void;
    chooseRecovery(optionId: string): void;
    beginHumanGuidance(mode: GuidanceMode): void;
    returnControl(): void;
    reconnect(): void;
    navigate(surface: ProductSurface): void;
    collapse(): void;
    openDeveloper(): void;
    closeDeveloper(): void;
    resize(width: number): void;
};
