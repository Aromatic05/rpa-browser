import type {AgentTraceSnapshot} from '../trace/collector';

export type AgentRunRequest = {
    prompt: string;
    provider: string;
    model: string;
    systemPrompt?: string;
};

export type AgentRunResult = {
    provider: string;
    model: string;
    text: string;
    trace: AgentTraceSnapshot;
};

export type AgentRunner = {
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
};
