import type {
    AgentEvalHarness,
    AgentEvalMode,
    AgentEvalRun,
    AgentEvalScenario,
    AgentEvalScenarioContractVersion,
} from './contracts';
import {AGENT_EVAL_SCENARIO_CONTRACT_VERSION} from './contracts';
import {evaluateAgentTask} from './evaluator';
import type {AgentEvalModeAggregate} from './aggregate';
import {computeAgentEvalAggregates} from './aggregate';

export type AgentEvalScenarioReport = Readonly<{
    version: AgentEvalScenarioContractVersion;
    generatedAt: string;
    scenario: Readonly<{
        id: string;
        name: string;
        description?: string;
        modes: readonly AgentEvalMode[];
        trials: number;
        contractVersion: AgentEvalScenarioContractVersion;
    }>;
    runs: Readonly<Partial<Record<AgentEvalMode, readonly AgentEvalRun[]>>>;
    aggregates: Readonly<Partial<Record<AgentEvalMode, AgentEvalModeAggregate>>>;
}>;

const freezeRuns = (
    runs: Partial<Record<AgentEvalMode, readonly AgentEvalRun[]>>,
): Readonly<Partial<Record<AgentEvalMode, readonly AgentEvalRun[]>>> => {
    const frozen: Partial<Record<AgentEvalMode, readonly AgentEvalRun[]>> = {};
    for (const [mode, modeRuns] of Object.entries(runs) as [AgentEvalMode, readonly AgentEvalRun[] | undefined][]) {
        if (modeRuns) {
            frozen[mode] = Object.freeze([...modeRuns]);
        }
    }
    return Object.freeze(frozen);
};

/**
 * Repeatedly run a scenario across its modes, honouring `harness.modes` as an
 * override. Returns per-trial runs plus aggregate rates and distributions.
 */
export const runAgentEvalScenario = async (
    harness: AgentEvalHarness,
    scenario: AgentEvalScenario,
): Promise<AgentEvalScenarioReport> => {
    const modes = harness.modes ?? scenario.modes;
    const trials = Math.max(1, scenario.trials);
    const runs: Partial<Record<AgentEvalMode, AgentEvalRun[]>> = {};

    for (const mode of modes) {
        const modeRuns: AgentEvalRun[] = [];
        for (let trialIndex = 0; trialIndex < trials; trialIndex++) {
            const comparison = await evaluateAgentTask(
                {runner: harness.runner, modes: [mode]},
                scenario.task,
                {trialIndex},
            );
            const run = comparison.runs[mode];
            if (run) {
                modeRuns.push(run);
            }
        }
        runs[mode] = modeRuns;
    }

    return Object.freeze({
        version: AGENT_EVAL_SCENARIO_CONTRACT_VERSION,
        generatedAt: new Date().toISOString(),
        scenario: Object.freeze({
            id: scenario.id,
            name: scenario.name,
            description: scenario.description,
            modes: Object.freeze([...modes]),
            trials,
            contractVersion: AGENT_EVAL_SCENARIO_CONTRACT_VERSION,
        }),
        runs: freezeRuns(runs),
        aggregates: computeAgentEvalAggregates(runs),
    });
};
