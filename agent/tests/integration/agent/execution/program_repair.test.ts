import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createFauxCore,
    fauxAssistantMessage,
    fauxToolCall,
} from '@earendil-works/pi-ai';
import type {StreamFn} from '@earendil-works/pi-agent-core';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import type {AgentProgramExecutor} from '../../../../src/agent/execution/program/contracts';
import type {AgentProgramSaveRequest} from '../../../../src/agent/execution/program/persistence';
import {createDslDebugExecutionSession} from '../../../../src/agent/debug/execution/dsl_session';
import type {DslDebugExecutionSession} from '../../../../src/agent/debug/execution/contracts';
import type {WorldView} from '../../../../src/agent/worldview/contracts';
import type {DslEntityRulesProfile, DslEntityRulesResolver} from '../../../../src/automation/dsl/link';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import type {RuntimeStateRecord} from '../../../../src/automation/snapshot/observation/model/contracts';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps';
import type {StepExecutionPort} from '../../../../src/automation/dsl/runtime/run_dsl';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const source = [
    'use entity_rules "semantic-order-page" as order',
    'fill order.orderForm.buyer with input.value',
    'output done = input.done',
].join('\n');

const withRuntimeValue = (
    view: WorldView,
    value: string,
    captureRevision: number,
): WorldView => {
    const entry = structuredClone(view.entry);
    const runtimeState = entry.capture.control.observation.runtimeState as unknown as Record<
        string,
        RuntimeStateRecord | undefined
    >;
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
        workspaceName: 'ws-program-repair',
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

const entityRulesResolver = (): DslEntityRulesResolver => {
    const profile: DslEntityRulesProfile = {
        profileName: 'semantic-order-page',
        entities: [{
            entityKey: 'orderForm',
            businessTag: 'order.form',
            kind: 'form',
            fields: [{
                fieldKey: 'buyer',
                targetKind: 'form.field',
                effect: {reversibility: 'reversible'},
            }],
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

const rollbackAnchorId = (context: unknown): string => {
    const systemPrompt = (context as {systemPrompt?: unknown}).systemPrompt;
    if (typeof systemPrompt !== 'string') {throw new Error('failure system prompt is missing');}
    const match = /rollbackAnchor is \{[^}]*"id":"([^"]+)"/u.exec(systemPrompt);
    if (!match) {throw new Error(`rollbackAnchor id not found in system prompt: ${systemPrompt}`);}
    return match[1];
};

test('program-first Agent restores World, rewinds the Program point, patches it, and resumes in one ReAct session', async () => {
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
                        meta: {
                            pageEpoch: before.revision.pageEpoch,
                            captureRevision: before.revision.captureRevision,
                        },
                    },
                };
            }
            if (step.name !== 'browser.fill') {throw new Error(`unexpected step: ${step.name}`);}
            values.push(step.args.value);
            current = afterFill;
            return {
                stepId: step.id,
                ok: false,
                error: {code: 'ERR_INJECTED_POST_EFFECT', message: 'fill failed after mutation'},
            };
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
    const retained = {session: null as DslDebugExecutionSession | null};
    const executeProgram: AgentProgramExecutor = async (program) => {
        assert.equal(program.source, source);
        const session = createDslDebugExecutionSession({
            source: program.source,
            context: {
                workspaceName: 'ws-program-repair',
                deps: {} as RunStepsDeps,
                input: structuredClone(program.input),
                entityRulesResolver: entityRulesResolver(),
                stepExecutionPort: programPort,
            },
            compensationPort,
            worldViewSource: {pin: async () => current},
            debug: {
                initialMode: 'continue',
                breakOnFailure: true,
                barrierOn: ['unknown', 'compensatable', 'irreversible'],
                barrierResumeMode: 'continue',
            },
        });
        retained.session = session;
        const pause = await session.waitForPause();
        assert.equal(pause.reason, 'failure');
        return {
            summary: {...program, status: 'paused', effects: []},
            debug: {session, pause},
        };
    };

    const faux = createFauxCore({provider: 'faux-repair', models: [{id: 'repair'}]});
    let modelTurn = 0;
    const streamFn: StreamFn = (model, context, options) => {
        modelTurn += 1;
        const response = modelTurn === 1
            ? fauxAssistantMessage(fauxToolCall('agent.execute_program', {
                source,
                input: {value: 'new value', done: true},
            }))
            : modelTurn === 2
                ? fauxAssistantMessage(fauxToolCall('debug.rewind', {
                    savepointId: rollbackAnchorId(context),
                    strategy: 'physical',
                }))
                : modelTurn === 3
                    ? fauxAssistantMessage(fauxToolCall('debug.patch_program', {
                        programId: 'main',
                        path: 'body.0',
                        source: 'output repaired = input.done',
                    }))
                    : modelTurn === 4
                        ? fauxAssistantMessage(fauxToolCall('debug.continue', {}))
                        : modelTurn === 5
                            ? fauxAssistantMessage(fauxToolCall('agent.save_program', {name: 'repaired-flow'}))
                            : fauxAssistantMessage('World restored, failing statement patched, repaired Program completed and saved.');
        faux.setResponses([response]);
        return faux.streamSimple(model, context, options);
    };
    const saves: AgentProgramSaveRequest[] = [];
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram,
        saveProgram: async (request) => {
            saves.push(request);
            return {status: 'saved', name: request.name, artifactRevision: 'revision-repaired'};
        },
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-repair' && model === 'repair'
                ? {model: faux.getModel(), streamFn}
                : null,
        },
    });

    const result = await runner.run({
        prompt: 'Repair the failed reversible fill without repeating its side effect, then save the repaired Program as repaired-flow.',
        provider: 'faux-repair',
        model: 'repair',
    });

    assert.equal(result.text, 'World restored, failing statement patched, repaired Program completed and saved.');
    assert.deepEqual(result.trace.tools.map((tool) => tool.toolName), [
        'agent.execute_program',
        'debug.rewind',
        'debug.patch_program',
        'debug.continue',
        'agent.save_program',
    ]);
    assert.equal(result.trace.metrics.failedToolCalls, 0);
    assert.deepEqual(values, ['new value', 'old value']);
    assert.equal(queryCalls, 1);
    assert.equal(current.revision.captureRevision, 3);
    assert.equal(result.programs?.length, 1);
    assert.equal(result.programs?.[0].status, 'completed');
    assert.equal(result.programs?.[0].text, '{"repaired":true,"done":true}');
    assert.equal(result.programs?.[0].materializedSource, [
        'use entity_rules "semantic-order-page" as order',
        'output repaired = input.done',
        'output done = input.done',
    ].join('\n'));
    assert.deepEqual(saves, [{
        name: 'repaired-flow',
        source: result.programs?.[0].materializedSource,
    }]);
    assert.deepEqual(result.savedPrograms, [{
        name: 'repaired-flow',
        artifactRevision: 'revision-repaired',
    }]);
    assert.deepEqual(result.programs?.[0].effects?.map((effect) => ({
        status: effect.status,
        compensates: effect.compensates,
    })), [
        {status: 'failed', compensates: undefined},
        {status: 'succeeded', compensates: 1},
    ]);
    const retainedSession = retained.session;
    assert.ok(retainedSession);
    assert.equal(retainedSession.materializeProgram(), [
        'use entity_rules "semantic-order-page" as order',
        'output repaired = input.done',
        'output done = input.done',
    ].join('\n'));
});
