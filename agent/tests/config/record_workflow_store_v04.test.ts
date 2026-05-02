import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createRecordingState } from '../../src/record/recording';
import { createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs } from '../../src/workflow';
import { handleRecordControlAction, setRecordControlServices } from '../../src/record/control';

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const cleanup = (name: string) => {
    try { deleteWorkflowFromFs(name); } catch {}
};

test('record.save uses workspace.workflow and persists recording artifact', async () => {
    const wsName = uniqueName('wf-v04-record-save');
    cleanup(wsName);
    const registry = createWorkspaceRegistry();
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    const recordingState = createRecordingState();
    recordingState.recordings.set('token-a', []);
    recordingState.workspaceLatestRecording.set(wsName, 'token-a');
    setRecordControlServices({
        recordingState,
        replayOptions: { clickDelayMs: 0, stepDelayMs: 0, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1200,
    });

    const saved = await handleRecordControlAction({
        action: { v: 1, id: '1', type: 'record.save', workspaceName: wsName, payload: { recordingName: 'rec-a' } },
        workspace: ws,
        workspaceRegistry: registry,
    } as any);
    assert.equal(saved.reply.type, 'record.save.result');
    const workflow = loadWorkflowFromFs(wsName);
    const loaded = workflow.get('rec-a', { kind: 'recording' });
    assert.equal(loaded?.kind, 'recording');
    cleanup(wsName);
});
