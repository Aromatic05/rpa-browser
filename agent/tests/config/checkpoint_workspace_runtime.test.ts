import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createWorkflowOnFs, deleteWorkflowFromFs } from '../../src/workflow';
import { createWorkspaceCheckpointRuntime } from '../../src/checkpoint/runtime';
import { createWorkspaceCheckpointProvider } from '../../src/checkpoint/provider';
import { createDslControl } from '../../src/dsl/control';
import { createTestWorkspaceRegistry } from '../helpers/workspace_registry';
import type { RunStepsDeps } from '../../src/runner/run_steps_types';

const unique = (prefix: string) => `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const cleanup = (name: string) => { try { deleteWorkflowFromFs(name); } catch {} };

const createRunStepsDeps = (): RunStepsDeps => ({
    runtime: {} as any,
    config: {} as any,
    pluginHost: {
        getExecutors: () => ({}) as any,
    } as any,
});

test('workspace checkpoint runtime list/get/save/delete and not found behaviors', () => {
    const workflowName = unique('checkpoint-runtime');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);
    const runtime = createWorkspaceCheckpointRuntime(workflow);

    const saved = runtime.save({ id: 'cp-1', trigger: { matchRules: [] }, content: [] }, {}, {});
    assert.equal(saved.name, 'cp-1');
    assert.equal(runtime.list().length, 1);
    assert.equal(runtime.get('cp-1')?.checkpoint.id, 'cp-1');

    assert.throws(() => runtime.save({ id: ' cp-bad ', trigger: { matchRules: [] }, content: [] }, {}, {}));
    assert.equal(runtime.get('missing'), null);
    assert.throws(() => runtime.delete('missing'), /checkpoint not found/);

    const removed = runtime.delete('cp-1');
    assert.equal(removed.name, 'cp-1');
    assert.equal(runtime.list().length, 0);
    cleanup(workflowName);
});

test('workspace checkpoint provider exposes getCheckpoint and getCheckpointResolves', () => {
    const workflowName = unique('checkpoint-provider');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);
    const runtime = createWorkspaceCheckpointRuntime(workflow);
    runtime.save({ id: 'cp-2', trigger: { matchRules: [] }, content: [] }, { r1: { kind: 'dom', locator: { primary: 'css=#x' } } as any }, {});

    const provider = createWorkspaceCheckpointProvider(workflow);
    assert.equal(provider.getCheckpoint('cp-2')?.id, 'cp-2');
    assert.ok(provider.getCheckpointResolves?.('cp-2')?.r1);
    assert.equal(provider.getCheckpoint('missing'), null);
    cleanup(workflowName);
});

test('dsl.test and dsl.run use workspace checkpoint provider', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const workspaceName = unique('dsl-checkpoint-provider');
    cleanup(workspaceName);
    const workflow = createWorkflowOnFs(workspaceName);
    const ws = registry.createWorkspace(workspaceName, workflow);

    createWorkspaceCheckpointRuntime(workflow).save({
        id: 'cp-use',
        trigger: { matchRules: [] },
        output: { marker: { ref: 'input.flag' } },
        content: [],
    }, {}, {});

    workflow.save({
        kind: 'dsl',
        name: 'main',
        content: 'use checkpoint "cp-use" with { flag: input.flag }',
    } as any);

    const dslControl = createDslControl({ runStepsDeps: createRunStepsDeps() });

    const tested = await dslControl.handle({
        action: { v: 1, id: 'd1', type: 'dsl.test', workspaceName, payload: { input: { flag: 'ok' } } } as any,
        workspace: ws as any,
        workspaceRegistry: registry as any,
    });
    assert.equal(tested.reply.type, 'dsl.test.result');
    assert.equal((tested.reply.payload as any).output.marker, 'ok');

    const ran = await dslControl.handle({
        action: { v: 1, id: 'd2', type: 'dsl.run', workspaceName, payload: { input: { flag: 'go' } } } as any,
        workspace: ws as any,
        workspaceRegistry: registry as any,
    });
    assert.equal(ran.reply.type, 'dsl.run.result');
    assert.equal((ran.reply.payload as any).output.marker, 'go');
    cleanup(workspaceName);
});
