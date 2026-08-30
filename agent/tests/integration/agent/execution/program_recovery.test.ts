import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import {createWorkspaceProgramExecutor} from '../../../../src/agent/workspace/program_executor';
import type {AgentProgramExecutor} from '../../../../src/agent/execution/program/contracts';
import type {WorldView} from '../../../../src/agent/worldview/contracts';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps';
import type {StepUnion} from '../../../../src/automation/runner/steps/types';
import type {Checkpoint} from '../../../../src/automation/runner/checkpoint/types';
import type {DslCheckpointProvider} from '../../../../src/automation/dsl/emit';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import type {WorkspaceEntityRulesProvider} from '../../../../src/automation/snapshot/rules/runtime/contracts';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const PROGRAM_SOURCE = [
    'let rows = query table "order.list" currentRows',
    'output done = input.done',
].join('\n');

const RECOVERY_BODY = [
    'use entity_rules "orders-reversible" as orders',
    'click orders.orderForm.submit',
    'output recovered = input.done',
].join('\n');

const RECOVERY_CHECKPOINT: Checkpoint = {
    id: 'recovery-1',
    kind: 'recovery',
    name: 'repair order table',
    input: {done: true},
    trigger: {matchRules: [{errorCode: 'ERR_NOT_FOUND'}, {stepName: 'browser.query'}]},
    policy: {maxAttempts: 1, retryOriginal: true},
    body: {language: 'dsl', source: 'body.dsl'},
};

const reversiblePageKnowledge: WorkspaceEntityRulesProvider = {
    availability: 'ready',
    workflowName: 'ws-program-recovery',
    listProfiles: () => ['orders-reversible'],
    getProfile: (profileName) => profileName === 'orders-reversible' ? ({kind: 'entity_rules', name: profileName} as any) : null,
    resolveExports: (profileName) => {
        if (profileName !== 'orders-reversible') {
            return {
                index: null,
                diagnostics: [{code: 'entity_rule_exports.profile_not_found', message: `profile not found: ${profileName}`}],
            };
        }
        const members = [
            {kind: 'action' as const, symbol: 'submit'},
            {kind: 'query' as const, symbol: 'fields'},
            {kind: 'query' as const, symbol: 'actions'},
        ];
        const entity = {
            profileName,
            entityKey: 'orderForm',
            businessTag: 'order.form',
            kind: 'form' as const,
            fields: [],
            actions: [{
                actionIntent: 'submit',
                targetKind: 'form.action' as const,
                effect: {reversibility: 'reversible' as const},
            }],
            columns: [],
            rowActions: [],
            supportedQueries: ['form.fields', 'form.actions'],
            members,
        };
        return {
            index: {
                profileName,
                entities: [entity],
                resolve: (entityKey: string, symbol: string) =>
                    entityKey === entity.entityKey ? members.find((member) => member.symbol === symbol) : undefined,
            },
            diagnostics: [],
        };
    },
};

const buildView = async (): Promise<WorldView> => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    return Object.freeze({
        workspaceName: 'ws-program-recovery',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

const createHarness = async (options: {checkpoint?: Checkpoint; body?: string} = {}) => {
    const recoveryCheckpoint = options.checkpoint ?? RECOVERY_CHECKPOINT;
    const recoveryBody = options.body ?? RECOVERY_BODY;
    const initial = await buildView();
    let current = initial;
    let queryFailed = false;
    const clicks: string[] = [];
    const queryCalls: string[] = [];
    const deps = completeRunStepsDeps({
        config: {} as any,
        pluginHost: {
            getExecutors: () => ({
                'browser.query': async (step: StepUnion) => {
                    const args = step.args as {query?: string; businessTag?: string};
                    queryCalls.push(args.query ?? '');
                    if (args.query === 'table.currentRows') {
                        if (!queryFailed) {
                            queryFailed = true;
                            return {stepId: step.id, ok: false, error: {code: 'ERR_NOT_FOUND', message: 'table not ready'}};
                        }
                        return {stepId: step.id, ok: true, data: {kind: 'value', value: [{id: 'row-1'}]}};
                    }
                    return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'submit-btn'}};
                },
                'browser.click': async (step: StepUnion) => {
                    clicks.push((step.args as {nodeId?: string}).nodeId ?? '');
                    current = await buildView();
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            }) as unknown as RunStepsDeps['pluginHost']['getExecutors'],
        } as any,
    });
    const provider: DslCheckpointProvider = {
        getCheckpoint: (id) => (id === recoveryCheckpoint.id ? recoveryCheckpoint : null),
        getCheckpointResolves: () => null,
        getCheckpointBody: (id) => id === recoveryCheckpoint.id ? {source: recoveryBody, stepResolves: {}} : null,
        listCheckpoints: () => [recoveryCheckpoint],
    };
    deps.resolveEntityRulesProvider = () => reversiblePageKnowledge;
    deps.resolveWorkspace = ((name: string) => ({
        name,
        workflow: {name},
        checkpoint: {getProvider: () => provider},
        entityRules: {getProvider: () => reversiblePageKnowledge},
        tabs: {getActiveTab: () => ({name: 'tab-1', page: {url: () => '/orders'}})},
        browserSession: {pageRegistry: {}},
    }) as unknown) as RunStepsDeps['resolveWorkspace'];
    const executeProgram: AgentProgramExecutor = createWorkspaceProgramExecutor({
        workspaceName: 'ws-program-recovery',
        deps,
        runWorkspaceExecution: async (_actionType, run) => await run(),
        worldViewSource: {pin: async () => current},
    });
    return {executeProgram, clicks, queryCalls, isQueryFailed: () => queryFailed};
};

test('a taught Recovery checkpoint completes a failed retained program inside the same single transaction', async () => {
    const harness = await createHarness();
    const faux = createFauxCore({provider: 'faux-recovery', models: [{id: 'planner'}]});
    let modelTurn = 0;
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: PROGRAM_SOURCE,
            input: {done: true},
        })),
        fauxAssistantMessage('The retained program completed through the taught recovery.'),
    ]);
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: harness.executeProgram,
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-recovery' && model === 'planner'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        prompt: 'Read the orders table and finish.',
        provider: 'faux-recovery',
        model: 'planner',
    });

    assert.equal(result.text, 'The retained program completed through the taught recovery.');
    assert.equal(result.programs?.length, 1, 'only one program transaction is ever started');
    assert.deepEqual(result.trace.tools.map((tool) => tool.toolName), ['agent.execute_program']);
    assert.equal(result.trace.metrics.controlCalls, 1);
    assert.equal(harness.isQueryFailed(), true);
    assert.deepEqual(harness.clicks, ['submit-btn'], 'the recovery effect executes inside the retained transaction');

    const program = result.programs?.[0];
    assert.equal(program?.status, 'completed');
    assert.equal(program?.text, '{"done":true}');
    assert.deepEqual(program?.recovery, {
        checkpointId: 'recovery-1',
        checkpointName: 'repair order table',
        applied: true,
        retried: true,
    });
    assert.deepEqual(program?.effects?.map((effect) => ({
        stepName: effect.stepName,
        status: effect.status,
    })), [
        {stepName: 'browser.click', status: 'succeeded'},
    ]);
});

test('a no-retry taught Recovery handles the failed statement and the retained program completes without re-executing it', async () => {
    const noRetryCheckpoint: Checkpoint = {
        ...RECOVERY_CHECKPOINT,
        id: 'recovery-noretry',
        name: 'repair without retry',
        policy: {maxAttempts: 1, retryOriginal: false},
    };
    const harness = await createHarness({checkpoint: noRetryCheckpoint});
    const faux = createFauxCore({provider: 'faux-recovery', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: PROGRAM_SOURCE,
            input: {done: true},
        })),
        fauxAssistantMessage('The retained program completed after the taught recovery.'),
    ]);
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: harness.executeProgram,
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-recovery' && model === 'planner'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        prompt: 'Read the orders table and finish.',
        provider: 'faux-recovery',
        model: 'planner',
    });

    assert.equal(result.text, 'The retained program completed after the taught recovery.');
    assert.equal(result.programs?.length, 1, 'only one program transaction is ever started');
    assert.deepEqual(result.trace.tools.map((tool) => tool.toolName), ['agent.execute_program']);
    const program = result.programs?.[0];
    assert.equal(program?.status, 'completed');
    assert.equal(program?.text, '{"done":true}');
    assert.deepEqual(program?.recovery, {
        checkpointId: 'recovery-noretry',
        checkpointName: 'repair without retry',
        applied: true,
        retried: false,
    });
    assert.deepEqual(harness.clicks, ['submit-btn']);
    assert.equal(harness.queryCalls.filter((query) => query === 'table.currentRows').length, 1,
        'the failed read is skipped, never re-executed');
});