import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createWorkspaceHarness} from '../../../helpers/workspace_harness';
import {createWorkflowOnFs} from '../../../../src/automation/workflow';
import {stepExecutors} from '../../../../src/automation/runner/steps/executors';

test('workspace defaults agent.run to the program-first read-only planner', async () => {
    const faux = createFauxCore({provider: 'workspace-faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.list_tabs', {})),
        fauxAssistantMessage('Observed the workspace tab.'),
    ]);
    const {registry} = createWorkspaceHarness({
        pluginHost: {getExecutors: () => stepExecutors} as any,
        agentModelRuntime: {
            resolve: (provider, model) => provider === 'workspace-faux' && model === 'baseline'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });
    const workspaceName = `agent-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    workspace.tabs.createTab({tabName: 'main'});
    workspace.tabs.bindPage('main', {url: () => 'https://example.test/', isClosed: () => false} as any);

    const request = {
        v: 1 as const,
        id: crypto.randomUUID(),
        type: 'agent.run',
        workspaceName,
        payload: {
            prompt: 'Inspect the open tabs.',
            provider: 'workspace-faux',
            model: 'baseline',
        },
    };
    const result = await workspace.router.handle(request, workspace, registry);
    const payload = result.reply.payload as any;

    assert.equal(result.reply.type, 'agent.run.result');
    assert.equal(payload.text, 'Observed the workspace tab.');
    assert.equal(payload.trace.metrics.toolCalls, 1);
    assert.equal(payload.trace.metrics.readCalls, 1);
    assert.equal(payload.trace.metrics.failedToolCalls, 0);
    assert.equal(payload.executionMode, 'program');
    assert.deepEqual(payload.programs, []);
    assert.equal(workspace.state, 'idle');
});

test('workspace rejects an invalid structured program before starting retained execution', async () => {
    const {registry} = createWorkspaceHarness({
        pluginHost: {getExecutors: () => stepExecutors} as any,
        agentModelRuntime: {resolve: () => null},
    });
    const workspaceName = `agent-invalid-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    const result = await workspace.router.handle({
        v: 1,
        id: crypto.randomUUID(),
        type: 'agent.run',
        workspaceName,
        payload: {
            prompt: 'Run the supplied program.',
            provider: 'unused',
            model: 'unused',
            source: 'this is not valid dsl !!!',
        },
    }, workspace, registry);
    const payload = result.reply.payload as any;

    assert.equal(payload.executionMode, 'program');
    assert.equal(payload.programs.length, 1);
    assert.equal(payload.programs[0].status, 'invalid');
    assert.equal(payload.programs[0].error.code, 'ERR_DSL_PARSE');
    assert.equal(workspace.state, 'idle');
});

test('workspace executes a pure structured program without requiring a debugger model', async () => {
    const {registry} = createWorkspaceHarness({
        pluginHost: {getExecutors: () => stepExecutors} as any,
        agentModelRuntime: {resolve: () => null},
    });
    const workspaceName = `agent-pure-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    const result = await workspace.router.handle({
        v: 1,
        id: crypto.randomUUID(),
        type: 'agent.run',
        workspaceName,
        payload: {
            prompt: 'Run the supplied program.',
            provider: 'unused',
            model: 'unused',
            source: 'output ok = input.ok',
            input: {ok: true},
        },
    }, workspace, registry);
    const payload = result.reply.payload as any;

    assert.equal(payload.executionMode, 'program');
    assert.equal(payload.text, '{"ok":true}');
    assert.equal(payload.programs[0].status, 'completed');
    assert.deepEqual(payload.programs[0].effects, []);
    assert.equal(payload.trace.metrics.turns, 0);
    assert.equal(workspace.state, 'idle');
});

test('workspace Agent explicitly persists a completed Program through the workflow DSL store', async () => {
    const faux = createFauxCore({provider: 'workspace-save-faux', models: [{id: 'save'}]});
    const source = 'output ok = input.ok';
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('agent.execute_program', {source, input: {ok: true}})),
        fauxAssistantMessage(fauxToolCall('agent.save_program', {name: 'generated'})),
        fauxAssistantMessage('Completed and saved generated.'),
    ]);
    const {registry} = createWorkspaceHarness({
        pluginHost: {getExecutors: () => stepExecutors} as any,
        agentModelRuntime: {
            resolve: (provider, model) => provider === 'workspace-save-faux' && model === 'save'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });
    const workspaceName = `agent-save-${crypto.randomUUID()}`;
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    const result = await workspace.router.handle({
        v: 1,
        id: crypto.randomUUID(),
        type: 'agent.run',
        workspaceName,
        payload: {
            prompt: 'Run the Program and explicitly save the completed reusable Program as generated.',
            provider: 'workspace-save-faux',
            model: 'save',
        },
    }, workspace, registry);
    const payload = result.reply.payload as any;
    const saved = workspace.workflow.get('generated', {kind: 'dsl'});

    assert.equal(payload.text, 'Completed and saved generated.');
    assert.deepEqual(payload.trace.tools.map((tool: {toolName: string}) => tool.toolName), [
        'agent.execute_program',
        'agent.save_program',
    ]);
    assert.equal(payload.programs[0].status, 'completed');
    assert.equal(payload.programs[0].materializedSource, source);
    assert.equal(payload.savedPrograms.length, 1);
    assert.equal(payload.savedPrograms[0].name, 'generated');
    assert.equal(saved?.kind, 'dsl');
    if (saved?.kind !== 'dsl') {throw new Error('expected persisted generated DSL');}
    assert.equal(saved.content, source);
    assert.deepEqual(saved.stepResolves, {});
    assert.equal(workspace.state, 'idle');
});
