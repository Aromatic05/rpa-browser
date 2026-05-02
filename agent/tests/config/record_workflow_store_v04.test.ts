import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { recordingHandlers } from '../../src/actions/recording';
import { workflowHandlers } from '../../src/actions/workflow';
import { ACTION_TYPES } from '../../src/actions/action_types';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createRecordingState } from '../../src/record/recording';
import { loadWorkflowFromFs, deleteWorkflowFromFs } from '../../src/workflow';

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

test('record.save creates workflow location and persists recording via workflow store', async () => {
    const workflowName = uniqueName('wf-v04-record-save');
    cleanup(workflowName);
    const ctx = createCtx();

    const saved = await recordingHandlers['record.save'](ctx, {
        v: 1,
        id: '1',
        type: 'record.save',
        workspaceName: workflowName,
        payload: { recordingName: 'rec-a' },
    } as any);

    assert.equal(saved.type, 'record.save.result');
    const workflow = loadWorkflowFromFs(workflowName);
    const loaded = workflow.get('rec-a', { kind: 'recording' });
    assert.equal(loaded?.kind, 'recording');
    cleanup(workflowName);
});

test('record.load does not create workflow and fails when workspace/workflow missing', async () => {
    const workflowName = uniqueName('wf-v04-record-load');
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

test('workflow.record actions and action types do not exist', () => {
    assert.equal('workflow.record.save' in workflowHandlers, false);
    assert.equal('workflow.record.load' in workflowHandlers, false);
    assert.equal(Object.values(ACTION_TYPES).includes('workflow.record.save'), false);
    assert.equal(Object.values(ACTION_TYPES).includes('workflow.record.load'), false);
});
