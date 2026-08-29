import {agentEvalCorpusExitCode, toAgentEvalCorpusJson} from '../../../src/agent/execution/eval/corpus';
import type {AgentEvalMode} from '../../../src/agent/execution/eval/contracts';
import {runLiveBenchmark} from './corpus_cli';

const main = async (): Promise<void> => {
    const requestedModes = process.env.RPA_EVAL_MODES?.split(',')
        .map((mode) => mode.trim())
        .filter((mode): mode is AgentEvalMode => mode === 'program' || mode === 'react-baseline');
    const report = await runLiveBenchmark({
        kinds: ['form-fill-submit'],
        ...(requestedModes && requestedModes.length > 0 ? {modes: requestedModes} : {}),
        ...(process.env.RPA_EVAL_SEED ? {seed: Number(process.env.RPA_EVAL_SEED)} : {}),
    });
    process.stdout.write(`${toAgentEvalCorpusJson(report)}\n`);
    process.exitCode = agentEvalCorpusExitCode(report);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
