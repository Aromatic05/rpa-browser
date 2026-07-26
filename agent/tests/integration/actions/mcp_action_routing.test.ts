import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { classifyActionRoute, isControlAction, isWorkspaceAction } from '../../../src/actions/classify';
import {
    REQUEST_ACTION_TYPES,
    classifyActionType,
    isRequestActionType,
} from '../../../src/actions/action_types';
import { createWorkspaceHarness } from '../../helpers/workspace_harness';
import type { Action } from '../../../src/actions/action_protocol';

const stubAction = (type: string, opts?: { workspaceName?: string; payload?: Record<string, unknown> }): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName: opts?.workspaceName,
    payload: opts?.payload ?? {},
    at: Date.now(),
});

const createMinimalWorkspaceRegistry = () => createWorkspaceHarness().registry;

test('mcp.start without workspaceName is control-shaped but routes to workspace validation', () => {
    const action = stubAction('mcp.start');
    assert.equal(isControlAction(action), true);
    assert.equal(isWorkspaceAction(action), false);
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('mcp.stop without workspaceName routes to workspace validation', () => {
    const action = stubAction('mcp.stop');
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('mcp.status without workspaceName routes to workspace validation', () => {
    const action = stubAction('mcp.status');
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('mcp.start with workspaceName is a workspace action', () => {
    const action = stubAction('mcp.start', { workspaceName: 'test-ws' });
    assert.equal(isWorkspaceAction(action), true);
    assert.equal(isControlAction(action), false);
});

test('mcp.stop with workspaceName is a workspace action', () => {
    const action = stubAction('mcp.stop', { workspaceName: 'test-ws' });
    assert.equal(isWorkspaceAction(action), true);
});

test('mcp.status with workspaceName is a workspace action', () => {
    const action = stubAction('mcp.status', { workspaceName: 'test-ws' });
    assert.equal(isWorkspaceAction(action), true);
});

test('mcp.start routes to workspace when workspaceName present', () => {
    const action = stubAction('mcp.start', { workspaceName: 'test-ws' });
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('mcp.start still selects workspace route when workspaceName is missing', () => {
    const action = stubAction('mcp.start');
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('mcp.status still selects workspace route when workspaceName is missing', () => {
    const action = stubAction('mcp.status');
    assert.equal(classifyActionRoute(action), 'workspace');
});

test('mcp.start is a registered request action type', () => {
    assert.equal(isRequestActionType('mcp.start'), true);
});

test('mcp.stop is a registered request action type', () => {
    assert.equal(isRequestActionType('mcp.stop'), true);
});

test('mcp.status is a registered request action type', () => {
    assert.equal(isRequestActionType('mcp.status'), true);
});

test('mcp action types classify as command', () => {
    assert.equal(classifyActionType('mcp.start'), 'command');
    assert.equal(classifyActionType('mcp.stop'), 'command');
    assert.equal(classifyActionType('mcp.status'), 'command');
});

test('browser.goto is not a request action type', () => {
    assert.equal(isRequestActionType('browser.goto'), false);
});

test('browser.click is not a request action type', () => {
    assert.equal(isRequestActionType('browser.click'), false);
});

test('mcp.start with workspaceName is not a control action', () => {
    const action = stubAction('mcp.start', { workspaceName: 'test-ws' });
    assert.equal(isControlAction(action), false);
});

test('mcp.status routes through workspace gateway with workspaceName', async () => {
    const registry = createMinimalWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, { name: wsName } as any);

    const result = await ws.mcp.handle({
        action: stubAction('mcp.status', { workspaceName: wsName }),
        workspace: ws,
        workspaceRegistry: registry,
    });

    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, wsName);
    assert.equal(payload.serviceName, 'mcp');
    assert.equal(payload.status, 'stopped');
});

test('mcp.start with workspaceName and payload.workspaceName is classified invalid by classify layer', () => {
    const action = stubAction('mcp.start', { workspaceName: 'ws-1', payload: { workspaceName: 'ws-1' } });
    assert.equal(classifyActionRoute(action), 'invalid');
});

test('mcp.stop with workspaceName and payload.workspaceName is classified invalid by classify layer', () => {
    const action = stubAction('mcp.stop', { workspaceName: 'ws-1', payload: { workspaceName: 'ws-1' } });
    assert.equal(classifyActionRoute(action), 'invalid');
});

test('REQUEST_ACTION_TYPES includes MCP actions', () => {
    assert.equal(REQUEST_ACTION_TYPES.MCP_START, 'mcp.start');
    assert.equal(REQUEST_ACTION_TYPES.MCP_STOP, 'mcp.stop');
    assert.equal(REQUEST_ACTION_TYPES.MCP_STATUS, 'mcp.status');
});

test('browser.* StepNames are not in request action types', () => {
    const requestTypes = new Set<string>(Object.values(REQUEST_ACTION_TYPES));
    assert.equal(requestTypes.has('browser.goto'), false);
    assert.equal(requestTypes.has('browser.click'), false);
    assert.equal(requestTypes.has('browser.snapshot'), false);
    assert.equal(requestTypes.has('browser.fill'), false);
});
