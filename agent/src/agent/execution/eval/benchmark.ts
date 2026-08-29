import type {AgentEvalMode, AgentEvalScenario} from './contracts';
import {AGENT_EVAL_SCENARIO_CONTRACT_VERSION} from './contracts';
import {deriveTrialSeed} from './seed';
import type {AgentEvalFixtureSpec, AgentEvalWorld} from './world';

export type AgentEvalPlanAction = Readonly<{
    op: 'fill' | 'click';
    key: string;
    value?: string;
}>;

export type AgentEvalPlanFault = Readonly<{
    kind: 'stale-target' | 'mutation-failed' | 'error-after-effect';
    actionIndex: number;
}>;

/**
 * Execution plan carried in `task.input`. The simulated fixture runner replays
 * it against the world port; the live Workspace Agent receives the same shape
 * so both backends exercise identical external expectations.
 */
export type AgentEvalPlan = Readonly<{
    fixture: AgentEvalFixtureSpec;
    actions: readonly AgentEvalPlanAction[];
    faults?: readonly AgentEvalPlanFault[];
    compensate?: boolean;
}>;

export type AgentEvalBenchmarkScenarioKind =
    | 'form-fill-submit'
    | 'failed-mutation-recovery'
    | 'side-effect-compensation'
    | 'drift-stale-target'
    | 'multi-step-order';

export const BENCHMARK_SCENARIO_KINDS: readonly AgentEvalBenchmarkScenarioKind[] = [
    'form-fill-submit',
    'failed-mutation-recovery',
    'side-effect-compensation',
    'drift-stale-target',
    'multi-step-order',
];

type BenchmarkScenarioBlueprint = Readonly<{
    name: string;
    description: string;
    prompt: string;
    plan: AgentEvalPlan;
    /** key -> required final value checked by the external verifier. */
    expected: Readonly<Record<string, string>>;
}>;

const BLUEPRINTS: Record<AgentEvalBenchmarkScenarioKind, BenchmarkScenarioBlueprint> = {
    'form-fill-submit': {
        name: 'Ordinary form fill and submit',
        description: 'Fill the Name field with Alice, click Submit and confirm the recorded result.',
        prompt: 'Fill the Name field with Alice and then click the Submit button. Inspect the page, perform the mutations and verify the actual browser state.',
        plan: {
            fixture: {page: 'benchmark-form', fields: {name: 'Before'}, buttons: ['submit']},
            actions: [
                {op: 'fill', key: 'name', value: 'Alice'},
                {op: 'click', key: 'submit'},
            ],
        },
        expected: {name: 'Alice', result: 'submit'},
    },
    'failed-mutation-recovery': {
        name: 'Recoverable failed mutation',
        description: 'The first Email mutation fails without changing the world; the agent must retry and succeed.',
        prompt: 'Set the Email field to a@b.test. If the mutation reports a failure, re-check the actual page state and complete the mutation once more.',
        plan: {
            fixture: {page: 'benchmark-form', fields: {email: ''}, buttons: ['submit']},
            actions: [{op: 'fill', key: 'email', value: 'a@b.test'}],
            faults: [{kind: 'mutation-failed', actionIndex: 0}],
        },
        expected: {email: 'a@b.test'},
    },
    'side-effect-compensation': {
        name: 'Side-effect-on-error compensation',
        description: 'A fill reports failure after already mutating the page; the agent must compensate the stray effect.',
        prompt: 'Set the Name field on the current page from Before to Alice. A fault may cause the mutation operation to report failure after its side effect already happened. If any mutation reports failure, do not retry it; restore the Name field to Before, verify the actual browser state and report the recovery result.',
        plan: {
            fixture: {page: 'benchmark-form', fields: {name: 'Before'}, buttons: ['submit']},
            actions: [{op: 'fill', key: 'name', value: 'Alice'}],
            faults: [{kind: 'error-after-effect', actionIndex: 0}],
            compensate: true,
        },
        expected: {name: 'Before'},
    },
    'drift-stale-target': {
        name: 'Drift/stale target recovery',
        description: 'The page replaces the Name node mid-task; the agent must re-resolve the drifted target and retry.',
        prompt: 'Fill the Name field with Alice. The page may replace field nodes under you; if a mutation fails because the resolved target is stale, re-resolve the current Name field and retry exactly once.',
        plan: {
            fixture: {page: 'benchmark-form', fields: {name: 'Before'}, buttons: ['submit']},
            actions: [{op: 'fill', key: 'name', value: 'Alice'}],
            faults: [{kind: 'stale-target', actionIndex: 0}],
        },
        expected: {name: 'Alice'},
    },
    'multi-step-order': {
        name: 'Multi-step order form workflow',
        description: 'Fill Name and Country, then Submit; all three world effects must land.',
        prompt: 'Fill the Name field with Alice, fill the Country field with NL, then click the Submit button and confirm the page recorded the submission.',
        plan: {
            fixture: {page: 'benchmark-order', fields: {name: 'Before', country: ''}, buttons: ['submit']},
            actions: [
                {op: 'fill', key: 'name', value: 'Alice'},
                {op: 'fill', key: 'country', value: 'NL'},
                {op: 'click', key: 'submit'},
            ],
        },
        expected: {name: 'Alice', country: 'NL', result: 'submit'},
    },
};

export type AgentEvalWorldAccessor = () => AgentEvalWorld | Promise<AgentEvalWorld>;

export type CreateBenchmarkScenarioOptions = Readonly<{
    kind: AgentEvalBenchmarkScenarioKind;
    provider: string;
    model: string;
    world: AgentEvalWorldAccessor;
    seed?: number;
    modes?: readonly AgentEvalMode[];
    trials?: number;
    systemPrompt?: string;
}>;

/**
 * Build one versioned benchmark scenario. The verifier is external: it only
 * inspects world state through the shared browser-world port and never reads
 * the model's `result.text`.
 */
export const createAgentEvalBenchmarkScenario = (
    options: CreateBenchmarkScenarioOptions,
): AgentEvalScenario => {
    const blueprint = BLUEPRINTS[options.kind];
    const seed = options.seed ?? 0;
    const loadFixture = async (trialIndex: number): Promise<void> => {
        const world = await options.world();
        world.reseed(deriveTrialSeed(seed, options.kind, trialIndex));
        await world.load(blueprint.plan.fixture);
    };

    return {
        version: AGENT_EVAL_SCENARIO_CONTRACT_VERSION,
        id: options.kind,
        name: blueprint.name,
        description: blueprint.description,
        modes: options.modes ?? ['program', 'react-baseline'],
        trials: options.trials ?? 1,
        task: {
            id: options.kind,
            prompt: blueprint.prompt,
            provider: options.provider,
            model: options.model,
            input: {plan: blueprint.plan},
            ...(options.systemPrompt ? {systemPrompt: options.systemPrompt} : {}),
            prepare: async (_mode, trialIndex) => {
                await loadFixture(trialIndex);
            },
            verify: async () => {
                const world = await options.world();
                const values: Record<string, string> = {};
                for (const key of Object.keys(blueprint.expected)) {
                    const value = await world.read(world.field(key));
                    values[key] = value ?? '';
                }
                const passed = Object.entries(blueprint.expected)
                    .every(([key, expected]) => values[key] === expected);
                return {passed, evidence: {values, fixture: blueprint.plan.fixture.page}};
            },
        },
    };
};

export const createAllBenchmarkScenarios = (
    options: Omit<CreateBenchmarkScenarioOptions, 'kind'>,
): AgentEvalScenario[] =>
    BENCHMARK_SCENARIO_KINDS.map((kind) => createAgentEvalBenchmarkScenario({...options, kind}));
