import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createProgramFirstAgentRunner} from '../../../../src/agent/execution/program/runner';
import {createWorkspaceProgramExecutor} from '../../../../src/agent/workspace/program_executor';
import {createLibraryHarness, NESTED_CHECK_PROCEDURE, ORDERS_PAGE_PROFILE} from '../../../helpers/library_harness';
import type {KnowledgeSeamDeps} from '../../../../src/agent/execution/knowledge';

const knowledgeOf = (harness: ReturnType<typeof createLibraryHarness>): KnowledgeSeamDeps => {
    const runtime = harness.runStepsDeps.resolveWorkspace(harness.workspaceName).entityRules;
    return {library: harness.library, entityRules: runtime.getProvider(harness.workflow)};
};

const PROGRAM_SOURCE = [
    `use entity_rules "${ORDERS_PAGE_PROFILE}" as orders`,
    `use checkpoint "${NESTED_CHECK_PROCEDURE}" with {`,
    '  orderNo: input.orderNo',
    '}',
    'output done = input.orderNo',
].join('\n');

test('scripted Program-first run discovers Procedure/Page Knowledge then executes a DSL referencing them inside one transaction', async () => {
    const harness = createLibraryHarness();
    const executeProgram = createWorkspaceProgramExecutor({
        workspaceName: harness.workspaceName,
        deps: harness.runStepsDeps,
        runWorkspaceExecution: async (_actionType, run) => await run(),
    });
    const faux = createFauxCore({provider: 'faux-knowledge', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.knowledge.catalog', {kind: 'procedure'})),
        fauxAssistantMessage(fauxToolCall('agent.knowledge.inspect', {kind: 'procedure', name: NESTED_CHECK_PROCEDURE})),
        fauxAssistantMessage(fauxToolCall('agent.knowledge.catalog', {kind: 'page_knowledge'})),
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: PROGRAM_SOURCE,
            input: {orderNo: 'ABC-9'},
        })),
        fauxAssistantMessage('The retained program completed through the discovered knowledge assets.'),
    ]);
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram,
        knowledge: knowledgeOf(harness),
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-knowledge' && model === 'planner'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        prompt: 'Discover the available library knowledge, then execute a program that references the discovered assets and finish.',
        provider: 'faux-knowledge',
        model: 'planner',
    });

    assert.equal(result.text, 'The retained program completed through the discovered knowledge assets.');
    assert.equal(result.programs?.length, 1, 'exactly one program transaction is ever started');
    assert.deepEqual(result.trace.tools.map((tool) => tool.toolName), [
        'agent.knowledge.catalog',
        'agent.knowledge.inspect',
        'agent.knowledge.catalog',
        'agent.execute_program',
    ]);
    assert.equal(result.trace.metrics.readCalls, 3, 'the three knowledge calls are classified as read');
    assert.equal(result.trace.metrics.controlCalls, 1, 'execute_program is classified as control');
    assert.ok(result.trace.context && result.trace.context.lastBytes > 0, 'returned knowledge bytes are counted in context accounting');
    assert.ok(result.trace.context && result.trace.context.turns.length >= 1, 'accounting recorded at least one provider-visible turn');

    const program = result.programs?.[0];
    assert.equal(program?.status, 'completed');
    assert.equal(program?.text, '{"done":"ABC-9"}');
    assert.equal(program?.source.includes(`use checkpoint "${NESTED_CHECK_PROCEDURE}"`), true);
    assert.equal(program?.source.includes(`use entity_rules "${ORDERS_PAGE_PROFILE}"`), true);
});

test('knowledge tools are not auto-injected: a run that never calls them carries zero knowledge content', async () => {
    const harness = createLibraryHarness();
    const executeProgram = createWorkspaceProgramExecutor({
        workspaceName: harness.workspaceName,
        deps: harness.runStepsDeps,
        runWorkspaceExecution: async (_actionType, run) => await run(),
    });
    const faux = createFauxCore({provider: 'faux-knowledge-silent', models: [{id: 'planner'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {
            source: 'output done = input.orderNo',
            input: {orderNo: 'ABC-9'},
        })),
        fauxAssistantMessage('Finished without any knowledge reads.'),
    ]);
    const runner = createProgramFirstAgentRunner({
        readTools: [],
        executeProgram,
        knowledge: knowledgeOf(harness),
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-knowledge-silent' && model === 'planner'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        prompt: 'Finish the task using only the active page.',
        provider: 'faux-knowledge-silent',
        model: 'planner',
    });

    const knowledgeTools = result.trace.tools.filter((tool) => tool.toolName.startsWith('agent.knowledge.'));
    assert.deepEqual(knowledgeTools, [], 'no knowledge tool was invoked automatically');
    assert.deepEqual(result.trace.tools.map((tool) => tool.toolName), ['agent.execute_program']);
    assert.ok(result.trace.context !== undefined, 'context accounting still tracked the run');
    assert.equal(result.programs?.length, 1);
    assert.equal(result.programs?.[0]?.status, 'completed');
});