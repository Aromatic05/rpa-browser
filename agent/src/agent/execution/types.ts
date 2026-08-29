import type {AgentTraceSnapshot} from '../trace/collector';

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
};

export type AgentRunner = {
    run: (request: AgentRunRequest) => Promise<AgentRunResult>;
};
