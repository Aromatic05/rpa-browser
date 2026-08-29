import type { AgentEvalMode } from '../../src/agent/execution/eval/contracts';
import type { AgentRunner, AgentRunRequest } from '../../src/agent/execution/types';
import type { AgentWorldRevision } from '../../src/agent/trace/collector';
import type { AgentEvalCorpus } from '../../src/agent/execution/eval/corpus';
import { DEFAULT_AGENT_EVAL_SEED } from '../../src/agent/execution/eval/seed';
import type {
    AgentFaultKind,
    AgentFaultWorld,
} from '../../src/agent/execution/eval/faults/contracts';
import { AGENT_FAULT_KINDS } from '../../src/agent/execution/eval/faults/contracts';
import type { AgentFaultWorldAccessor } from '../../src/agent/execution/eval/faults/scenarios';
import { createAgentEvalFaultScenario } from '../../src/agent/execution/eval/faults/scenarios';
import { createProgramFirstAgentRunner } from '../../src/agent/execution/program/runner';
import { createReactAgentRunner } from '../../src/agent/execution/react_runner';
import type { AgentEvalFixtureSpec } from '../../src/agent/execution/eval/world';
import type { AgentEvalRealFixtureTargets } from './agent_eval_real_worldview';
import { fixtureNodeTargets } from './agent_eval_real_worldview';
import { createFixtureBrowserTools, createFixtureReadTools } from './agent_eval_real_tools';
import { createFixtureProgramExecutor } from './agent_eval_real_executor';
import {
    AGENT_EVAL_REAL_MODEL,
    AGENT_EVAL_REAL_PROVIDER,
    createFauxModelRuntime,
} from './agent_eval_real_faux_model';

export const AGENT_EVAL_REAL_FAULT_FIXTURE: AgentEvalFixtureSpec = Object.freeze({
    page: 'fault-form',
    fields: Object.freeze({ name: 'Before' }),
    buttons: Object.freeze(['submit']),
});

const revisionOf = (world: AgentFaultWorld): AgentWorldRevision => ({
    pageEpoch: `epoch-${world.epoch()}`,
    captureRevision: world.revision(),
    freshness: 'fresh',
});

export type CreateRealAgentFaultRunnerOptions = Readonly<{
    kind: AgentFaultKind;
    world: AgentFaultWorldAccessor;
    spec?: AgentEvalFixtureSpec;
}>;

/**
 * Build the production AgentRunner for one fault scenario. The runner is the
 * real createWorkspaceAgentFactory internals (Program-first runner and
 * react-baseline) wired to the committed fault world port through the
 * production-shaped tools and the fixture DSL executor. Each run gets a fresh
 * deterministic faux model so trials replay the identical script.
 */
export const createRealAgentFaultRunner = (
    options: CreateRealAgentFaultRunnerOptions,
): AgentRunner => {
    const spec = options.spec ?? AGENT_EVAL_REAL_FAULT_FIXTURE;
    const targets: AgentEvalRealFixtureTargets = fixtureNodeTargets(spec);
    const resolveWorld = options.world;

    return {
        run: async (request: AgentRunRequest) => {
            const mode: AgentEvalMode = request.executionMode ?? 'program';
            const world = await resolveWorld();
            const modelRuntime = createFauxModelRuntime({
                mode,
                kind: options.kind,
                trialIndex: 0,
                targets,
            });
            const readWorldRevision = () => revisionOf(world);
            if (mode === 'react-baseline') {
                const runner = createReactAgentRunner({
                    tools: createFixtureBrowserTools({ world, spec }),
                    modelRuntime,
                    readWorldRevision,
                });
                return await runner.run(request);
            }
            const runner = createProgramFirstAgentRunner({
                readTools: createFixtureReadTools({ world, spec }),
                executeProgram: createFixtureProgramExecutor({ world, spec }),
                modelRuntime,
                readWorldRevision,
            });
            return await runner.run(request);
        },
    };
};

export type CreateRealAgentFaultCorpusOptions = Readonly<{
    seed?: number;
    kinds?: readonly AgentFaultKind[];
    modes?: readonly AgentEvalMode[];
    trials?: number;
    world: AgentFaultWorldAccessor;
    spec?: AgentEvalFixtureSpec;
}>;

/**
 * Assemble the real-agent fault corpus: the committed fault scenarios and
 * external verifier, but executed by the production Program-first / react
 * baseline runners over the fault world browser port. Every run's metrics come
 * from the production runners' real trace and retained effect journal.
 */
export const createRealAgentFaultCorpus = (
    options: CreateRealAgentFaultCorpusOptions,
): AgentEvalCorpus => {
    const seed = options.seed ?? DEFAULT_AGENT_EVAL_SEED;
    const kinds = options.kinds ?? AGENT_FAULT_KINDS;
    const spec = options.spec ?? AGENT_EVAL_REAL_FAULT_FIXTURE;

    const entries = kinds.map((kind) => {
        const scenario = createAgentEvalFaultScenario({
            kind,
            provider: AGENT_EVAL_REAL_PROVIDER,
            model: AGENT_EVAL_REAL_MODEL,
            world: options.world,
            seed,
            ...(options.modes ? { modes: options.modes } : {}),
            ...(options.trials ? { trials: options.trials } : {}),
        });
        return Object.freeze({
            scenario,
            runner: createRealAgentFaultRunner({ kind, world: options.world, spec }),
        });
    });

    return Object.freeze({
        id: 'agent-fault-real-execution-benchmark',
        version: 1,
        description:
            'Committed fault oracle executed by the real production Program-first and react-baseline runners over the fault world browser port.',
        entries: Object.freeze(entries),
    });
};
