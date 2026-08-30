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
    | { kind: 'human_guidance_completed'; mode: GuidanceMode; summary: string; at: number }
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
          activeMode?: GuidanceMode;
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
};

/** Sanitized structured Teach projection (AgentProductInteraction §12.1). */
export type TeachView = {
    teachKind: TeachKind;
    phase: TeachPhase;
    stepCount: number;
    businessAreas: BusinessArea[];
    selectedBusinessArea?: string;
    unsavedAsset: boolean;
    review?: {
        summary: string;
        stepSummaries: string[];
        canSave: boolean;
    };
};

export type AnnotateView = {
    active: boolean;
    stage?: AnnotateStage;
    dirty: boolean;
    savedSummary?: { profileName: string; entityCount: number };
};

export type AutomationSummary = { name: string; description?: string; status?: string };

export type ProcedureSummary = { name: string };

export type RecoverySummary = { name: string };

export type DemonstrationSummary = { name: string; stepCount: number };

export type PageKnowledgeSummary = {
    profileName: string;
    label: string;
    pageKind?: string;
    urlPattern?: string;
    entityCount: number;
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
    reservation: WorkspaceReservation;
    connection: ConnectionState;
    activeTask?: AgentTaskView;
    authoring?: { teach?: TeachView; annotate?: AnnotateView };
    librarySummary: LibrarySummary;
    history: TaskHistoryEntry[];
    startError?: StartError;
    reconnectAttempts?: number;
    lastKnownAt?: number;
};

export type DemonstrationRef = { name: string };

export type PageKnowledgeRef = { profileName: string };

/**
 * Typed product intents. Components emit these and nothing else; the controller
 * is the only place that knows raw RPC names (spec §16).
 */
export type CommandPort = {
    startTask(prompt: string): void;
    stopTask(): void;
    openTeach(): void;
    openAnnotate(): void;
    closeAnnotate(): void;
    openCurrentActivity(): void;
    startTeach(kind: TeachKind, businessArea?: string): void;
    stopTeach(): void;
    saveTeach(): void;
    discardTeach(): void;
    newTask(): void;
    retry(): void;
    saveAutomation(): void;
    viewDetails(): void;
    replayDemonstration(ref: DemonstrationRef): void;
    editPageKnowledge(ref: PageKnowledgeRef): void;
    selectHistoryEntry(taskId: string): void;
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