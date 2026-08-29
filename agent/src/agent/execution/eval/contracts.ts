import type {AgentExecutionMode, AgentRunResult, AgentRunner} from '../types';

export type AgentEvalMode = AgentExecutionMode;

export type AgentEvalVerification = Readonly<{
    passed: boolean;
    evidence?: unknown;
}>;

export type AgentEvalTask = Readonly<{
    id: string;
    prompt: string;
    provider: string;
    model: string;
    input?: Record<string, unknown>;
    systemPrompt?: string;
    prepare?: (mode: AgentEvalMode) => void | Promise<void>;
    verify: (
        result: AgentRunResult,
        mode: AgentEvalMode,
    ) => boolean | AgentEvalVerification | Promise<boolean | AgentEvalVerification>;
}>;

export type AgentEvalRepairMetrics = Readonly<{
    rewindCalls: number;
    rollbackCalls: number;
    patchCalls: number;
    recomputeCalls: number;
    refreshCalls: number;
}>;

export type AgentEvalEffectMetrics = Readonly<{
    toolEffectCalls: number;
    worldEffectCalls: number | null;
    availability: 'program-journal' | 'not-exposed';
}>;

export type AgentEvalMetrics = Readonly<{
    turns: number;
    toolCalls: number;
    readCalls: number;
    controlCalls: number;
    failedToolCalls: number;
    postErrorEffectCalls: number;
    effects: AgentEvalEffectMetrics;
    repair: AgentEvalRepairMetrics;
}>;

export type AgentEvalRun = Readonly<{
    taskId: string;
    mode: AgentEvalMode;
    success: boolean;
    durationMs: number;
    verification: AgentEvalVerification;
    metrics: AgentEvalMetrics;
    result: AgentRunResult;
}>;

export type AgentEvalComparison = Readonly<{
    taskId: string;
    runs: Readonly<Partial<Record<AgentEvalMode, AgentEvalRun>>>;
}>;

export type AgentEvalHarness = Readonly<{
    runner: AgentRunner;
    modes?: readonly AgentEvalMode[];
}>;
