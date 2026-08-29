import type {DslDebugExecutionSession, PausedDslDebugExecution} from '../../debug/execution/contracts';
import type {AgentProgramExecutionSummary} from '../types';

export type AgentProgram = Readonly<{
    source: string;
    input: Readonly<Record<string, unknown>>;
}>;

export type AgentProgramDebugHandle = Readonly<{
    session: DslDebugExecutionSession;
    pause: PausedDslDebugExecution;
}>;

export type AgentProgramExecutionStart = Readonly<{
    summary: AgentProgramExecutionSummary;
    debug?: AgentProgramDebugHandle;
}>;

export type AgentProgramExecutor = (
    program: AgentProgram,
) => Promise<AgentProgramExecutionStart>;
