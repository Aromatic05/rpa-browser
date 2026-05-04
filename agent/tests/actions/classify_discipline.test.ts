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

// workspace.setActive is a control action
test('workspace.setActive is a control action', () => {
    const action = stubAction('workspace.setActive', { payload: { workspaceName: 'ws-1' } });
    assert.equal(isControlAction(action), true);
    assert.equal(isWorkspaceAction(action), false);
});

test('workspace.setActive with action.workspaceName is invalid', () => {
    const action = stubAction('workspace.setActive', {
        workspaceName: 'ws-1',
        payload: {},
    });
    assert.equal(classifyActionRoute(action), 'invalid');
});

test('workspace.setActive with payload.workspaceName routes to control', () => {
    const action = stubAction('workspace.setActive', {
        payload: { workspaceName: 'ws-1' },
    });
    assert.equal(classifyActionRoute(action), 'control');
});

// workspace action missing workspaceName → invalid
test('workspace action missing action.workspaceName is invalid', () => {
    const action = stubAction('tab.list');
    assert.equal(classifyActionRoute(action), 'invalid');
});

test('workspace action with action.workspaceName routes to workspace', () => {
    const action = stubAction('tab.list', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
});

// workspace action with payload.workspaceName → invalid
test('workspace action with payload.workspaceName is invalid', () => {
    const action = stubAction('tab.list', {
        workspaceName: 'ws-1',
        payload: { workspaceName: 'ws-2' },
    });
    assert.equal(classifyActionRoute(action), 'invalid');
});

test('workspace action without payload.workspaceName is valid', () => {
    const action = stubAction('tab.list', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'workspace');
});

// action.workspaceName + payload.workspaceName coexistence → invalid
test('action.workspaceName and payload.workspaceName coexistence is invalid', () => {
    const action = stubAction('workspace.list', {
        workspaceName: 'ws-1',
        payload: { workspaceName: 'ws-1' },
    });
    assert.equal(classifyActionRoute(action), 'invalid');
});

// workspace.save is not a request action
test('workspace.save is not a request action', () => {
    assert.equal(isRequestActionType('workspace.save'), false);
});

// workspace.restore is not a request action
test('workspace.restore is not a request action', () => {
    assert.equal(isRequestActionType('workspace.restore'), false);
});

// workflow.status is not a request action
test('workflow.status is not a request action', () => {
    assert.equal(isRequestActionType('workflow.status'), false);
});

// mcp.* are workspace actions
test('mcp.start is a workspace action', () => {
    const action = stubAction('mcp.start', { workspaceName: 'ws-1' });
    assert.equal(isWorkspaceAction(action), true);
    assert.equal(isControlAction(action), false);
});

test('mcp.stop is a workspace action', () => {
    const action = stubAction('mcp.stop', { workspaceName: 'ws-1' });
    assert.equal(isWorkspaceAction(action), true);
});

test('mcp.status is a workspace action', () => {
    const action = stubAction('mcp.status', { workspaceName: 'ws-1' });
    assert.equal(isWorkspaceAction(action), true);
});

// checkpoint.* are workspace actions
test('checkpoint.list is a workspace action', () => {
    const action = stubAction('checkpoint.list', { workspaceName: 'ws-1' });
    assert.equal(isWorkspaceAction(action), true);
});

test('checkpoint.get is a workspace action', () => {
    const action = stubAction('checkpoint.get', { workspaceName: 'ws-1' });
    assert.equal(isWorkspaceAction(action), true);
});

// entity_rules.* are workspace actions
test('entity_rules.list is a workspace action', () => {
    const action = stubAction('entity_rules.list', { workspaceName: 'ws-1' });
    assert.equal(isWorkspaceAction(action), true);
});

test('entity_rules.get is a workspace action', () => {
    const action = stubAction('entity_rules.get', { workspaceName: 'ws-1' });
    assert.equal(isWorkspaceAction(action), true);
});

// control actions
test('workspace.list is a control action', () => {
    const action = stubAction('workspace.list');
    assert.equal(isControlAction(action), true);
});

test('workspace.create is a control action', () => {
    const action = stubAction('workspace.create');
    assert.equal(isControlAction(action), true);
});

test('workflow.list is a control action', () => {
    const action = stubAction('workflow.list');
    assert.equal(isControlAction(action), true);
});

test('workflow.create is a control action', () => {
    const action = stubAction('workflow.create');
    assert.equal(isControlAction(action), true);
});

test('workflow.open is a control action', () => {
    const action = stubAction('workflow.open');
    assert.equal(isControlAction(action), true);
});

test('workflow.rename is a control action', () => {
    const action = stubAction('workflow.rename');
    assert.equal(isControlAction(action), true);
});

test('tab.init is a control action', () => {
    const action = stubAction('tab.init');
    assert.equal(isControlAction(action), true);
});

// control action with action.workspaceName → invalid
test('control action with action.workspaceName is invalid', () => {
    const action = stubAction('workspace.list', { workspaceName: 'ws-1' });
    assert.equal(classifyActionRoute(action), 'invalid');
});

// ---- extension classification parity ----
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '..');

test('agent and extension control action sets are consistent', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    const controlActions = [
        'workspace.list',
        'workspace.create',
        'workspace.setActive',
        'workflow.list',
        'workflow.create',
        'workflow.open',
        'workflow.rename',
        'tab.init',
    ];
    for (const type of controlActions) {
        assert.equal(isControlAction(stubAction(type)), true, `${type} should be control`);
        assert.equal(extMod.isControlAction(type), true, `extension: ${type} should be control`);
        assert.equal(extMod.isWorkspaceAction(type), false, `extension: ${type} should not be workspace`);
    }
});

test('agent and extension workspace action sets are consistent', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    const workspaceActions = [
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
    for (const type of workspaceActions) {
        const wsAction = stubAction(type, { workspaceName: 'ws-1' });
        assert.equal(isWorkspaceAction(wsAction), true, `${type} should be workspace`);
        assert.equal(extMod.isWorkspaceAction(type), true, `extension: ${type} should be workspace`);
        assert.equal(extMod.isControlAction(type), false, `extension: ${type} should not be control`);
    }
});

test('workspace.save is not classified as control or workspace in extension', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    assert.equal(extMod.isControlAction('workspace.save'), false);
    assert.equal(extMod.isWorkspaceAction('workspace.save'), false);
    assert.equal(extMod.classifyRequestAction('workspace.save'), 'invalid');
});

test('workspace.restore is not classified as control or workspace in extension', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    assert.equal(extMod.isControlAction('workspace.restore'), false);
    assert.equal(extMod.isWorkspaceAction('workspace.restore'), false);
    assert.equal(extMod.classifyRequestAction('workspace.restore'), 'invalid');
});

test('workflow.status is not classified as control or workspace in extension', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    assert.equal(extMod.isControlAction('workflow.status'), false);
    assert.equal(extMod.isWorkspaceAction('workflow.status'), false);
    assert.equal(extMod.classifyRequestAction('workflow.status'), 'invalid');
});

test('mcp.* are workspace actions in extension', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    assert.equal(extMod.isWorkspaceAction('mcp.start'), true);
    assert.equal(extMod.isWorkspaceAction('mcp.stop'), true);
    assert.equal(extMod.isWorkspaceAction('mcp.status'), true);
});

test('checkpoint.* are workspace actions in extension', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    assert.equal(extMod.isWorkspaceAction('checkpoint.list'), true);
    assert.equal(extMod.isWorkspaceAction('checkpoint.get'), true);
    assert.equal(extMod.isWorkspaceAction('checkpoint.save'), true);
    assert.equal(extMod.isWorkspaceAction('checkpoint.delete'), true);
});

test('entity_rules.* are workspace actions in extension', async () => {
    const extMod = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    assert.equal(extMod.isWorkspaceAction('entity_rules.list'), true);
    assert.equal(extMod.isWorkspaceAction('entity_rules.get'), true);
    assert.equal(extMod.isWorkspaceAction('entity_rules.save'), true);
    assert.equal(extMod.isWorkspaceAction('entity_rules.delete'), true);
});

// ---- route classification ----

// reply and event classification
test('reply action routes to reply', () => {
    const action = stubAction('workspace.list.result');
    assert.equal(classifyActionRoute(action), 'reply');
});

test('event action routes to event', () => {
    const action = stubAction('play.progress');
    assert.equal(classifyActionRoute(action), 'event');
});
