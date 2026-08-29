import type {AgentExecutionMode, AgentRunResult} from '../../execution/types';
import type {AgentRunReport} from '../../report/contracts';

export type SessionId = string;

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
}>;

export type SessionReport = Readonly<{
    sessionId: SessionId;
    report: AgentRunReport | null;
}>;
