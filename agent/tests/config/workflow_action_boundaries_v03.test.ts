import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { workflowHandlers } from '../../src/actions/workflow';
import { recordingHandlers } from '../../src/actions/recording';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs } from '../../src/workflow';
import { createRecordingState } from '../../src/record/recording';

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const cleanup = (name: string) => {
    try {
        deleteWorkflowFromFs(name);
    } catch {}
};

const createCtx = () => {
    const workspaceRegistry = createWorkspaceRegistry();
    return {
        workspaceRegistry,
        recordingState: createRecordingState(),
        resolveTab: () => ({ name: 'tab-1' }),
        resolvePage: () => ({ url: () => 'about:blank' }),
        runStepsDeps: null,
    } as any;
};

test('workflow.create/open/rename use control payload naming and keep workspace/workflow identity', async () => {
    const from = uniqueName('wf-v03-a');
    const to = uniqueName('wf-v03-b');
    cleanup(from);
    cleanup(to);

    const ctx = createCtx();

    const created = await workflowHandlers['workflow.create'](ctx, {
        v: 1,
        id: '1',
        type: 'workflow.create',
        payload: { workflowName: from, workspaceName: 'ignored' },
    } as any);
    assert.equal(created.type, 'workflow.create.result');
    assert.equal((created.payload as any).workflowName, from);

    const opened = await workflowHandlers['workflow.open'](ctx, {
        v: 1,
        id: '2',
        type: 'workflow.open',
        payload: { workflowName: from, workspaceName: 'ignored-2' },
    } as any);
    assert.equal(opened.type, 'workflow.open.result');
    assert.equal((opened.payload as any).workflowName, from);

    const renamed = await workflowHandlers['workflow.rename'](ctx, {
        v: 1,
        id: '3',
        type: 'workflow.rename',
        payload: { fromName: from, toName: to, workspaceName: 'ignored-3' },
    } as any);
    assert.equal(renamed.type, 'workflow.rename.result');

    const ws = ctx.workspaceRegistry.getWorkspace(to);
    assert.equal(!!ws, true);
    assert.equal(ws?.name, to);
    assert.equal(ws?.workflow.name, to);
    assert.equal(ctx.workspaceRegistry.getWorkspace(from), null);

    cleanup(from);
    cleanup(to);
});

test('workflow.open fails when workflow artifact does not exist', async () => {
    const missing = uniqueName('wf-v03-missing');
    cleanup(missing);
    const ctx = createCtx();

    await assert.rejects(
        () =>
            workflowHandlers['workflow.open'](ctx, {
                v: 1,
                id: '1',
                type: 'workflow.open',
                payload: { workflowName: missing },
            } as any),
        /ERR_WORKFLOW_NOT_FOUND|workflow not found/,
    );
});

test('workspace actions only use action.workspaceName', async () => {
    const workflowName = uniqueName('wf-v03-ws');
    cleanup(workflowName);

    const ctx = createCtx();
    const workflow = createWorkflowOnFs(workflowName);
    ctx.workspaceRegistry.createWorkspace(workflowName, workflow);

    const status = await workflowHandlers['workflow.status'](ctx, {
        v: 1,
        id: '1',
        type: 'workflow.status',
        workspaceName: workflowName,
        payload: { workspaceName: 'ignored-payload-name' },
    } as any);
    assert.equal(status.type, 'workflow.status.result');
    assert.equal((status.payload as any).workspaceName, workflowName);

    await assert.rejects(
        () =>
            workflowHandlers['workflow.status'](ctx, {
                v: 1,
                id: '2',
                type: 'workflow.status',
                payload: { workspaceName: workflowName },
            } as any),
        /workspaceName is required/,
    );

    cleanup(workflowName);
});

test('record.load does not create workflow and fails when workspace/workflow missing', async () => {
    const workflowName = uniqueName('wf-v03-record-load');
    cleanup(workflowName);

    const ctx = createCtx();
    const root = path.resolve(process.cwd(), 'agent/.artifacts/workflows', workflowName);
    assert.equal(fs.existsSync(root), false);

    const failed = await recordingHandlers['record.load'](ctx, {
        v: 1,
        id: '1',
        type: 'record.load',
        workspaceName: workflowName,
        payload: { recordingName: 'rec-1' },
    } as any);
    assert.equal(failed.type, 'record.load.failed');
    assert.equal(fs.existsSync(root), false);

    cleanup(workflowName);
});

test('checkpoint artifact name must equal checkpoint.id', () => {
    const workflowName = uniqueName('wf-v03-checkpoint-id');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);

    assert.throws(() => {
        workflow.save({
            kind: 'checkpoint',
            name: 'cp-a',
            checkpoint: {
                id: 'cp-b',
                trigger: { matchRules: [{ errorCode: 'ERR_SAMPLE' }] },
            },
            stepResolves: {},
            hints: {},
        } as any);
    });

    workflow.save({
        kind: 'checkpoint',
        name: 'cp-1',
        checkpoint: {
            id: 'cp-1',
            trigger: { matchRules: [{ errorCode: 'ERR_SAMPLE' }] },
        },
        stepResolves: {},
        hints: {},
    } as any);

    const loadedWorkflow = loadWorkflowFromFs(workflowName);
    const loaded = loadedWorkflow.get('cp-1', { kind: 'checkpoint' });
    assert.equal(loaded?.kind, 'checkpoint');
    if (loaded?.kind === 'checkpoint') {
        assert.equal(loaded.name, loaded.checkpoint.id);
    }

    cleanup(workflowName);
});
