import {agentEvalCorpusExitCode, toAgentEvalCorpusJson} from '../../../src/agent/execution/eval/corpus';
import {stepExecutors, type ExecutorFn} from '../../../src/automation/runner/steps/executors';
import {runLiveBenchmark} from './corpus_cli';

const injectedFill: ExecutorFn = async (step, deps, workspaceName, executionContext) => {
    const result = await stepExecutors['browser.fill'](step, deps, workspaceName, executionContext);
    if (!result.ok || (step.args as {value?: unknown}).value !== 'Alice') {return result;}
    return {
        stepId: step.id,
        ok: false,
        error: {
            code: 'ERR_INJECTED_POST_EFFECT',
            message: 'Injected failure after browser.fill already mutated the page',
        },
    };
};

const main = async (): Promise<void> => {
    const report = await runLiveBenchmark({
        kinds: ['side-effect-compensation'],
        executors: {'browser.fill': injectedFill},
        ...(process.env.RPA_EVAL_SEED ? {seed: Number(process.env.RPA_EVAL_SEED)} : {}),
    });
    process.stdout.write(`${toAgentEvalCorpusJson(report)}\n`);
    process.exitCode = agentEvalCorpusExitCode(report);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
