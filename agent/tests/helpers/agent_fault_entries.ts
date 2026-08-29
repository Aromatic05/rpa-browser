import type {AgentEvalMode} from '../../src/agent/execution/eval/contracts';
import type {AgentRunner} from '../../src/agent/execution/types';
import type {AgentEvalCorpus, AgentEvalCorpusEntry} from '../../src/agent/execution/eval/corpus';
import type {AgentFaultKind, AgentFaultWorld} from '../../src/agent/execution/eval/faults/contracts';
import {AGENT_FAULT_KINDS} from '../../src/agent/execution/eval/faults/contracts';
import type {AgentFaultWorldAccessor} from '../../src/agent/execution/eval/faults/scenarios';
import {createAgentEvalFaultScenario} from '../../src/agent/execution/eval/faults/scenarios';
import {
    AGENT_FAULT_SIMULATED_MODEL,
    AGENT_FAULT_SIMULATED_PROVIDER,
    createAgentFaultPolicyRunner,
} from '../../src/agent/execution/eval/faults/policy_runner';
import {DEFAULT_AGENT_EVAL_SEED} from '../../src/agent/execution/eval/seed';
import {createFakeFaultWorld} from './agent_fault_world';

export type AgentFaultBackend = 'fixture' | 'browser';

export type AgentFaultCorpusOptions = Readonly<{
    backend: AgentFaultBackend;
    seed?: number;
    /** Browser backend: returns the fault world wrapping the real page port. */
    faultWorld?: AgentFaultWorldAccessor;
    kinds?: readonly AgentFaultKind[];
    modes?: readonly AgentEvalMode[];
    trials?: number;
}>;

/**
 * Assemble the fault-injection corpus for one backend. Both backends share the
 * same scenarios, fault script, external verifier and policy runner; only the
 * underlying world port differs (in-memory vs real Playwright page).
 */
export const createAgentFaultCorpus = (options: AgentFaultCorpusOptions): AgentEvalCorpus => {
    const seed = options.seed ?? DEFAULT_AGENT_EVAL_SEED;
    const kinds = options.kinds ?? AGENT_FAULT_KINDS;
    const holder: {current?: AgentFaultWorld} = {};

    const resolveWorld: AgentFaultWorldAccessor = async () => {
        if (holder.current) {
            return holder.current;
        }
        if (options.backend === 'fixture') {
            holder.current = createFakeFaultWorld();
            return holder.current;
        }
        if (!options.faultWorld) {
            throw new Error('faultWorld is required for the browser fault backend');
        }
        holder.current = await options.faultWorld();
        return holder.current;
    };

    const runner: AgentRunner = createAgentFaultPolicyRunner({
        getWorld: () => {
            if (!holder.current) {
                throw new Error('fault world is not loaded yet');
            }
            return holder.current;
        },
    });

    const entries: AgentEvalCorpusEntry[] = kinds.map((kind) => Object.freeze({
        scenario: createAgentEvalFaultScenario({
            kind,
            provider: AGENT_FAULT_SIMULATED_PROVIDER,
            model: AGENT_FAULT_SIMULATED_MODEL,
            world: resolveWorld,
            seed,
            ...(options.modes ? {modes: options.modes} : {}),
            ...(options.trials ? {trials: options.trials} : {}),
        }),
        runner,
    }));

    return Object.freeze({
        id: 'agent-fault-transactional-benchmark',
        version: 1,
        description: 'Deterministic fault injection: Program-first transactional semantics vs react-baseline ad-hoc recovery.',
        entries: Object.freeze(entries),
    });
};
