import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createRecordingState } from '../../src/record/recording';
import { createWorkflowOnFs, deleteWorkflowFromFs } from '../../src/workflow';
import { handleRecordControlAction, setRecordControlServices } from '../../src/record/control';

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const cleanup = (name: string) => { try { deleteWorkflowFromFs(name); } catch {} };

test('record.load fails when recording artifact is missing in workspace workflow', async () => {
    const wsName = uniqueName('wf-v03-record-load');
    cleanup(wsName);

    const registry = createWorkspaceRegistry();
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    setRecordControlServices({
        recordingState: createRecordingState(),
        replayOptions: { clickDelayMs: 0, stepDelayMs: 0, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1200,
    });

    await assert.rejects(
        async () =>
            await handleRecordControlAction({
                action: { v: 1, id: '1', type: 'record.load', workspaceName: wsName, payload: { recordingName: 'rec-1' } },
                workspace: ws,
                workspaceRegistry: registry,
            } as any),
        /recording not found/,
    );

    cleanup(wsName);
});
