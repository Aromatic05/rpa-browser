import type {AgentEvalMode, AgentEvalScenario} from '../contracts';
import {AGENT_EVAL_SCENARIO_CONTRACT_VERSION} from '../contracts';
import type {AgentEvalPlanAction} from '../benchmark';
import {deriveTrialSeed} from '../seed';
import type {AgentEvalFixtureSpec} from '../world';
import type {AgentFaultEvent, AgentFaultKind, AgentFaultSpec, AgentFaultWorld} from './contracts';
import {AGENT_FAULT_KINDS} from './contracts';
import type {AgentFaultRecoveryDirective} from './policy_runner';

export type AgentFaultWorldAccessor = () => AgentFaultWorld | Promise<AgentFaultWorld>;

export const AGENT_FAULT_SCENARIO_ID_PREFIX = 'fault-' as const;

export type AgentFaultPlan = Readonly<{
    fixture: string;
    actions: readonly AgentEvalPlanAction[];
    recovery: AgentFaultRecoveryDirective;
    faultKind: AgentFaultKind;
}>;

type FaultBlueprint = Readonly<{
    name: string;
    description: string;
    prompt: string;
    fixture: AgentEvalFixtureSpec;
    actions: readonly AgentEvalPlanAction[];
    recovery: AgentFaultRecoveryDirective;
    trials: number;
    /** Fault script armed per trial; may draw deterministic randomness. */
    faults: (trialIndex: number, world: AgentFaultWorld) => readonly AgentFaultSpec[];
    expected: (trialIndex: number) => Readonly<Record<string, string>>;
    /** External preconditions on the event log; catches un-injected trials. */
    logInvariant: (events: readonly AgentFaultEvent[], trialIndex: number) => boolean;
}>;

const failedAfterApplyOn = (events: readonly AgentFaultEvent[], key: string): boolean =>
    events.some((event) => event.kind === 'fill-failed-after-apply' && event.key === key);

const BLUEPRINTS: Record<AgentFaultKind, FaultBlueprint> = {
    'mutation-report-error': {
        name: 'Mutation applied but tool reported error',
        description: 'The Name fill lands and then reports failure; a transactional agent confirms state and never replays the applied effect.',
        prompt: 'Fill the Name field with Alice, then click Submit. A fault may make the fill report failure after its side effect already landed. Never assume a failure means the world is unchanged: inspect the actual page state and only complete what is missing.',
        fixture: {page: 'fault-form', fields: {name: 'Before'}, buttons: ['submit']},
        actions: [{op: 'fill', key: 'name', value: 'Alice'}, {op: 'click', key: 'submit'}],
        recovery: 'complete-goal',
        trials: 1,
        faults: () => [{kind: 'mutation-report-error', targetKey: 'name'}],
        expected: () => ({name: 'Alice', result: 'submit'}),
        logInvariant: (events) => failedAfterApplyOn(events, 'name'),
    },
    'revision-drift': {
        name: 'Target revision drift between read and effect',
        description: 'The page replaces the Name node between the read and the mutation; the stale handle must be re-resolved, not blindly re-applied.',
        prompt: 'Fill the Name field with Alice. The page may replace field nodes under you. If a mutation fails because the resolved target is stale, re-resolve the current Name field from the live page and retry once.',
        fixture: {page: 'fault-form', fields: {name: 'Before'}, buttons: ['submit']},
        actions: [{op: 'fill', key: 'name', value: 'Alice'}],
        recovery: 'complete-goal',
        trials: 1,
        faults: () => [{kind: 'revision-drift', targetKey: 'name'}],
        expected: () => ({name: 'Alice'}),
        logInvariant: (events) => events.some((event) => event.kind === 'drift' && event.key === 'name'),
    },
    'epoch-navigation': {
        name: 'Page epoch navigation drift',
        description: 'The page navigates between the read and the effect, invalidating every resolved handle; recovery requires rebinding to the new page epoch.',
        prompt: 'Fill the Name field with Alice. The page may navigate to a new document under you, invalidating resolved targets. If a mutation fails after such navigation, rebind to the live page and complete the fill exactly once.',
        fixture: {page: 'fault-form', fields: {name: 'Before'}, buttons: ['submit']},
        actions: [{op: 'fill', key: 'name', value: 'Alice'}],
        recovery: 'complete-goal',
        trials: 1,
        faults: () => [{kind: 'epoch-navigation', targetKey: 'name'}],
        expected: () => ({name: 'Alice'}),
        logInvariant: (events) => events.some((event) => event.kind === 'navigation'),
    },
    'transactional-restore': {
        name: 'Recoverable failed mutation with compensation',
        description: 'The Name mutation lands a stray partial value and reports failure; the agent must undo it back to the pre-effect value.',
        prompt: 'Prepare to set the Name field to Alice. A fault may leave a stray partial effect on the page and then report failure. If a mutation fails after changing the page, do not push toward the goal value; undo the stray effect back to the previously verified Name value and confirm the restored state.',
        fixture: {page: 'fault-form', fields: {name: 'Before'}, buttons: ['submit']},
        actions: [{op: 'fill', key: 'name', value: 'Alice'}],
        recovery: 'restore-previous',
        trials: 1,
        faults: () => [{kind: 'transactional-restore', targetKey: 'name', partialValue: 'Alice~partial'}],
        expected: () => ({name: 'Before'}),
        logInvariant: (events) => failedAfterApplyOn(events, 'name'),
    },
    'compensation-partial-restore': {
        name: 'Compensation failure with partial restore',
        description: 'The first compensation only half-restores the page; the agent must verify the residual diff and complete the restore.',
        prompt: 'Prepare to set the Name field to Alice. A fault may leave a stray partial effect, report failure, and a first undo attempt may itself only partially restore the page. After any failure, re-inspect the actual Name value until it is verifiably back to Before; never stop at a half-restored state.',
        fixture: {page: 'fault-form', fields: {name: 'Before'}, buttons: ['submit']},
        actions: [{op: 'fill', key: 'name', value: 'Alice'}],
        recovery: 'restore-previous',
        trials: 1,
        faults: () => [{
            kind: 'compensation-partial-restore',
            targetKey: 'name',
            partialValue: 'Alice~partial',
            halfRestoredValue: 'HalfRestored',
        }],
        expected: () => ({name: 'Before'}),
        logInvariant: (events) => {
            const failures = events.filter((event) => event.kind === 'fill-failed-after-apply' && event.key === 'name');
            return failures.length >= 2;
        },
    },
    'external-mutation-conflict': {
        name: 'External world mutation between query and transact',
        description: 'An external actor edits the field after the agent reads it; a transactional write must detect the revision conflict instead of clobbering.',
        prompt: 'Read the actual Name value, then set the Name field to Alice. Another actor may edit the page between your read and your mutation. Treat the world as shared: detect that your observation went stale and re-verify against the live page before the value is committed.',
        fixture: {page: 'fault-form', fields: {name: 'Before'}, buttons: ['submit']},
        actions: [{op: 'fill', key: 'name', value: 'Alice'}],
        recovery: 'complete-goal',
        trials: 1,
        faults: () => [{kind: 'external-mutation-conflict', targetKey: 'name', externalValue: 'External-edit'}],
        expected: () => ({name: 'Alice'}),
        logInvariant: (events) => {
            const mutation = events.find((event) => event.kind === 'external-mutate' && event.key === 'name');
            return mutation !== undefined
                && events.some((event) => event.sequence > mutation.sequence && event.kind.startsWith('fill'));
        },
    },
    'ambiguous-timeout': {
        name: 'Ambiguous post-effect timeout',
        description: 'The fill times out; the effect may or may not have landed depending on the trial seed. Recovery must be driven by the observed page state, not by the timeout itself.',
        prompt: 'Fill the Name field with Alice. The mutation may time out with an ambiguous outcome: the effect may or may not have landed. Re-inspect the actual page state after the timeout and end with exactly one applied mutation - neither a duplicate write nor a missing one.',
        fixture: {page: 'fault-form', fields: {name: 'Before'}, buttons: ['submit']},
        actions: [{op: 'fill', key: 'name', value: 'Alice'}],
        recovery: 'complete-goal',
        trials: 2,
        faults: (trialIndex) => [{
            kind: 'ambiguous-timeout',
            targetKey: 'name',
            effectApplied: trialIndex % 2 === 0,
        }],
        expected: () => ({name: 'Alice'}),
        logInvariant: (events, trialIndex) => {
            const timeout = events.find((event) => event.reason === 'ERR_FAULT_POST_EFFECT_TIMEOUT');
            if (!timeout) {
                return false;
            }
            return trialIndex % 2 === 0
                ? timeout.kind === 'fill-failed-after-apply'
                : timeout.kind === 'fill-failed-no-effect';
        },
    },
};

export type CreateAgentFaultScenarioOptions = Readonly<{
    kind: AgentFaultKind;
    provider: string;
    model: string;
    world: AgentFaultWorldAccessor;
    seed?: number;
    modes?: readonly AgentEvalMode[];
    trials?: number;
    systemPrompt?: string;
}>;

/**
 * Build one versioned fault-injection scenario. `prepare` arms the fault
 * script on the world port before the agent runs (outside all agent logic),
 * and `verify` judges only externally observed world values and the fault
 * world's event log - never the model's self-report.
 */
export const createAgentEvalFaultScenario = (
    options: CreateAgentFaultScenarioOptions,
): AgentEvalScenario => {
    const blueprint = BLUEPRINTS[options.kind];
    const seed = options.seed ?? 0;
    const scenarioId = `${AGENT_FAULT_SCENARIO_ID_PREFIX}${options.kind}`;

    return {
        version: AGENT_EVAL_SCENARIO_CONTRACT_VERSION,
        id: scenarioId,
        name: blueprint.name,
        description: blueprint.description,
        modes: options.modes ?? ['program', 'react-baseline'],
        trials: options.trials ?? blueprint.trials,
        task: {
            id: scenarioId,
            prompt: blueprint.prompt,
            provider: options.provider,
            model: options.model,
            input: {
                plan: {
                    fixture: blueprint.fixture.page,
                    actions: blueprint.actions,
                    recovery: blueprint.recovery,
                    faultKind: options.kind,
                } satisfies AgentFaultPlan,
            },
            ...(options.systemPrompt ? {systemPrompt: options.systemPrompt} : {}),
            prepare: async (_mode, trialIndex) => {
                const world = await options.world();
                world.reseed(deriveTrialSeed(seed, scenarioId, trialIndex));
                await world.load(blueprint.fixture);
                for (const spec of blueprint.faults(trialIndex, world)) {
                    world.arm(spec);
                }
            },
            verify: async (_result, _mode, trialIndex) => {
                const world = await options.world();
                const values: Record<string, string> = {};
                for (const key of Object.keys(blueprint.expected(trialIndex))) {
                    values[key] = (await world.read(world.field(key))) ?? '';
                }
                const events = world.events();
                const stateOk = Object.entries(blueprint.expected(trialIndex))
                    .every(([key, expected]) => values[key] === expected);
                const evidence = {
                    faultKind: options.kind,
                    trialIndex,
                    trialSeed: deriveTrialSeed(seed, scenarioId, trialIndex),
                    fixture: blueprint.fixture.page,
                    pageEpoch: world.epoch(),
                    baseValues: {...blueprint.fixture.fields},
                    values,
                    events: events.map((event) => ({...event})),
                };
                return {
                    passed: stateOk && blueprint.logInvariant(events, trialIndex),
                    evidence,
                };
            },
        },
    };
};

export const FAULT_SCENARIO_IDS: readonly string[] = AGENT_FAULT_KINDS
    .map((kind) => `${AGENT_FAULT_SCENARIO_ID_PREFIX}${kind}`);

export const createAllAgentEvalFaultScenarios = (
    options: Omit<CreateAgentFaultScenarioOptions, 'kind'>,
): AgentEvalScenario[] =>
    AGENT_FAULT_KINDS.map((kind) => createAgentEvalFaultScenario({...options, kind}));
