import type {AgentEvalMode} from '../../../src/agent/execution/eval/contracts';
import type {AgentEvalBenchmarkScenarioKind} from '../../../src/agent/execution/eval/benchmark';
import type {AgentEvalCorpusReport, RunAgentEvalCorpusOptions} from '../../../src/agent/execution/eval/corpus';
import {runAgentEvalCorpus} from '../../../src/agent/execution/eval/corpus';
import type {ExecutorFn} from '../../../src/automation/runner/steps/executors';
import {createAgentEvalBenchmarkCorpus} from '../../helpers/agent_eval_entries';
import {openLiveAgentEvalSession} from './runner';
import {resolveLiveModelConfig, type LiveModelConfig} from './model_config';

export type LiveBenchmarkRunOptions = Readonly<{
    modelConfig?: LiveModelConfig;
    kinds?: readonly AgentEvalBenchmarkScenarioKind[];
    modes?: readonly AgentEvalMode[];
    trials?: number;
    scenarioQuery?: string;
    seed?: number;
    executors?: Record<string, ExecutorFn>;
    headed?: boolean;
}>;

/**
 * Runs the browser benchmark corpus against the real Workspace Agent with a
 * configured provider/model. This is the live path of the production runner;
 * the deterministic JSON report is written by the caller.
 */
export const runLiveBenchmark = async (
    options: LiveBenchmarkRunOptions,
): Promise<AgentEvalCorpusReport> => {
    const modelConfig = options.modelConfig ?? resolveLiveModelConfig();
    const session = await openLiveAgentEvalSession({
        modelConfig,
        ...(options.headed === undefined ? {} : {headed: options.headed}),
        ...(options.executors ? {executors: options.executors} : {}),
    });
    try {
        const corpus = createAgentEvalBenchmarkCorpus({
            backend: 'live',
            provider: modelConfig.provider,
            model: modelConfig.model,
            pageWorld: () => session.world,
            liveRunnerFor: (scenarioId) => session.runnerFor(scenarioId),
            ...(options.kinds ? {kinds: options.kinds} : {}),
            ...(options.modes ? {modes: options.modes} : {}),
            ...(options.trials ? {trials: options.trials} : {}),
            ...(options.seed === undefined ? {} : {seed: options.seed}),
        });
        const runOptions: RunAgentEvalCorpusOptions = {
            ...(options.scenarioQuery === undefined ? {} : {scenarioQuery: options.scenarioQuery}),
            ...(options.modes ? {modes: options.modes} : {}),
            ...(options.trials === undefined ? {} : {trials: options.trials}),
            ...(options.seed === undefined ? {} : {seed: options.seed}),
        };
        return await runAgentEvalCorpus(corpus, runOptions);
    } finally {
        await session.close();
    }
};
