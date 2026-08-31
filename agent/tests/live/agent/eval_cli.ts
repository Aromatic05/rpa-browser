import {runAgentEvalCli} from '../../../src/agent/execution/eval/cli';
import type {ParsedAgentEvalCliArgs} from '../../../src/agent/execution/eval/cli';
import type {AgentEvalCorpus} from '../../../src/agent/execution/eval/corpus';
import {createAgentEvalBenchmarkCorpus} from '../../helpers/agent_eval_entries';
import type {AgentEvalBenchmarkBackend} from '../../helpers/agent_eval_entries';
import {openLiveAgentEvalSession} from './runner';
import type {LiveAgentEvalSession} from './runner';
import {resolveLiveModelConfig} from './model_config';

const BACKENDS: readonly AgentEvalBenchmarkBackend[] = ['fixture', 'browser', 'live'];

type SessionHolder = Readonly<{
    ensure: () => Promise<LiveAgentEvalSession>;
    close: () => Promise<void>;
}>;

const createSessionHolder = (
    backend: 'browser' | 'live',
): SessionHolder => {
    let opening: Promise<LiveAgentEvalSession> | undefined;
    return {
        ensure: () => {
            opening ??= openLiveAgentEvalSession(backend === 'browser' ? {model: 'none'} : {});
            return opening;
        },
        close: async () => {
            if (opening) {
                await (await opening).close();
            }
        },
    };
};

const resolveCorpus = async (args: ParsedAgentEvalCliArgs, holders: SessionHolder[]): Promise<AgentEvalCorpus> => {
    const backend = String(args.extra.backend ?? 'fixture') as AgentEvalBenchmarkBackend;
    if (!BACKENDS.includes(backend)) {
        throw new Error(`Unknown backend: ${backend}. Expected one of ${BACKENDS.join(', ')}`);
    }
    if (backend === 'fixture') {
        return createAgentEvalBenchmarkCorpus({
            backend: 'fixture',
            ...(args.seed === undefined ? {} : {seed: args.seed}),
        });
    }
    const holder = createSessionHolder(backend === 'live' ? 'live' : 'browser');
    holders.push(holder);
    const modelConfig = backend === 'live' ? resolveLiveModelConfig() : undefined;
    return createAgentEvalBenchmarkCorpus({
        backend,
        pageWorld: async () => (await holder.ensure()).world,
        ...(backend === 'live' && modelConfig
            ? {
                provider: modelConfig.provider,
                model: modelConfig.model,
                liveRunnerFor: (scenarioId: string) => ({
                    run: async (request) => (await holder.ensure()).runnerFor(scenarioId).run(request),
                }),
            }
            : {}),
        ...(args.seed === undefined ? {} : {seed: args.seed}),
    });
};

const holders: SessionHolder[] = [];

process.exitCode = await runAgentEvalCli({
    invocation: 'tsx tests/live/agent/eval_cli.ts',
    extraFlags: {'--backend': 'string'},
    extraUsage: '  --backend <fixture|browser|live>  Backend (default fixture). live uses the configured provider/model.',
    resolveCorpus: (args) => resolveCorpus(args, holders),
    withExecution: async (execute) => {
        try {
            return await execute();
        } finally {
            for (const holder of holders) {
                await holder.close();
            }
        }
    },
});
