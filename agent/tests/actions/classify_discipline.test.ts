import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { classifyActionRoute, isControlAction, isWorkspaceAction } from '../../src/actions/classify';
import { isRequestActionType } from '../../src/actions/action_types';
import type { Action } from '../../src/actions/action_protocol';

const stubAction = (
    type: string,
    opts?: { workspaceName?: string; payload?: Record<string, unknown> },
): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName: opts?.workspaceName,
    payload: opts?.payload ?? {},
    at: Date.now(),
});

// ---- tab.init is not a request action ----

test('tab.init is not a request action', () => {
    assert.equal(isRequestActionType('tab.init'), false);
});

test('tab.init route is invalid', () => {
    const action = stubAction('tab.init');
    assert.equal(classifyActionRoute(action), 'invalid');
});

test('tab.init with workspaceName is invalid', () => {
    const action = stubAction('tab.init', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'invalid');
});

// ---- deleted actions are not request actions ----

test('workspace.save is not a request action', () => {
    assert.equal(isRequestActionType('workspace.save'), false);
});

test('workspace.restore is not a request action', () => {
    assert.equal(isRequestActionType('workspace.restore'), false);
});

test('workflow.status is not a request action', () => {
    assert.equal(isRequestActionType('workflow.status'), false);
});

// ---- workspaceName-based routing: command without workspaceName → control ----

test('command action without workspaceName routes to control', () => {
    const action = stubAction('workspace.list');
    assert.equal(classifyActionRoute(action), 'control');
    assert.equal(isControlAction(action), true);
    assert.equal(isWorkspaceAction(action), false);
});

test('workspace.create without workspaceName routes to control', () => {
    const action = stubAction('workspace.create');
    assert.equal(classifyActionRoute(action), 'control');
});

test('workflow.list without workspaceName routes to control', () => {
    const action = stubAction('workflow.list');
    assert.equal(classifyActionRoute(action), 'control');
});

// ---- workspaceName-based routing: command with workspaceName → workspace ----

test('command action with workspaceName routes to workspace', () => {
    const action = stubAction('tab.list', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
    assert.equal(isWorkspaceAction(action), true);
    assert.equal(isControlAction(action), false);
});

test('mcp.start with workspaceName routes to workspace', () => {
    const action = stubAction('mcp.start', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
    assert.equal(isWorkspaceAction(action), true);
});

test('mcp.status with workspaceName routes to workspace', () => {
    const action = stubAction('mcp.status', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('record.start with workspaceName routes to workspace', () => {
    const action = stubAction('record.start', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('dsl.get with workspaceName routes to workspace', () => {
    const action = stubAction('dsl.get', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('checkpoint.list with workspaceName routes to workspace', () => {
    const action = stubAction('checkpoint.list', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('entity_rules.list with workspaceName routes to workspace', () => {
    const action = stubAction('entity_rules.list', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('task.run.start with workspaceName routes to workspace', () => {
    const action = stubAction('task.run.start', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
});

// ---- workspaceName missing on command → control ----

test('workspace action type without workspaceName routes to control', () => {
    const action = stubAction('tab.list');
    assert.equal(classifyActionRoute(action), 'control');
});

test('mcp.start without workspaceName routes to control', () => {
    const action = stubAction('mcp.start');
    assert.equal(classifyActionRoute(action), 'control');
});

// ---- workspaceName coexistence → invalid ----

test('action.workspaceName and payload.workspaceName coexistence is invalid', () => {
    const action = stubAction('tab.list', {
        workspaceName: 'ws-1',
        payload: { workspaceName: 'ws-2' },
    });
    assert.equal(classifyActionRoute(action), 'invalid');
});

test('mcp.start with both workspaceNames is invalid', () => {
    const action = stubAction('mcp.start', {
        workspaceName: 'ws-1',
        payload: { workspaceName: 'ws-1' },
    });
    assert.equal(classifyActionRoute(action), 'invalid');
});

// ---- workspace.setActive routing ----

test('workspace.setActive without action.workspaceName routes to control', () => {
    const action = stubAction('workspace.setActive', { payload: { workspaceName: 'ws-1' } });
    assert.equal(classifyActionRoute(action), 'control');
    assert.equal(isControlAction(action), true);
    assert.equal(isWorkspaceAction(action), false);
});

test('workspace.setActive uses payload.workspaceName as business param', () => {
    const action = stubAction('workspace.setActive', { payload: { workspaceName: 'ws-1' } });
    assert.equal(classifyActionRoute(action), 'control');
});

test('workspace.setActive with action.workspaceName and payload.workspaceName is invalid', () => {
    const action = stubAction('workspace.setActive', {
        workspaceName: 'ws-1',
        payload: { workspaceName: 'ws-1' },
    });
    assert.equal(classifyActionRoute(action), 'invalid');
});

test('workspace.setActive with action.workspaceName only routes to workspace', () => {
    const action = stubAction('workspace.setActive', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
});

// ---- reply and event classification ----

test('reply action routes to reply', () => {
    const action = stubAction('workspace.list.result');
    assert.equal(classifyActionRoute(action), 'reply');
});

test('event action routes to event', () => {
    const action = stubAction('play.progress');
    assert.equal(classifyActionRoute(action), 'event');
});

// ---- unknown type is invalid ----

test('unknown action type routes to invalid', () => {
    const action = stubAction('unknown.action');
    assert.equal(classifyActionRoute(action), 'invalid');
});

// ---- extension classification parity ----
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '..');

test('agent and extension classify control routing is consistent', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));

    const controlCases: Action[] = [
        stubAction('workspace.list'),
        stubAction('workspace.create'),
        stubAction('workspace.setActive', { payload: { workspaceName: 'ws-1' } }),
        stubAction('workflow.list'),
        stubAction('workflow.create'),
        stubAction('workflow.open'),
        stubAction('workflow.rename'),
    ];
    for (const action of controlCases) {
        assert.equal(classifyActionRoute(action), 'control', `agent: ${action.type} should be control`);
        assert.equal(extMod.classifyActionRoute(action), 'control', `extension: ${action.type} should be control`);
    }
});

test('agent and extension classify workspace routing is consistent', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));

    const workspaceCases = [
        'tab.list', 'tab.create', 'tab.close', 'tab.setActive',
        'tab.opened', 'tab.report', 'tab.activated', 'tab.closed',
        'tab.ping', 'tab.reassign',
        'record.start', 'record.stop', 'record.get', 'record.save',
        'record.load', 'record.clear', 'record.list', 'record.event',
        'play.start', 'play.stop',
        'dsl.get', 'dsl.save', 'dsl.test', 'dsl.run',
        'task.run.start', 'task.run.push', 'task.run.poll',
        'task.run.checkpoint', 'task.run.halt', 'task.run.suspend',
        'task.run.continue', 'task.run.flush', 'task.run.resume',
        'checkpoint.list', 'checkpoint.get', 'checkpoint.save', 'checkpoint.delete',
        'entity_rules.list', 'entity_rules.get', 'entity_rules.save', 'entity_rules.delete',
        'mcp.start', 'mcp.stop', 'mcp.status',
    ];
    for (const type of workspaceCases) {
        const action = stubAction(type, { workspaceName: 'ws-1' });
        assert.equal(classifyActionRoute(action), 'workspace', `agent: ${type} should be workspace`);
        assert.equal(extMod.classifyActionRoute(action), 'workspace', `extension: ${type} should be workspace`);
    }
});

test('agent and extension classify invalid routing is consistent', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));

    // coexistence → invalid
    const coexist = stubAction('tab.list', { workspaceName: 'ws-1', payload: { workspaceName: 'ws-2' } });
    assert.equal(classifyActionRoute(coexist), 'invalid');
    assert.equal(extMod.classifyActionRoute(coexist), 'invalid');

    // tab.init → invalid
    const tabInit = stubAction('tab.init');
    assert.equal(classifyActionRoute(tabInit), 'invalid');
    assert.equal(extMod.classifyActionRoute(tabInit), 'invalid');

    // deleted actions → invalid
    for (const deleted of ['workspace.save', 'workspace.restore', 'workflow.status']) {
        const action = stubAction(deleted);
        assert.equal(classifyActionRoute(action), 'invalid', `agent: ${deleted} should be invalid`);
        assert.equal(extMod.classifyActionRoute(action), 'invalid', `extension: ${deleted} should be invalid`);
    }
});

test('browser.* action types are not request actions', () => {
    assert.equal(isRequestActionType('browser.goto'), false);
    assert.equal(isRequestActionType('browser.click'), false);
    assert.equal(isRequestActionType('browser.snapshot'), false);
    assert.equal(isRequestActionType('browser.fill'), false);
});

// ---- CONTROL_ACTIONS / WORKSPACE_ACTIONS must not exist ----

test('agent classify does not export CONTROL_ACTIONS', async () => {
    const mod = await import('../../src/actions/classify');
    assert.equal('CONTROL_ACTIONS' in mod, false);
});

test('agent classify does not export WORKSPACE_ACTIONS', async () => {
    const mod = await import('../../src/actions/classify');
    assert.equal('WORKSPACE_ACTIONS' in mod, false);
});

test('extension classify does not export CONTROL_ACTIONS', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    assert.equal('CONTROL_ACTIONS' in extMod, false);
});

test('extension classify does not export WORKSPACE_ACTIONS', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    assert.equal('WORKSPACE_ACTIONS' in extMod, false);
});

// ---- workspace route with payload.workspaceName specifically invalid ----

test('workspace route with payload.workspaceName is invalid', () => {
    const action = stubAction('record.start', {
        workspaceName: 'ws-1',
        payload: { workspaceName: 'ws-x' },
    });
    assert.equal(classifyActionRoute(action), 'invalid');
});

test('workspace route without payload.workspaceName is valid', () => {
    const action = stubAction('record.start', {
        workspaceName: 'ws-1',
        payload: { scene: 'test' },
    });
    assert.equal(classifyActionRoute(action), 'workspace');
});
