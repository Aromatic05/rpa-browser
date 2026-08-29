import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
import {classifyPausedDslDebugToolCall} from '../../../../../src/agent/debug/execution/tool_policy';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import type {DslEntityRulesProfile, DslEntityRulesResolver} from '../../../../../src/automation/dsl/link';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import type {RuntimeStateRecord} from '../../../../../src/automation/snapshot/observation/model/contracts';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import type {StepExecutionPort} from '../../../../../src/automation/dsl/runtime/run_dsl';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const withRuntimeValue = (view: WorldView, value: string, captureRevision: number): WorldView => {
    const entry = structuredClone(view.entry);
    const runtimeState = entry.capture.control.observation.runtimeState as unknown as Record<string, RuntimeStateRecord | undefined>;
    runtimeState['buyer-input'] = {stateId: 'state:buyer-input', value};
    entry.capture.control.observation.identity.captureRevision = captureRevision;
    return Object.freeze({
        ...view,
        revision: Object.freeze({...view.revision, captureRevision}),
        entry,
    });
};

const createViews = async (): Promise<[WorldView, WorldView, WorldView]> => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const base: WorldView = Object.freeze({
        workspaceName: 'ws-rewind-physical',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return [
        withRuntimeValue(base, 'old value', 1),
        withRuntimeValue(base, 'new value', 2),
        withRuntimeValue(base, 'old value', 3),
    ];
};

const resolver = (reversibility: 'reversible' | 'compensatable'): DslEntityRulesResolver => {
    const profile: DslEntityRulesProfile = {
        profileName: 'semantic-order-page',
        entities: [{
            entityKey: 'orderForm',
            businessTag: 'order.form',
            kind: 'form',
            fields: [{fieldKey: 'buyer', targetKind: 'form.field', effect: {reversibility}}],
            actions: [],
            columns: [],
            rowActions: [],
            supportedQueries: ['form.fields'],
        }],
    };
    return {
        resolveProfile: (profileName) => profileName === profile.profileName
            ? {profile, diagnostics: []}
            : {profile: null, diagnostics: []},
    };
};

const createExecution = async (reversibility: 'reversible' | 'compensatable') => {
    const [before, afterFill, afterCompensation] = await createViews();
    let current = before;
    const values: string[] = [];
    let queryCalls = 0;
    const programPort: StepExecutionPort = {
        execute: async (step) => {
            if (step.name === 'browser.query') {
                queryCalls += 1;
                return {
                    stepId: step.id,
                    ok: true,
                    data: {
                        kind: 'nodeId',
                        nodeId: 'buyer-input',
                        meta: {pageEpoch: before.revision.pageEpoch, captureRevision: before.revision.captureRevision},
                    },
                };
            }
            if (step.name !== 'browser.fill') {throw new Error(`unexpected step: ${step.name}`);}
            values.push(step.args.value);
            current = afterFill;
            return {stepId: step.id, ok: true, data: {filled: true}};
        },
    };
    const compensationPort: StepExecutionPort = {
        execute: async (step) => {
            if (step.name !== 'browser.fill') {throw new Error(`unexpected compensation: ${step.name}`);}
            values.push(step.args.value);
            current = afterCompensation;
            return {stepId: step.id, ok: true, data: {filled: true}};
        },
    };
    const execution = createDslDebugExecutionSession({
        source: `
            use entity_rules "semantic-order-page" as order
            fill order.orderForm.buyer with input.value
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-rewind-physical',
            deps: {} as RunStepsDeps,
            input: {value: 'new value', done: true},
            entityRulesResolver: resolver(reversibility),
            stepExecutionPort: programPort,
        },
        compensationPort,
        worldViewSource: {pin: async () => current},
        debug: {initialMode: 'step', breakBeforeEffects: true, breakpoints: ['body.1']},
    });
    return {execution, values, getQueryCalls: () => queryCalls};
};

test('physical rewind resumes only after explicitly reversible compensation is semantically verified', async () => {
    const {execution, values, getQueryCalls} = await createExecution('reversible');
    const statement = await execution.waitForPause();
    assert.equal(statement.reason, 'statement');
    const savepoint = execution.savepoint(statement.continuationId, 'before-fill');

    const effect = await execution.advance(statement.continuationId, 'step');
    assert.equal(effect.status, 'paused');
    if (effect.status !== 'paused') {throw new Error('expected effect pause');}
    const afterFill = await execution.advance(effect.pause.continuationId, 'continue');
    assert.equal(afterFill.status, 'paused');
    if (afterFill.status !== 'paused') {throw new Error('expected output pause');}
    assert.deepEqual(values, ['new value']);

    const rewound = await execution.rewind(afterFill.pause.continuationId, savepoint.id, {strategy: 'physical'});
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected verified rewind');}
    assert.equal(rewound.pause.location.path, 'body.0');
    assert.deepEqual(values, ['new value', 'old value']);
    assert.equal(getQueryCalls(), 1);

    const rollbackEffects = execution.effects(rewound.pause.continuationId);
    assert.equal(rollbackEffects.length, 2);
    assert.equal(rollbackEffects[0].effect.semantics.reversibility, 'reversible');
    assert.deepEqual(rollbackEffects[1].compensates, {effectSequence: 1});
    await execution.advance(rewound.pause.continuationId, 'abort');
});

test('compensatable effect remains blocked from rewind even after successful physical compensation', async () => {
    const {execution, values} = await createExecution('compensatable');
    const statement = await execution.waitForPause();
    const savepoint = execution.savepoint(statement.continuationId, 'before-fill');
    const effect = await execution.advance(statement.continuationId, 'step');
    assert.equal(effect.status, 'paused');
    if (effect.status !== 'paused') {throw new Error('expected effect pause');}
    const afterFill = await execution.advance(effect.pause.continuationId, 'continue');
    assert.equal(afterFill.status, 'paused');
    if (afterFill.status !== 'paused') {throw new Error('expected output pause');}

    const rewind = await execution.rewind(afterFill.pause.continuationId, savepoint.id, {strategy: 'physical'});
    assert.equal(rewind.status, 'blocked');
    if (rewind.status !== 'blocked') {throw new Error('expected blocked rewind');}
    assert.equal(rewind.rollback.status, 'compensated');
    if (rewind.rollback.status === 'compensated') {
        assert.equal(rewind.rollback.semanticRisk, 'compensatable');
    }
    assert.deepEqual(values, ['new value', 'old value']);
    assert.equal(execution.history(afterFill.pause.continuationId).records.length, 1);
    await execution.advance(afterFill.pause.continuationId, 'abort');
});

test('debug.rewind physical strategy updates Agent tools only after verified reversible restore', async () => {
    const {execution, values} = await createExecution('reversible');
    const statement = await execution.waitForPause();
    const tools = createPausedDslDebugAgentTools(execution, statement);
    const tool = (name: string) => tools.tools.find((candidate) => candidate.name === name)!;
    const saved = await tool('debug.savepoint').execute('save', {name: 'before-fill'});
    const savepointId = (saved.details as any).savepoint.id as string;

    await tool('debug.step').execute('step-to-effect', {});
    await tool('debug.continue').execute('run-fill', {});
    const blocked = await tool('debug.rewind').execute('rewind-none', {savepointId});
    assert.equal((blocked.details as any).status, 'blocked');
    assert.equal(tools.readPause()?.location.path, 'body.1');

    const rewound = await tool('debug.rewind').execute('rewind-physical', {
        savepointId,
        strategy: 'physical',
    });
    assert.equal((rewound.details as any).status, 'rewound');
    assert.equal((rewound.details as any).pause.location.path, 'body.0');
    assert.equal(tools.readPause()?.location.path, 'body.0');
    assert.deepEqual(values, ['new value', 'old value']);
    assert.equal(classifyPausedDslDebugToolCall('debug.rewind'), 'control');
    await tool('debug.abort').execute('abort', {});
});
