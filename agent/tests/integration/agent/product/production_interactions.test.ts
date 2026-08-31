import test from 'node:test';
import assert from 'node:assert/strict';
import type {StepUnion} from '../../../../src/automation/runner/steps/types';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps_types';
import type {WorldView} from '../../../../src/agent/worldview/contracts';
import type {WorkspaceEntityRulesProvider} from '../../../../src/automation/snapshot/rules/runtime/contracts';
import type {WorkflowEntityRules} from '../../../../src/automation/workflow';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import {createPortAllocator} from '../../../../src/automation/runtime/service/ports';
import {createWorkspaceProgramExecutor} from '../../../../src/agent/workspace/program_executor';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import {createWorkspaceAgentService} from '../../../../src/agent/service/runtime';
import {createProductController} from '../../../../src/agent/product/controller';
import type {AgentTaskView} from '../../../../src/agent/product/types';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';
import {createScriptedModelRuntime, assistant, tool, lastToolResult, parseExecuteProgramOutcome, type ModelScript} from '../../../helpers/agent_product_faux';

const emptyCheckpointProvider = {
    getCheckpoint: () => null,
    getCheckpointResolves: () => null,
    getCheckpointBody: () => null,
    listCheckpoints: () => [],
};

const irreversibleRulesProvider: WorkspaceEntityRulesProvider = {
    availability: 'ready',
    workflowName: 'ws-prod',
    listProfiles: () => ['orders'],
    getProfile: (name) => name === 'orders' ? ({
        kind: 'entity_rules',
        name,
        page: {kind: 'form'},
        match: {version: 2, rules: [
            {ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'form'}},
            {ruleId: 'name', source: 'node', expect: 'unique', within: 'root', match: {nameEquals: 'orderNo'}},
            {ruleId: 'submit', source: 'node', expect: 'unique', within: 'root', match: {textContains: '提交'}},
        ]},
        annotation: {version: 2, bindings: [
            {ruleId: 'root', entityKey: 'orderForm', businessTag: 'order.form', entityKind: 'form'},
            {ruleId: 'name', fieldKey: 'name', effect: {reversibility: 'reversible'}},
            {ruleId: 'submit', actionIntent: 'submit', effect: {reversibility: 'irreversible'}},
        ]},
    }) as WorkflowEntityRules : null,
    resolveExports: (profileName) => ({
        index: {
            profileName,
            entities: [{
                profileName,
                entityKey: 'orderForm',
                businessTag: 'order.form',
                kind: 'form',
                fields: [{
                    fieldKey: 'name',
                    targetKind: 'form.field',
                    effect: {reversibility: 'reversible'},
                }],
                actions: [{
                    actionIntent: 'submit',
                    targetKind: 'form.action',
                    effect: {reversibility: 'irreversible'},
                }],
                columns: [],
                rowActions: [],
                supportedQueries: [],
                members: [
                    {kind: 'field', symbol: 'name'},
                    {kind: 'action', symbol: 'submit'},
                ],
            }],
            resolve: (entityKey, symbol) =>
                entityKey === 'orderForm' && (symbol === 'submit' || symbol === 'name')
                    ? {kind: symbol === 'submit' ? 'action' : 'field', symbol}
                    : undefined,
        },
        diagnostics: [],
    }),
};

const buildWorkspaceExecutor = async (clickCalls: string[]) => {
    const pluginHost = {
        getExecutors: () => ({
            'browser.query': async (step: StepUnion) => ({
                stepId: step.id,
                ok: true,
                data: {kind: 'nodeId', nodeId: 'submit'},
            }),
            'browser.click': async (step: StepUnion) => {
                clickCalls.push(step.name);
                return {stepId: step.id, ok: true, data: {clicked: true}};
            },
            'browser.fill': async (step: StepUnion) => ({stepId: step.id, ok: true, data: {filled: true}}),
        }),
    } as unknown as RunStepsDeps['pluginHost'];

    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const worldView: WorldView = Object.freeze({
        workspaceName: 'ws-prod',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });

    const deps = completeRunStepsDeps({
        pluginHost,
        resolveEntityRulesProvider: () => irreversibleRulesProvider,
        pageSession: {ensureFresh: async () => entry},
    } as never);
    const baseWorkspace = deps.resolveWorkspace('ws-prod');
    deps.resolveWorkspace = ((name: string) => ({
        ...(baseWorkspace as object),
        name,
        workflow: {name},
        checkpoint: {getProvider: () => emptyCheckpointProvider},
        entityRules: {getProvider: () => irreversibleRulesProvider},
    })) as never;

    return {
        executor: createWorkspaceProgramExecutor({
            workspaceName: 'ws-prod',
            deps,
            runWorkspaceExecution: async <T>(_actionType: string, run: () => Promise<T>): Promise<T> => await run(),
            worldViewSource: {pin: async () => worldView},
        }),
        clickCalls,
    };
};

const IRREVERSIBLE_SOURCE = [
    'use entity_rules "orders" as order',
    'click order.orderForm.submit',
    'output done = input.done',
].join('\n');

const REVERSIBLE_SOURCE = [
    'use entity_rules "orders" as order',
    'fill order.orderForm.name with input.value',
    'output done = input.done',
].join('\n');

const userTextIncludes = (messages: readonly unknown[], needle: string): boolean =>
    messages.some((message) => {
        const candidate = message as {role?: string; content?: unknown};
        if (candidate.role !== 'user') {return false;}
        const content = candidate.content;
        if (typeof content === 'string') {return content.includes(needle);}
        if (Array.isArray(content)) {
            return content.some((block) => block !== null && typeof block === 'object' && 'text' in block
                && String((block as {text: unknown}).text).includes(needle));
        }
        return false;
    });

const buildService = async (script: ModelScript) => {
    const {executor, clickCalls} = await buildWorkspaceExecutor([]);
    const faux = createScriptedModelRuntime(script);
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: executor,
        modelRuntime: faux.runtime,
    });
    const service = createWorkspaceAgentService({
        workspaceName: 'ws-prod',
        portAllocator: createPortAllocator(27900),
        runner,
    });
    const controller = createProductController({
        manager: service.sessions,
        workspace: 'ws-prod',
        defaults: {provider: faux.provider, model: faux.model},
    });
    return {service, controller, faux, clickCalls};
};

const waitForSettled = async (
    controller: ReturnType<typeof createProductController>,
    taskId: string,
): Promise<AgentTaskView> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const view = controller.taskView(taskId);
        if (view && view.status !== 'running') {return view;}
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`task ${taskId} did not settle within timeout`);
};

const clarificationScript: ModelScript = (context) => {
    if (userTextIncludes(context.messages, 'answered the clarification')) {
        const last = lastToolResult(context.messages);
        if (last?.toolName === 'agent.execute_program') {return assistant('done');}
        return tool('agent.execute_program', {source: REVERSIBLE_SOURCE, input: {value: 'ACME', done: true}});
    }
    return tool('agent.request_interaction', {
        kind: 'clarification',
        question: 'Which delivery date?',
        schema: {field: 'date', type: 'date'},
    });
};

test('a model-requested clarification becomes a product card without any manager injection', async () => {
    const {service, controller, faux} = await buildService(clarificationScript);
    try {
        const view = controller.startTask({prompt: 'fill the order form'});
        const task = await waitForSettled(controller, view.taskId);
        assert.equal(task.status, 'waiting_for_user');
        assert.equal(task.phase, 'interacting');
        assert.equal(task.interaction?.kind, 'clarification');
        if (task.interaction?.kind === 'clarification') {
            assert.equal(task.interaction.question, 'Which delivery date?');
            assert.equal(task.interaction.schema.type, 'date');
            assert.ok(task.interaction.interactionToken.length > 0, 'an opaque token is projected');
        }

        const answered = await controller.answerTask({
            taskId: view.taskId,
            interactionToken: task.interaction!.interactionToken,
            value: '2026-09-01',
        });
        assert.equal(answered!.status, 'completed');
        const serialized = JSON.stringify(controller.taskView(view.taskId));
        assert.equal(serialized.includes('sessionId'), false);
        assert.equal(serialized.includes('continuationId'), false);
        void faux;
        void service;
    } finally {
        await service.stop();
    }
});

const takeoverScript: ModelScript = (context) => {
    if (userTextIncludes(context.messages, 'returned control')) {
        return assistant('replanning from the current page');
    }
    const last = lastToolResult(context.messages);
    if (!last) {
        return tool('agent.execute_program', {source: IRREVERSIBLE_SOURCE, input: {done: true}});
    }
    if (last.toolName === 'agent.execute_program') {
        const outcome = parseExecuteProgramOutcome(last.text);
        if (outcome?.status === 'paused' && outcome.pause?.reason === 'barrier') {
            return tool('agent.request_interaction', {
                kind: 'takeover',
                reason: '2FA required',
                scope: 'workspace',
                guidanceModes: ['manual', 'teach'],
            });
        }
        return assistant('done');
    }
    return assistant('done');
};

test('a model-requested takeover projects a card, marks human control, and never leaves an orphan after return', async () => {
    const {service, controller, clickCalls} = await buildService(takeoverScript);
    try {
        const view = controller.startTask({prompt: 'checkout the order'});
        const task = await waitForSettled(controller, view.taskId);
        assert.equal(task.status, 'waiting_for_user');
        assert.equal(task.interaction?.kind, 'takeover');
        if (task.interaction?.kind === 'takeover') {
            assert.equal(task.interaction.reason, '2FA required');
            assert.deepEqual(task.interaction.guidanceModes, ['manual', 'teach']);
            assert.equal(task.interaction.stage, 'offered');
        }
        assert.deepEqual(clickCalls, [], 'no irreversible effect ran before takeover');

        const active = controller.beginGuidanceTask({
            taskId: view.taskId,
            interactionToken: task.interaction!.interactionToken,
            mode: 'manual',
        });
        assert.equal(active!.status, 'waiting_for_user');
        if (active!.interaction?.kind === 'takeover') {
            assert.equal(active!.interaction.stage, 'active');
        }
        assert.equal(service.sessions.activityReservation().humanControl, 'manual');

        const returned = await controller.returnControlTask({
            taskId: view.taskId,
            interactionToken: active!.interaction!.interactionToken,
            mode: 'manual',
        });
        assert.equal(service.sessions.activityReservation().humanControl, 'none', 'return control clears human control');
        assert.equal(returned!.status, 'waiting_for_user', 'the still-paused barrier asks for approval, never an orphan');
        assert.equal(returned!.interaction?.kind, 'approval', 'the retained barrier surfaces as the next card');
        assert.deepEqual(clickCalls, [], 'return control must not replay or cross the irreversible effect');
    } finally {
        await service.stop();
    }
});

const recoveryScript: ModelScript = (context) => {
    if (userTextIncludes(context.messages, 'chose recovery option')) {
        return assistant('recovery executed');
    }
    return tool('agent.request_interaction', {
        kind: 'recovery_decision',
        failureSummary: 'step failed',
        options: [{id: 'retry', kind: 'retry', label: 'Retry', eligible: true}],
    });
};

test('a model-requested recovery decision projects its options and the choice completes the task', async () => {
    const {service, controller} = await buildService(recoveryScript);
    try {
        const view = controller.startTask({prompt: 'recover the failed step'});
        const task = await waitForSettled(controller, view.taskId);
        assert.equal(task.status, 'waiting_for_user');
        assert.equal(task.interaction?.kind, 'recovery_decision');
        if (task.interaction?.kind === 'recovery_decision') {
            assert.equal(task.interaction.failureSummary, 'step failed');
            assert.equal(task.interaction.options[0].id, 'retry');
            assert.equal(task.interaction.options[0].label, 'Retry');
            assert.equal(task.interaction.options[0].eligible, true);
        }

        const chosen = await controller.chooseRecoveryTask({
            taskId: view.taskId,
            interactionToken: task.interaction!.interactionToken,
            optionId: 'retry',
        });
        assert.equal(chosen!.status, 'completed');
        assert.equal(controller.taskView(view.taskId)!.interaction, undefined);
    } finally {
        await service.stop();
    }
});

const approvalFabricationScript: ModelScript = (context) => {
    const last = lastToolResult(context.messages);
    if (!last) {
        return tool('agent.request_interaction', {
            kind: 'approval',
            actionName: 'browser.click',
            summary: 'fabricated irreversible effect',
            risk: 'irreversible',
        });
    }
    return assistant('approval cannot be requested');
};

test('a model attempt to fabricate an approval creates no interaction and no card', async () => {
    const {service, controller, clickCalls} = await buildService(approvalFabricationScript);
    try {
        const view = controller.startTask({prompt: 'fabricate an approval'});
        const task = await waitForSettled(controller, view.taskId);
        assert.equal(task.status, 'completed');
        assert.equal(task.interaction, undefined, 'no fabricated approval card is projected');
        assert.equal(service.sessions.listInteractions(view.taskId)!.length, 0, 'no InteractionRecord was created');
        assert.deepEqual(clickCalls, [], 'no effect was crossed');
        assert.equal(controller.workspaceView().reservation.owner, 'none', 'the reservation is released');
    } finally {
        await service.stop();
    }
});