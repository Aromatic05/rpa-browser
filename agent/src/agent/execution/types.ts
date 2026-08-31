import type {AgentTraceSnapshot} from '../trace/collector';
import type {ModelRequestedInteraction} from '../interaction/contracts';

export type AgentExecutionMode = 'program' | 'react-baseline';

export type AgentProgramWorldRevision = Readonly<{
    pageEpoch: string;
    captureRevision: number;
}>;

export type AgentProgramEffectSummary = Readonly<{
    sequence: number;
    stepName: string;
    status: 'succeeded' | 'failed';
    worldBefore: AgentProgramWorldRevision;
    worldAfter: AgentProgramWorldRevision;
    compensates?: number;
}>;

export type AgentProgramPauseReason = 'statement' | 'effect' | 'barrier' | 'failure';

export type AgentProgramPause = Readonly<{
    reason: AgentProgramPauseReason;
    continuationId: string;
    stepName?: string;
    risk?: 'unknown' | 'reversible' | 'compensatable' | 'irreversible';
    failure?: Readonly<{code: string; message: string}>;
}>;

export type AgentRunContinuation = Readonly<{
    resume: () => Promise<AgentRunResult>;
    /** Opaque, JSON-safe durable image. Concrete parsing belongs to the
     * workspace that created the continuation, never the service/session. */
    exportImage?: () => unknown;
}>;

/**
 * Typed external control input delivered to the retained Agent control loop of
 * the SAME Task/run. These are never generic prompt blobs; each kind carries
 * the structured resolution the loop needs. The denied effect is never crossed.
 */
export type AgentControlInput =
    | Readonly<{kind: 'deny'; effectName: string; reason: string; requestedAlternative?: string}>
    | Readonly<{kind: 'clarification-answer'; question: string; answer: unknown}>
    | Readonly<{kind: 'recovery-choice'; optionId: string; optionLabel: string}>
    | Readonly<{kind: 'takeover-return'; savedReference?: string}>
    | Readonly<{kind: 'interaction-timeout'; interactionKind: string; reason: string}>;

export type AgentControlContinuation = Readonly<{
    control: (input: AgentControlInput) => Promise<AgentRunResult>;
}>;

export type AgentRunRequest = {
    prompt: string;
    provider: string;
    model: string;
    executionMode?: AgentExecutionMode;
    source?: string;
    input?: Record<string, unknown>;
    systemPrompt?: string;
};

export type AgentProgramExecutionSummary = Readonly<{
    source: string;
    materializedSource?: string;
    input: Readonly<Record<string, unknown>>;
    status: 'completed' | 'paused' | 'failed' | 'aborted' | 'invalid';
    text?: string;
    error?: Readonly<{code: string; message: string; details?: unknown}>;
    trace?: AgentTraceSnapshot;
    effects?: readonly AgentProgramEffectSummary[];
    pause?: AgentProgramPause;
    /** Sanitized summary of a human-taught Workflow Recovery applied to this
     *  retained Program transaction. Never exposes raw checkpoint bodies. */
    recovery?: Readonly<{
        checkpointId: string;
        checkpointName?: string;
        applied: boolean;
        retried?: boolean;
        blockedByApproval?: boolean;
    }>;
}>;

export type AgentProgramSavedArtifact = Readonly<{
    name: string;
    artifactRevision: string;
}>;

export type AgentRunResult = {
    provider: string;
    model: string;
    text: string;
    trace: AgentTraceSnapshot;
    executionMode?: AgentExecutionMode;
    programs?: readonly AgentProgramExecutionSummary[];
    savedPrograms?: readonly AgentProgramSavedArtifact[];
    continuation?: AgentRunContinuation;
    control?: AgentControlContinuation;
    /** Typed interaction the retained Agent control loop requested: the run
     *  paused for a human and the session creates the InteractionRecord. Never
     *  a generic prompt blob. Approval is excluded structurally: the model can
     *  request only clarification / recovery_decision / takeover. */
    requestedInteraction?: ModelRequestedInteraction;
};

export type AgentRunner = {
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
};
