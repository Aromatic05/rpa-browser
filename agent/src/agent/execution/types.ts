import type {AgentTraceSnapshot} from '../trace/collector';

export type AgentExecutionMode = 'program' | 'react-baseline';

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
    input: Readonly<Record<string, unknown>>;
    status: 'completed' | 'paused' | 'failed' | 'aborted' | 'invalid';
    text?: string;
    error?: Readonly<{code: string; message: string; details?: unknown}>;
    trace?: AgentTraceSnapshot;
}>;

export type AgentRunResult = {
    provider: string;
    model: string;
    text: string;
    trace: AgentTraceSnapshot;
    executionMode?: AgentExecutionMode;
    programs?: readonly AgentProgramExecutionSummary[];
};

export type AgentRunner = {
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
};
