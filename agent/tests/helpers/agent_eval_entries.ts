import type {AgentEvalMode, AgentEvalScenario} from '../../src/agent/execution/eval/contracts';
import type {AgentRunner} from '../../src/agent/execution/types';
import type {AgentEvalCorpus, AgentEvalCorpusEntry} from '../../src/agent/execution/eval/corpus';
import type {
    AgentEvalBenchmarkScenarioKind,
    AgentEvalWorldAccessor,
} from '../../src/agent/execution/eval/benchmark';
import {
    BENCHMARK_SCENARIO_KINDS,
    createAgentEvalBenchmarkScenario,
} from '../../src/agent/execution/eval/benchmark';
import {DEFAULT_AGENT_EVAL_SEED} from '../../src/agent/execution/eval/seed';
import type {AgentEvalWorld} from '../../src/agent/execution/eval/world';
import {createFakeAgentEvalWorld} from './agent_eval_fake_world';
import {
    AGENT_EVAL_SIMULATED_MODEL,
    AGENT_EVAL_SIMULATED_PROVIDER,
    createAgentEvalSimulatedRunner,
} from './agent_eval_sim_runner';

export type AgentEvalBenchmarkBackend = 'fixture' | 'browser' | 'live';

export type AgentEvalBenchmarkCorpusOptions = Readonly<{
    backend: AgentEvalBenchmarkBackend;
    seed?: number;
    /** Overrides the task model metadata; required (and real) for the live backend. */
    provider?: string;
    model?: string;
    /** World accessor over the live browser page; required for browser/live. */
    pageWorld?: AgentEvalWorldAccessor;
    /** Builds the real Workspace Agent runner for one scenario; required for live. */
    liveRunnerFor?: (scenarioId: string) => AgentRunner;
    kinds?: readonly AgentEvalBenchmarkScenarioKind[];
    modes?: readonly AgentEvalMode[];
    trials?: number;
}>;

/**
 * Assemble the five-category browser benchmark corpus for a backend:
 * fixture (in-memory world + simulated policy), browser (real page +
 * simulated policy) or live (real page + real Workspace Agent/model).
 */
export const createAgentEvalBenchmarkCorpus = (
    options: AgentEvalBenchmarkCorpusOptions,
): AgentEvalCorpus => {
    const seed = options.seed ?? DEFAULT_AGENT_EVAL_SEED;
    const kinds = options.kinds ?? BENCHMARK_SCENARIO_KINDS;
    const holder: {current?: AgentEvalWorld} = {};

    const resolveWorld: AgentEvalWorldAccessor = async () => {
        if (holder.current) {
            return holder.current;
        }
        if (options.backend === 'fixture') {
            holder.current = createFakeAgentEvalWorld();
            return holder.current;
        }
        if (!options.pageWorld) {
            throw new Error(`pageWorld is required for the ${options.backend} backend`);
        }
        holder.current = await options.pageWorld();
        return holder.current;
    };

    const provider = options.provider
        ?? (options.backend === 'live' ? undefined : AGENT_EVAL_SIMULATED_PROVIDER);
    const model = options.model
        ?? (options.backend === 'live' ? undefined : AGENT_EVAL_SIMULATED_MODEL);
    if (!provider || !model) {
        throw new Error('live backend requires provider and model');
    }

    const entries: AgentEvalCorpusEntry[] = kinds.map((kind) => {
        const scenario: AgentEvalScenario = createAgentEvalBenchmarkScenario({
            kind,
            provider,
            model,
            world: resolveWorld,
            seed,
            ...(options.modes ? {modes: options.modes} : {}),
            ...(options.trials ? {trials: options.trials} : {}),
        });
        const runner: AgentRunner = options.backend === 'live'
            ? (() => {
                if (!options.liveRunnerFor) {
                    throw new Error('live backend requires liveRunnerFor');
                }
                return options.liveRunnerFor(scenario.id);
            })()
            : createAgentEvalSimulatedRunner(() => {
                if (!holder.current) {
                    throw new Error(`benchmark world is not loaded for scenario ${scenario.id}`);
                }
                return holder.current;
            });
        return Object.freeze({scenario, runner});
    });

    return Object.freeze({
        id: 'agent-eval-browser-benchmark',
        version: 1,
        description: 'Program-first vs react-baseline benchmark over browser fixture scenarios.',
        entries: Object.freeze(entries),
    });
};
