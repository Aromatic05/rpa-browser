import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingState } from '../../src/record/recording';
import { createWorkflowOnFs, deleteWorkflowFromFs, listWorkflowNames } from '../../src/workflow';
import { createWorkspaceHarness } from '../helpers/workspace_harness';
import { routeControlAction } from '../../src/actions/control_gateway';
import { routeWorkspaceAction } from '../../src/actions/workspace_gateway';

const createMockPage = (url: string) => ({
    url: () => url,
    on: () => {},
    mainFrame: () => ({ url: () => url }),
    frames: () => [],
    exposeBinding: async () => {},
    addInitScript: async () => {},
    evaluate: async () => {},
    goto: async () => {},
    isClosed: () => false,
    close: async () => {},
}) as any;

const mkDeps = (registry: any) => ({ workspaceRegistry: registry, log: () => {}, emit: () => {} });

test('record/play state machine enforces workspace order and unsaved slot overwrite', async () => {
    const recordingState = createRecordingState();
    const { registry } = createWorkspaceHarness({ recordingState });
    const wsName = `ws-${Date.now()}-state`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', page: createMockPage('https://example.com'), url: 'https://example.com' });
    ws.tabs.setActiveTab('tab-1');

    const started = await ws.record.handle({ action: { v: 1, id: 'a1', type: 'record.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(started.reply.type, 'record.start.result');

    const startedAgain = await ws.record.handle({ action: { v: 1, id: 'a2', type: 'record.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any }).catch((error) => error);
    assert.match(String(startedAgain?.code || startedAgain), /ERR_BAD_STATE|BAD_STATE/);

    const playDuringRecording = await ws.record.handle({ action: { v: 1, id: 'a3', type: 'play.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any }).catch((error) => error);
    assert.match(String(playDuringRecording?.code || playDuringRecording), /ERR_BAD_STATE|BAD_STATE/);

    await ws.record.handle({ action: { v: 1, id: 'a4', type: 'record.stop', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });

    const saveEmpty = await ws.record.handle({ action: { v: 1, id: 'a5', type: 'record.save', workspaceName: wsName, payload: { recordingName: 'r1' } } as any, workspace: ws as any, workspaceRegistry: registry as any }).catch((error) => error);
    assert.match(String(saveEmpty?.code || saveEmpty), /ERR_RECORDING_EMPTY|RECORDING_EMPTY/);

    const clear = await ws.record.handle({ action: { v: 1, id: 'a6', type: 'record.clear', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(clear.reply.type, 'record.clear.result');

    const playUnsavedEmpty = await ws.record.handle({ action: { v: 1, id: 'a7', type: 'play.start', workspaceName: wsName, payload: {} } as any, workspace: ws as any, workspaceRegistry: registry as any }).catch((error) => error);
    assert.match(String(playUnsavedEmpty?.code || playUnsavedEmpty), /ERR_RECORDING_EMPTY|RECORDING_EMPTY/);
});

test('workflow.saveAs routes in control and keeps source, resetDefault routes in control', async () => {
    const recordingState = createRecordingState();
    const { registry } = createWorkspaceHarness({ recordingState });
    const sourceName = `ws-${Date.now()}-source`;
    const targetName = `${sourceName}-copy`;
    const otherName = `${sourceName}-other`;

    const sourceWs = registry.createWorkspace(sourceName, createWorkflowOnFs(sourceName));
    registry.createWorkspace(otherName, createWorkflowOnFs(otherName));

    const saveAsReply = await routeControlAction(
        mkDeps(registry),
        { v: 1, id: 'w1', type: 'workflow.saveAs', payload: { sourceName, targetName } } as any,
    );
    assert.equal(saveAsReply.type, 'workflow.saveAs.result');
    assert.equal((saveAsReply.payload as any).workspaceName, targetName);
    assert.equal(listWorkflowNames().includes(sourceName), true);
    assert.equal(listWorkflowNames().includes(targetName), true);
    assert.equal(registry.getActiveWorkspace()?.name, targetName);
    assert.equal(sourceWs.name, sourceName);
    const invalidWorkspaceRouted = await routeWorkspaceAction(
        mkDeps(registry),
        { v: 1, id: 'w1b', type: 'workflow.saveAs', workspaceName: sourceName, payload: { sourceName, targetName: `${targetName}-x` } } as any,
    );
    assert.equal(invalidWorkspaceRouted.type, 'workflow.saveAs.failed');

    const resetReply = await routeControlAction(
        mkDeps(registry),
        { v: 1, id: 'w2', type: 'workflow.resetDefault', payload: {} } as any,
    );
    assert.equal(resetReply.type, 'workflow.resetDefault.result');
    assert.equal(registry.getActiveWorkspace()?.name, 'default');
    assert.equal(listWorkflowNames().includes(otherName), true);

    deleteWorkflowFromFs(sourceName);
    deleteWorkflowFromFs(targetName);
    deleteWorkflowFromFs(otherName);
    deleteWorkflowFromFs('default');
});

test('RuntimeWorkspace uses state field only for runtime status', async () => {
    const recordingState = createRecordingState();
    const { registry } = createWorkspaceHarness({ recordingState });
    const wsName = `ws-${Date.now()}-shape`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    assert.equal('state' in ws, true);
    assert.equal('lifecycle' in (ws as any), false);
    assert.equal('workflowControl' in (ws as any), false);
    deleteWorkflowFromFs(wsName);
});

test('play.start with missing saved recording returns ERR_RECORDING_NOT_FOUND', async () => {
    const recordingState = createRecordingState();
    const { registry } = createWorkspaceHarness({ recordingState });
    const wsName = `ws-${Date.now()}-play`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', page: createMockPage('https://example.com/play'), url: 'https://example.com/play' });
    ws.tabs.setActiveTab('tab-1');

    const reply = await routeWorkspaceAction(
        mkDeps(registry),
        { v: 1, id: 'p1', type: 'play.start', workspaceName: wsName, payload: { recordingName: 'missing' } } as any,
    );
    assert.equal(reply.type, 'play.start.failed');
    assert.equal((reply.payload as any).code, 'ERR_RECORDING_NOT_FOUND');

    deleteWorkflowFromFs(wsName);
});
