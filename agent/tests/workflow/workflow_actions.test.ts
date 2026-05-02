import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { handleRuntimeControlAction } from '../../src/runtime/control';
import { handleWorkspaceControlAction } from '../../src/runtime/workspace_control';
import { createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs } from '../../src/workflow';
import { setDslControlServices } from '../../src/dsl/control';
import { isRequestActionType } from '../../src/actions/action_types';

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const cleanup = (name: string) => { try { deleteWorkflowFromFs(name); } catch {} };

test('workflow lifecycle actions are handled by runtime control', async () => {
    const registry = createWorkspaceRegistry();
    const workflowName = uniqueName('wf-main4');
    const renamed = uniqueName('wf-main4-renamed');
    cleanup(workflowName);
    cleanup(renamed);

    const created = await handleRuntimeControlAction({
        action: { v: 1, id: '1', type: 'workflow.create', payload: { workflowName } },
        workspaceRegistry: registry,
    } as any);
    assert.equal(created.reply.type, 'workflow.create.result');

    const listed = await handleRuntimeControlAction({
        action: { v: 1, id: '2', type: 'workflow.list' },
        workspaceRegistry: registry,
    } as any);
    assert.equal(listed.reply.type, 'workflow.list.result');

    const opened = await handleRuntimeControlAction({
        action: { v: 1, id: '3', type: 'workflow.open', payload: { workflowName } },
        workspaceRegistry: registry,
    } as any);
    assert.equal(opened.reply.type, 'workflow.open.result');

    const renamedReply = await handleRuntimeControlAction({
        action: { v: 1, id: '4', type: 'workflow.rename', payload: { fromName: workflowName, toName: renamed } },
        workspaceRegistry: registry,
    } as any);
    assert.equal(renamedReply.reply.type, 'workflow.rename.result');
    cleanup(workflowName);
    cleanup(renamed);
});

test('workflow.status is handled by workspace control', async () => {
    const registry = createWorkspaceRegistry();
    const name = uniqueName('wf-status');
    cleanup(name);
    const workflow = createWorkflowOnFs(name);
    const ws = registry.createWorkspace(name, workflow);

    const status = await handleWorkspaceControlAction({
        action: { v: 1, id: 's1', type: 'workflow.status', workspaceName: name },
        workspace: ws,
        workspaceRegistry: registry,
    } as any);
    assert.equal(status.reply.type, 'workflow.status.result');
    assert.equal((status.reply.payload as any).workspaceName, name);
    cleanup(name);
});

test('dsl actions are handled by dsl control', async () => {
    const registry = createWorkspaceRegistry();
    const name = uniqueName('wf-dsl');
    cleanup(name);
    const workflow = createWorkflowOnFs(name);
    workflow.save({ kind: 'dsl', name: 'main', content: '' } as any);
    workflow.save({
        kind: 'checkpoint',
        name: 'cp-1',
        checkpoint: { id: 'cp-1', trigger: { matchRules: [{ errorCode: 'ERR_SAMPLE' }] } },
        stepResolves: {},
        hints: {},
    } as any);
    const ws = registry.createWorkspace(name, workflow);

    setDslControlServices({
        runStepsDeps: {
            runtime: { ensureActivePage: async () => ({ workspaceName: name, tabName: 'tab-1' }) } as any,
            stepSinks: [],
            config: {} as any,
            pluginHost: undefined as any,
        },
    });

    const got = await handleWorkspaceControlAction({
        action: { v: 1, id: 'd1', type: 'dsl.get', workspaceName: name },
        workspace: ws,
        workspaceRegistry: registry,
    } as any);
    assert.equal(got.reply.type, 'dsl.get.result');

    const saved = await handleWorkspaceControlAction({
        action: { v: 1, id: 'd2', type: 'dsl.save', workspaceName: name, payload: { content: '' } },
        workspace: ws,
        workspaceRegistry: registry,
    } as any);
    assert.equal(saved.reply.type, 'dsl.save.result');

    const tested = await handleWorkspaceControlAction({
        action: { v: 1, id: 'd3', type: 'dsl.test', workspaceName: name, payload: { input: { a: 1 } } },
        workspace: ws,
        workspaceRegistry: registry,
    } as any);
    assert.equal(tested.reply.type, 'dsl.test.result');

    const ran = await handleWorkspaceControlAction({
        action: { v: 1, id: 'd4', type: 'dsl.run', workspaceName: name, payload: { input: { b: 2 } } },
        workspace: ws,
        workspaceRegistry: registry,
    } as any);
    assert.equal(ran.reply.type, 'dsl.run.result');

    cleanup(name);
});

test('workflow.dsl.* and workflow.releaseRun are not request actions', () => {
    assert.equal(isRequestActionType('workflow.dsl.get'), false);
    assert.equal(isRequestActionType('workflow.dsl.save'), false);
    assert.equal(isRequestActionType('workflow.dsl.test'), false);
    assert.equal(isRequestActionType('workflow.releaseRun'), false);
});
