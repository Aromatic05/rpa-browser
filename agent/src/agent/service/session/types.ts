import type {AgentExecutionMode, AgentRunResult} from '../../execution/types';
import type {AgentRunReport} from '../../report/contracts';
import type {
    InteractionId,
    InteractionKind,
    InteractionStatus,
} from '../../interaction/contracts';

export type SessionId = string;
export type {InteractionId, InteractionKind, InteractionStatus, RunId} from '../../interaction/contracts';

export type SessionInteractionView = Readonly<{
    id: InteractionId;
    kind: InteractionKind;
    status: InteractionStatus;
    revision: number;
    deadlineAt: number;
}>;

export type SessionInteractionPolicy = 'interactive' | 'headless';

/**
 * A session is `running` from creation until the runner settles it. Terminal and
 * retained states never move again once recorded:
 * - `paused`    the run finished but left a program paused, retained for a later
 *               human approve/resume.
 * - `completed` the run finished with no paused or failed program.
 * - `failed`    the runner threw or reported a failed/aborted program.
 * - `cancelled` the session was aborted externally before the runner settled.
 */
export type SessionState = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type SessionRequestSummary = Readonly<{
    prompt: string;
    provider: string;
    model: string;
    executionMode?: AgentExecutionMode;
    source?: string;
}>;

export type SessionError = Readonly<{
    code: string;
    message: string;
}>;

export type SessionSnapshot = Readonly<{
    sessionId: SessionId;
    state: SessionState;
    createdAt: number;
    startedAt: number;
    endedAt: number | null;
    request: SessionRequestSummary;
    result: AgentRunResult | null;
    error: SessionError | null;
    reportAvailable: boolean;
    resumable: boolean;
    interactions: ReadonlyArray<SessionInteractionView>;
}>;

export type SessionReport = Readonly<{
    sessionId: SessionId;
    report: AgentRunReport | null;
}>;
