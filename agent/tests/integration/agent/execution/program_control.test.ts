import test from 'node:test';
import assert from 'node:assert/strict';
import type {StepUnion} from '../../../../src/automation/runner/steps/types';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps_types';
import type {WorldView} from '../../../../src/agent/worldview/contracts';
import type {WorkspaceEntityRulesProvider} from '../../../../src/automation/snapshot/rules/runtime/contracts';
import type {WorkflowEntityRules} from '../../../../src/automation/workflow';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import {createWorkspaceProgramExecutor} from '../../../../src/agent/workspace/program_executor';
import type {AgentProgramExecutor} from '../../../../src/agent/execution/program/contracts';
import {createProgramFirstAgentRunner, requestInteractionTool, requestInteractionSchema} from '../../../../src/agent/execution/program/runner';
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
    workflowName: 'ws-ctl',
    listProfiles: () => ['orders'],
    getProfile: (name) => ({kind: 'entity_rules', name, match: {}, annotation: {}}) as unknown as WorkflowEntityRules,
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

const buildExecutorOptions = async (clickCalls: string[]) => {
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
        workspaceName: 'ws-ctl',
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
    const baseWorkspace = deps.resolveWorkspace('ws-ctl');
    deps.resolveWorkspace = ((name: string) => ({
        ...(baseWorkspace as object),
        name,
        workflow: {name},
        checkpoint: {getProvider: () => emptyCheckpointProvider},
        entityRules: {getProvider: () => irreversibleRulesProvider},
    })) as never;

    return {
        workspaceName: 'ws-ctl',
        deps,
        runWorkspaceExecution: async <T>(_actionType: string, run: () => Promise<T>): Promise<T> => await run(),
        worldViewSource: {pin: async () => worldView},
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

const defaultScript: ModelScript = (context) => {
    const last = lastToolResult(context.messages);
    if (!last) {
        return tool('agent.execute_program', {source: IRREVERSIBLE_SOURCE, input: {done: true}});
    }
    if (last.toolName === 'agent.execute_program') {
        const outcome = parseExecuteProgramOutcome(last.text);
        if (outcome?.status === 'paused' && outcome.pause?.reason === 'barrier') {
            return assistant('deferring the irreversible effect to the user');
        }
        return assistant('done');
    }
    return assistant('done');
};

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

const buildRunner = async (script: ModelScript = defaultScript) => {
    const clickCalls: string[] = [];
    const executor = createWorkspaceProgramExecutor(await buildExecutorOptions(clickCalls));
    let executeProgramCalls = 0;
    const fake: AgentProgramExecutor = async (program) => {
        executeProgramCalls += 1;
        return executor(program);
    };
    const faux = createScriptedModelRuntime(script);
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram: fake,
        modelRuntime: faux.runtime,
    });
    return {runner, faux, clickCalls, executeProgramCalls: () => executeProgramCalls};
};

test('retained Agent-control continuation re-enters the SAME execution with no second program', async () => {
    const {runner, faux, clickCalls, executeProgramCalls} = await buildRunner();
    const request = {
        prompt: 'approve the irreversible effect',
        provider: faux.provider,
        model: faux.model,
    };

    const result = await runner.run(request);
    assert.equal(result.programs?.[0]?.status, 'paused');
    assert.equal(result.programs?.[0]?.pause?.reason, 'barrier');
    assert.ok(result.continuation, 'the execution continuation must exist on the barrier');
    assert.ok(result.control, 'the retained Agent control continuation must exist');
    assert.equal(executeProgramCalls(), 1, 'the program executor ran exactly once before control');
    assert.deepEqual(clickCalls, [], 'the irreversible effect must not run before approval');

    const initialPrograms = result.programs!;
    const controlled = await result.control!.control({
        kind: 'deny',
        effectName: 'browser.click',
        reason: 'not safe',
        requestedAlternative: 'verify the order first',
    });

    assert.equal(executeProgramCalls(), 1, 'control re-entry must NOT start a second program execution');
    assert.equal(controlled.programs?.length, 1, 'the same single retained program attempt is reused');
    assert.equal(controlled.programs?.[0]?.source, IRREVERSIBLE_SOURCE, 'the retained execution object is unchanged');
    assert.equal(controlled.programs?.[0]?.status, 'paused', 'the denied barrier stays paused; it was never crossed');
    assert.deepEqual(clickCalls, [], 'the denied effect must never execute');
    assert.ok(faux.requestCount() > 1, 'the model was invoked again through the control continuation');
});

test('approval fast path stays on the exact retained execution barrier and crosses once', async () => {
    const {runner, faux, clickCalls, executeProgramCalls} = await buildRunner();
    const result = await runner.run({
        prompt: 'approve the irreversible effect',
        provider: faux.provider,
        model: faux.model,
    });

    assert.ok(result.control);
    assert.ok(result.continuation, 'the approval execution continuation must exist on the barrier');

    const resumed = await result.continuation!.resume();
    assert.equal(executeProgramCalls(), 1, 'approval fast path must not start a second program');
    assert.equal(resumed.programs?.length, 1);
    assert.deepEqual(clickCalls, ['browser.click'], 'approval crosses the exact retained barrier once');
    assert.equal(resumed.programs?.[0]?.status, 'completed');
});

test('the model requests a clarification and the runner yields a typed request that resumes the SAME execution', async () => {
    const {runner, faux, executeProgramCalls} = await buildRunner((context) => {
        if (userTextIncludes(context.messages, 'answered the clarification')) {
            return tool('agent.execute_program', {source: REVERSIBLE_SOURCE, input: {value: 'ACME', done: true}});
        }
        return tool('agent.request_interaction', {
            kind: 'clarification',
            question: 'Which delivery date?',
            schema: {field: 'date', type: 'date'},
        });
    });
    const request = {prompt: 'fill the order form', provider: faux.provider, model: faux.model};

    const result = await runner.run(request);
    assert.ok(result.requestedInteraction, 'the runner must yield a typed request');
    assert.equal(result.requestedInteraction?.kind, 'clarification');
    if (result.requestedInteraction?.kind === 'clarification') {
        assert.equal(result.requestedInteraction.question, 'Which delivery date?');
        assert.equal(result.requestedInteraction.schema.type, 'date');
    }
    assert.ok(result.control, 'the retained control continuation must survive the request');
    assert.equal(executeProgramCalls(), 0, 'no program ran before the clarification');
    assert.ok(faux.requestCount() >= 1);

    const answered = await result.control!.control({
        kind: 'clarification-answer',
        question: 'Which delivery date?',
        answer: '2026-09-01',
    });
    assert.equal(answered.requestedInteraction, undefined, 'the resolved request must not persist');
    assert.equal(answered.programs?.[0]?.status, 'completed', 'the same retained execution continues after the answer');
    assert.equal(executeProgramCalls(), 1, 'the answer must not start a second program or transaction');
});

test('the model requests a takeover while paused at an irreversible barrier without crossing it', async () => {
    const {runner, faux, clickCalls, executeProgramCalls} = await buildRunner((context) => {
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
    });
    const request = {prompt: 'approve the irreversible effect', provider: faux.provider, model: faux.model};
    const run = await runner.run(request);

    assert.equal(run.requestedInteraction?.kind, 'takeover');
    if (run.requestedInteraction?.kind === 'takeover') {
        assert.equal(run.requestedInteraction.reason, '2FA required');
        assert.deepEqual(run.requestedInteraction.guidanceModes, ['manual', 'teach']);
    }
    assert.equal(run.programs?.[0]?.status, 'paused', 'the barrier stays paused');
    assert.equal(run.programs?.[0]?.pause?.risk, 'irreversible');
    assert.deepEqual(clickCalls, [], 'the takeover request must never cross the irreversible effect');
    assert.equal(executeProgramCalls(), 1, 'only the single retained program was started');
    assert.ok(run.control, 'control continuation retained for the takeover');
});

test('the model requests a recovery decision and the choice re-enters the retained control loop', async () => {
    const {runner, faux, executeProgramCalls} = await buildRunner((context) => {
        if (userTextIncludes(context.messages, 'chose recovery option')) {
            return assistant('recovery executed');
        }
        return tool('agent.request_interaction', {
            kind: 'recovery_decision',
            failureSummary: 'step failed',
            options: [{id: 'retry', kind: 'retry', label: 'Retry', eligible: true}],
        });
    });
    const request = {prompt: 'recover the failed step', provider: faux.provider, model: faux.model};

    const result = await runner.run(request);
    assert.equal(result.requestedInteraction?.kind, 'recovery_decision');
    if (result.requestedInteraction?.kind === 'recovery_decision') {
        assert.equal(result.requestedInteraction.options[0].id, 'retry');
        assert.equal(result.requestedInteraction.options[0].eligible, true);
    }
    assert.ok(result.control, 'control continuation retained for the recovery choice');
    assert.equal(executeProgramCalls(), 0, 'no program ran before the recovery decision');

    const chosen = await result.control!.control({
        kind: 'recovery-choice',
        optionId: 'retry',
        optionLabel: 'Retry',
    });
    assert.equal(chosen.requestedInteraction, undefined, 'the resolved choice must not persist');
    assert.equal(executeProgramCalls(), 0, 'recovery choice must not start a second program');
});

test('a model tool call requesting approval is blocked and yields no request', async () => {
    const {runner, faux, clickCalls, executeProgramCalls} = await buildRunner((context) => {
        const last = lastToolResult(context.messages);
        if (!last) {
            return tool('agent.request_interaction', {
                kind: 'approval',
                actionName: 'browser.click',
                summary: 'fabricated irreversible effect',
                risk: 'irreversible',
            });
        }
        return assistant('cannot request approval');
    });
    const request = {prompt: 'attempt to fabricate an approval', provider: faux.provider, model: faux.model};

    const result = await runner.run(request);
    assert.equal(result.requestedInteraction, undefined, 'an approval request must never become a typed request');
    assert.equal(result.control, undefined, 'no continuation is retained for a rejected approval request');
    assert.equal(executeProgramCalls(), 0, 'no program was started');
    assert.deepEqual(clickCalls, [], 'no effect was crossed');
});

type JsonSchemaNode = {
    type?: string;
    const?: unknown;
    enum?: unknown[];
    required?: string[];
    additionalProperties?: boolean;
    minItems?: number;
    minLength?: number;
    items?: JsonSchemaNode;
    properties?: Record<string, JsonSchemaNode>;
    oneOf?: JsonSchemaNode[];
};

const advertisedSchema = JSON.parse(JSON.stringify(requestInteractionSchema)) as JsonSchemaNode;
const branches = advertisedSchema.oneOf ?? [];
const branchByKind = (kind: string): JsonSchemaNode | undefined =>
    branches.find((branch) => branch.properties?.kind?.const === kind);

test('the advertised tool schema exposes exactly the three allowed kinds and never approval', () => {
    assert.equal(advertisedSchema.type, 'object');
    assert.ok(advertisedSchema.required?.includes('kind'), 'kind is the discriminator');
    assert.equal(branches.length, 3, 'exactly three request kinds are advertised');
    const discriminatorKinds = branches.map((branch) => branch.properties?.kind?.const).sort();
    assert.deepEqual(discriminatorKinds, ['clarification', 'recovery_decision', 'takeover']);
    assert.equal(JSON.stringify(advertisedSchema).includes('approval'), false, 'approval is structurally absent');
    assert.equal(requestInteractionTool.parameters !== undefined, true);
});

test('the advertised schema closes every branch and omits session/run/internal ids', () => {
    assert.equal(branches.length, 3);
    for (const branch of branches) {
        assert.equal(branch.additionalProperties, false, 'a closed branch cannot smuggle internal ids');
    }
    const serialized = JSON.stringify(advertisedSchema);
    for (const forbidden of ['sessionId', 'runId', 'continuationId', 'revision', 'internal', 'evidence', 'programIndex']) {
        assert.equal(serialized.includes(`"${forbidden}"`), false, `no ${forbidden} field is model-facing`);
    }
});

test('the advertised schema exposes required nested shapes for each allowed kind', () => {
    const clarification = branchByKind('clarification');
    assert.ok(clarification);
    assert.deepEqual([...clarification!.required ?? []].sort(), ['kind', 'question', 'schema']);
    assert.equal(clarification!.properties?.question?.type, 'string');
    assert.equal(clarification!.properties?.question?.minLength, 1);
    const schemaNode = clarification!.properties?.schema;
    assert.ok(schemaNode, 'the clarification schema sub-object is advertised');
    assert.deepEqual([...schemaNode!.required ?? []].sort(), ['field', 'type']);
    assert.deepEqual(schemaNode!.properties?.type?.enum, ['text', 'number', 'date', 'select']);
    assert.ok(schemaNode!.properties?.allowed, 'allowed values are advertised for select');
    assert.ok(schemaNode!.properties?.min && schemaNode!.properties?.max, 'numeric bounds are advertised');
    assert.ok(schemaNode!.properties?.maxLength, 'max text length is advertised');
    assert.ok(schemaNode!.properties?.default, 'a default value slot is advertised');
    assert.ok(schemaNode!.properties?.safeOnTimeout, 'safe-on-timeout is advertised');

    const recovery = branchByKind('recovery_decision');
    assert.ok(recovery);
    assert.deepEqual([...recovery!.required ?? []].sort(), ['failureSummary', 'kind', 'options']);
    const options = recovery!.properties?.options;
    assert.equal(options?.type, 'array');
    assert.ok((options?.minItems ?? 0) >= 1, 'options must be non-empty');
    const optionItem = options?.items;
    assert.ok(optionItem);
    assert.deepEqual([...optionItem!.required ?? []].sort(), ['eligible', 'id', 'kind', 'label']);
    assert.deepEqual(optionItem!.properties?.kind?.enum, ['retry', 'repair', 'rollback', 'rewind', 'terminate']);
    assert.ok(optionItem!.properties?.block, 'the sanitized block reason is advertised');
    assert.deepEqual([...optionItem!.properties!.block!.required ?? []].sort(), ['code', 'message']);

    const takeover = branchByKind('takeover');
    assert.ok(takeover);
    assert.deepEqual([...takeover!.required ?? []].sort(), ['guidanceModes', 'kind', 'reason']);
    assert.equal(takeover!.properties?.reason?.type, 'string');
    const guidance = takeover!.properties?.guidanceModes;
    assert.equal(guidance?.type, 'array');
    assert.deepEqual(guidance?.items?.enum, ['manual', 'teach', 'annotate']);
    assert.deepEqual(takeover!.properties?.scope?.enum, ['workspace', 'tab']);
    assert.deepEqual(takeover!.properties?.teachKind?.enum, ['procedure', 'recovery', 'demonstration']);
});