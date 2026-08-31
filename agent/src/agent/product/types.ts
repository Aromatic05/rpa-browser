import type {
    GuidanceMode,
    InteractionKind,
    ProductRecoveryOption,
    TeachKind,
} from '../interaction/contracts';
import type {
    ActivityHumanControl,
    ActivityOwnerKind,
} from '../service/session/types';

export type AgentTaskStatus =
    | 'draft'
    | 'running'
    | 'paused'
    | 'waiting_for_user'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

export type AgentTaskPhase = 'planning' | 'observing' | 'executing' | 'recovering' | 'interacting';

export type ClarificationCardSchema = Readonly<{
    field: string;
    type: 'text' | 'number' | 'date' | 'select';
    allowed?: ReadonlyArray<string>;
    min?: number;
    max?: number;
    maxLength?: number;
    default?: unknown;
}>;

export type ProductInteractionCard =
    | Readonly<{
        kind: 'approval';
        interactionToken: string;
        actionName: string;
        summary: string;
        risk: 'unknown' | 'reversible' | 'compensatable' | 'irreversible';
        deadlineAt: number;
    }>
    | Readonly<{
        kind: 'clarification';
        interactionToken: string;
        question: string;
        schema: ClarificationCardSchema;
        deadlineAt: number;
    }>
    | Readonly<{
        kind: 'recovery_decision';
        interactionToken: string;
        failureSummary: string;
        options: ReadonlyArray<ProductRecoveryOption>;
        deadlineAt: number;
    }>
    | Readonly<{
        kind: 'takeover';
        interactionToken: string;
        reason: string;
        scope: 'workspace' | 'tab';
        stage: 'offered' | 'active';
        guidanceModes: ReadonlyArray<GuidanceMode>;
        teachKind?: TeachKind;
        deadlineAt: number;
    }>;

export type AgentTaskResultView = Readonly<{
    outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted';
    summary: string;
    saveEligible?: boolean;
}>;

export type AgentTaskErrorView = Readonly<{
    code: string;
    message: string;
}>;

export type AgentTaskView = Readonly<{
    taskId: string;
    status: AgentTaskStatus;
    /** Present only when the backend emitted a truthful phase; `interacting` is
     *  implied by a pending interaction. Absent => generic running. */
    phase?: AgentTaskPhase;
    interaction?: ProductInteractionCard;
    title: string;
    promptSummary: string;
    result?: AgentTaskResultView;
    error?: AgentTaskErrorView;
    reportAvailable: boolean;
    resumable: boolean;
    createdAt: number;
    endedAt: number | null;
    lastSeq: number;
}>;

export type WorkspaceProductReservationView = Readonly<{
    owner: ActivityOwnerKind;
    ownerTaskId?: string;
    humanControl: ActivityHumanControl;
    /** Coarse Teach kind owned by a standalone Teach activity (never an id). */
    teachKind?: 'procedure' | 'recovery' | 'demonstration';
}>;

/**
 * Bounded, sanitized Library projection (spec §9.3/§12.1): user-facing asset
 * names and coarse evidence only. `status`/`health` carry the real Library
 * dependency-health evidence (`ready|needs_review|broken|unknown`); the product
 * surface never fabricates `ready`. No bodies, steps, selectors or ids.
 */
export type WorkspaceLibraryHealth = 'ready' | 'needs_review' | 'broken' | 'unknown';

export type WorkspaceLibrarySummary = Readonly<{
    automations: ReadonlyArray<Readonly<{name: string; description?: string; status?: WorkspaceLibraryHealth}>>;
    procedures: ReadonlyArray<Readonly<{name: string; health?: WorkspaceLibraryHealth}>>;
    recoveries: ReadonlyArray<Readonly<{name: string; health?: WorkspaceLibraryHealth}>>;
    demonstrations: ReadonlyArray<Readonly<{name: string; stepCount: number; health?: WorkspaceLibraryHealth}>>;
    pageKnowledge: ReadonlyArray<Readonly<{
        profileName: string;
        label: string;
        pageKind?: string;
        urlPattern?: string;
        entityCount: number;
        health?: WorkspaceLibraryHealth;
    }>>;
}>;

export type WorkspaceProductView = Readonly<{
    workspace: string;
    reservation: WorkspaceProductReservationView;
    activeTask?: AgentTaskView;
}>;

export type ProductEvent =
    | Readonly<{seq: number; taskId: string; at: number; kind: 'task_created'; promptSummary: string; startedAt: number}>
    | Readonly<{seq: number; taskId: string; at: number; kind: 'phase_changed'; phase: AgentTaskPhase}>
    | Readonly<{seq: number; taskId: string; at: number; kind: 'activity'; summary: string}>
    | Readonly<{
        seq: number;
        taskId: string;
        at: number;
        kind: 'interaction_requested';
        interactionKind: InteractionKind;
        headline: string;
        deadlineAt: number;
    }>
    | Readonly<{
        seq: number;
        taskId: string;
        at: number;
        kind: 'interaction_resolved';
        interactionKind: InteractionKind;
        decisionSummary: string;
    }>
    | Readonly<{seq: number; taskId: string; at: number; kind: 'human_guidance_started'; mode: GuidanceMode; purpose: string}>
    | Readonly<{
        seq: number;
        taskId: string;
        at: number;
        kind: 'human_guidance_completed';
        mode: GuidanceMode;
        savedAssetKind?: string;
        savedAssetRef?: string;
    }>
    | Readonly<{
        seq: number;
        taskId: string;
        at: number;
        kind: 'effect_applied';
        summary: string;
        status: 'succeeded' | 'failed';
    }>
    | Readonly<{seq: number; taskId: string; at: number; kind: 'world_conflict'; expected: string; actual: string}>
    | Readonly<{seq: number; taskId: string; at: number; kind: 'task_terminated'; outcome: AgentTaskStatus}>
    | Readonly<{seq: number; taskId: string; at: number; kind: 'report_ready'}>;

export type ProductEventsResponse = Readonly<{
    events: ReadonlyArray<ProductEvent>;
    nextSeq: number;
    /** True when the consumer's `afterSeq` no longer matches the log head; the
     *  consumer must refresh the authoritative snapshot instead of guessing. */
    gap: boolean;
}>;

export type ProductStartTaskInput = Readonly<{
    prompt: string;
    provider?: string;
    model?: string;
    executionMode?: 'program' | 'react-baseline';
}>;

export type ProductStopTaskInput = Readonly<{taskId: string}>;
export type ProductPauseTaskInput = Readonly<{taskId: string}>;
export type ProductResumeTaskInput = Readonly<{taskId: string}>;
export type ProductSaveAutomationInput = Readonly<{taskId: string; name: string}>;
export type ProductSaveAutomationResult = Readonly<{
    saved: boolean;
    name: string;
    reason?: 'conflict';
}>;
export type ProductApproveInput = Readonly<{taskId: string; interactionToken: string}>;
export type ProductDenyInput = Readonly<{
    taskId: string;
    interactionToken: string;
    reason: string;
    requestedAlternative?: string;
}>;
export type ProductAnswerInput = Readonly<{
    taskId: string;
    interactionToken: string;
    value: unknown;
}>;
export type ProductChooseRecoveryInput = Readonly<{
    taskId: string;
    interactionToken: string;
    optionId: string;
}>;
export type ProductBeginGuidanceInput = Readonly<{
    taskId: string;
    interactionToken: string;
    mode: GuidanceMode;
}>;
export type ProductReturnControlInput = Readonly<{
    taskId: string;
    interactionToken: string;
    mode: GuidanceMode;
    savedReference?: string;
}>;

/** Standalone authoring reservation commands (spec §10/§13). Begin acquires the
 *  same WorkspaceActivityReservation a Task would; it conflicts (never queues)
 *  with any active owner, and a waiting_for_user Task keeps its ownership. */
export type ProductBeginAuthoringInput = Readonly<
    | {activity: 'teach'; teachKind: 'procedure' | 'recovery' | 'demonstration'}
    | {activity: 'annotate'}
>;

/** Ends the active standalone authoring reservation. `saved` means the asset
 *  was persisted to the Library; `discarded` means the draft was thrown away.
 *  Task-owned reservations are never released through this command. */
export type ProductEndAuthoringInput = Readonly<{
    outcome: 'saved' | 'discarded';
}>;