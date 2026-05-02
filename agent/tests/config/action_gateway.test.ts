import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActionEnvelope } from '../../src/actions/envelope';
import { classifyActionRoute } from '../../src/actions/classify';
import { routeWorkspaceAction } from '../../src/actions/workspace_gateway';
import { routeControlAction } from '../../src/actions/control_gateway';
import { createActionDispatcher } from '../../src/actions/dispatcher';
import type { Action } from '../../src/actions/action_protocol';
import { createRecordingState } from '../../src/record/recording';

const baseAction = (type: string): Action => ({ v: 1, id: 'a1', type });

const deps = {
    workspaceRegistry: {
        getWorkspace: (_name: string) => null,
        listWorkspaces: () => [],
        getActiveWorkspace: () => null,
    },
    pageRegistry: { getPage: async () => ({ url: () => 'https://example.com' }) },
    recordingState: createRecordingState(),
    log: () => undefined,
    replayOptions: {},
    navDedupeWindowMs: 0,
};

test('envelope rejects legacy top-level address fields', () => {
    assert.throws(() => parseActionEnvelope({ ...baseAction('workflow.list'), scope: {} } as unknown as Action), /scope/);
    assert.throws(() => parseActionEnvelope({ ...baseAction('workflow.list'), tabToken: 't-1' } as unknown as Action), /tabToken/);
    assert.throws(() => parseActionEnvelope({ ...baseAction('workflow.list'), tabName: 'tab-1' } as unknown as Action), /tabName/);
});

test('envelope rejects legacy payload address fields', () => {
    assert.throws(() => parseActionEnvelope({ ...baseAction('workflow.list'), payload: { workspaceName: 'ws-1' } }), /workspaceName/);
    assert.throws(() => parseActionEnvelope({ ...baseAction('workflow.list'), payload: { scope: { tab: 'x' } } }), /scope/);
});

test('classify distinguishes control/workspace/reply/event', () => {
    assert.equal(classifyActionRoute(baseAction('workflow.list')), 'control');
    assert.equal(classifyActionRoute({ ...baseAction('tab.list'), workspaceName: 'ws-1' }), 'workspace');
    assert.equal(classifyActionRoute(baseAction('workflow.list.result')), 'reply');
    assert.equal(classifyActionRoute(baseAction('play.progress')), 'event');
});

test('workspace gateway rejects missing workspaceName', async () => {
    const result = await routeWorkspaceAction(deps as any, baseAction('tab.list'));
    assert.equal(result.type, 'tab.list.failed');
});

test('workspace gateway returns failed action when workspace is missing', async () => {
    const action = { ...baseAction('tab.list'), workspaceName: 'ws-missing' };
    const result = await routeWorkspaceAction(deps as any, action);
    assert.equal(result.type, 'tab.list.failed');
    assert.match(String((result.payload as any)?.message || ''), /workspace not found/);
});

test('control gateway does not process workspace actions', async () => {
    await assert.rejects(async () => await routeControlAction(deps as any, { ...baseAction('workflow.list'), workspaceName: 'ws-1' }), /does not accept workspace action/);
});

test('dispatcher routes action without workspaceName to control gateway', async () => {
    const dispatcher = createActionDispatcher({
        pageRegistry: deps.pageRegistry as any,
        workspaceRegistry: deps.workspaceRegistry as any,
        recordingState: deps.recordingState,
        log: deps.log,
        replayOptions: deps.replayOptions as any,
        navDedupeWindowMs: 0,
    });
    const reply = await dispatcher.dispatch(baseAction('workflow.list'));
    assert.equal(reply.type, 'workflow.list.result');
});
