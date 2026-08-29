import type {AgentExecutionMode, AgentRunResult, AgentRunner} from '../types';

/**
 * Versioned scenario contract for the rpa-browser agent evaluation harness.
 *
 * Bumping this version indicates a breaking change to the scenario shape or the
 * report schema. Consumers should reject scenarios with an unknown version so
 * that eval results remain comparable across versions of the harness.
 */
export const AGENT_EVAL_SCENARIO_CONTRACT_VERSION = 1 as const;
export type AgentEvalScenarioContractVersion = typeof AGENT_EVAL_SCENARIO_CONTRACT_VERSION;

export type AgentEvalMode = AgentExecutionMode;

export type AgentEvalVerification = Readonly<{
    passed: boolean;
    evidence?: unknown;
}>;

/**
 * A single eval task. The verifier is external to the model and must not rely
 * on `result.text` as the ground truth. `prepare` and `verify` receive the
 * current mode and trial index so that tasks can be deterministic and repeatable.
 */
export type AgentEvalTask = Readonly<{
    id: string;
    prompt: string;
    provider: string;
    model: string;
    input?: Record<string, unknown>;
    systemPrompt?: string;
    prepare?: (mode: AgentEvalMode, trialIndex: number) => void | Promise<void>;
    verify: (
        result: AgentRunResult,
        mode: AgentEvalMode,
        trialIndex: number,
    ) => boolean | AgentEvalVerification | Promise<boolean | AgentEvalVerification>;
}>;

export type AgentEvalRepairMetrics = Readonly<{
    rewindCalls: number;
    rollbackCalls: number;
    patchCalls: number;
    recomputeCalls: number;
    refreshCalls: number;
}>;

export type AgentEvalEffectAvailability = 'program-journal' | 'not-exposed';

export type AgentEvalEffectMetrics = Readonly<{
    toolEffectCalls: number;
    worldEffectCalls: number | null;
    failedWorldChangingEffects: number | null;
    compensationEffects: number | null;
    availability: AgentEvalEffectAvailability;
}>;

/**
 * Complete per-run metrics. Metrics that a mode cannot observe are represented
 * as `null` so that aggregations can distinguish "unknown" from "zero".
 */
export type AgentEvalMetrics = Readonly<{
    turns: number;
    toolCalls: number;
    readCalls: number;
    controlCalls: number;
    effectCalls: number;
    failedToolCalls: number;
    postErrorEffectCalls: number;
    taskSuccess: boolean;
    recoverySuccess: boolean | null;
    durationMs: number;
    effects: AgentEvalEffectMetrics;
    repair: AgentEvalRepairMetrics;
}>;

export type AgentEvalRun = Readonly<{
    taskId: string;
    mode: AgentEvalMode;
    trialIndex: number;
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

/**
 * A versioned scenario wraps a task with execution metadata. Scenarios are the
 * unit that the CLI filters and the harness repeats across trials and modes.
 */
export type AgentEvalScenario = Readonly<{
    version: AgentEvalScenarioContractVersion;
    id: string;
    name: string;
    description?: string;
    modes: readonly AgentEvalMode[];
    trials: number;
    task: AgentEvalTask;
}>;

export type AgentEvalHarness = Readonly<{
    runner: AgentRunner;
    modes?: readonly AgentEvalMode[];
}>;
