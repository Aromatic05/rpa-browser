import type {AgentProgramExecutionSummary, AgentRunRequest} from '../types';

export type AgentProgram = Readonly<{
    source: string;
    input: Readonly<Record<string, unknown>>;
}>;

export type AgentProgramExecutor = (
    program: AgentProgram,
    request: AgentRunRequest,
) => Promise<AgentProgramExecutionSummary>;
