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
 * - `paused`       the run finished but left a program paused for a later human
 *                  approval / control re-entry.
 * - `completed`    the run finished with no paused or failed program.
 * - `failed`       the runner threw or reported a failed/aborted program.
 * - `cancelled`    the session was aborted externally before the runner settled.
 * - `interrupted`  the session was active at service restart with no durable
 *                  continuation; it is derived, non-resumable and terminal.
 */
export type SessionState = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

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

export type ActivityOwnerKind = 'none' | 'task' | 'standalone_teach' | 'standalone_annotate' | 'playback';

export type ActivityHumanControl = 'none' | 'manual' | 'teach' | 'annotate';

export type ActivityReservationSnapshot = Readonly<{
    owner: ActivityOwnerKind;
    ownerTaskId?: string;
    humanControl: ActivityHumanControl;
    /** Coarse Teach kind while a standalone Teach owns the reservation; lets a
     *  reloaded product surface adopt the activity truthfully. */
    teachKind?: 'procedure' | 'recovery' | 'demonstration';
}>;

/** Workspace-level product activity reservation port consumed by the session
 *  manager. A Task start acquires the reservation and holds it across running
 *  and waiting_for_user; terminal settle releases it. Conflicts reject, never
 *  queue. Implemented by the product reservation domain. */
export type ActivityReservationPort = Readonly<{
    acquireTask: (taskId: string) => boolean;
    releaseTask: (taskId: string) => boolean;
    setHumanControl: (taskId: string, control: ActivityHumanControl) => boolean;
    snapshot: () => ActivityReservationSnapshot;
}>;
