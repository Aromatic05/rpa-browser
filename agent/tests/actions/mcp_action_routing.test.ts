import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { classifyActionRoute, isControlAction, isWorkspaceAction } from '../../src/actions/classify';
import {
    REQUEST_ACTION_TYPES,
    classifyActionType,
    isRequestActionType,
} from '../../src/actions/action_types';
import { createWorkspaceRegistry } from '../../src/runtime/workspace/registry';
import { createPortAllocator } from '../../src/runtime/service/ports';
import type { Action } from '../../src/actions/action_protocol';
import type { RunStepsDeps } from '../../src/runner/run_steps_types';

const stubAction = (type: string, opts?: { workspaceName?: string; payload?: Record<string, unknown> }): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName: opts?.workspaceName,
    payload: opts?.payload ?? {},
    at: Date.now(),
});

const createMinimalWorkspaceRegistry = () => {
    const portAllocator = createPortAllocator(20000);
    const stubPageRegistry = {
        getPage: async () => {
            throw new Error('not implemented in test');
        },
    };
    const stubRecordingState = {
        recordingEnabled: new Set<string>(),
        recordingTokens: new Map<string, string>(),
        recordings: new Map(),
    };
    const stubRunStepsDeps: RunStepsDeps = {
        runtime: null as unknown as RunStepsDeps['runtime'],
        config: {} as RunStepsDeps['config'],
        pluginHost: {} as RunStepsDeps['pluginHost'],
    };
    return createWorkspaceRegistry({
        pageRegistry: stubPageRegistry as any,
        recordingState: stubRecordingState as any,
        replayOptions: { clickDelayMs: 300, stepDelayMs: 900, scroll: { minDelta: 220, maxDelta: 520, minSteps: 2, maxSteps: 4 } },
        navDedupeWindowMs: 1200,
        runStepsDeps: stubRunStepsDeps,
        runnerConfig: {
            checkpointPolicy: { enabled: false, filePath: '/tmp/.test-checkpoints', flushIntervalMs: 0 },
            mcpPolicy: {},
        } as any,
        portAllocator,
    });
};

test('mcp.start without workspaceName is not a control action', () => {
    const action = stubAction('mcp.start');
    assert.equal(isControlAction(action), false);
});

test('mcp.stop without workspaceName is not a control action', () => {
    const action = stubAction('mcp.stop');
    assert.equal(isControlAction(action), false);
});

test('mcp.status without workspaceName is not a control action', () => {
    const action = stubAction('mcp.status');
    assert.equal(isControlAction(action), false);
});

test('mcp.start without workspaceName is not a workspace action', () => {
    const action = stubAction('mcp.start');
    assert.equal(isWorkspaceAction(action), false);
});

test('mcp.start with workspaceName is a workspace action', () => {
    const action = stubAction('mcp.start', { workspaceName: 'test-ws' });
    assert.equal(isWorkspaceAction(action), true);
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

test('mcp.start routes to invalid when workspaceName missing', () => {
    const action = stubAction('mcp.start');
    assert.equal(classifyActionRoute(action), 'invalid');
});

test('mcp.status routes to invalid when workspaceName missing', () => {
    const action = stubAction('mcp.status');
    assert.equal(classifyActionRoute(action), 'invalid');
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

test('control action set does not include mcp.start', () => {
    const action = stubAction('mcp.start', { workspaceName: 'test-ws' });
    assert.equal(isControlAction(action), false);
});

test('mcp.status routes through workspace gateway with workspaceName', async () => {
    const registry = createMinimalWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, { name: wsName } as any);

    const result = await ws.mcp.handle(
        stubAction('mcp.status', { workspaceName: wsName }),
        ws,
    );

    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, wsName);
    assert.equal(payload.serviceName, 'mcp');
    assert.equal(payload.status, 'stopped');
});

test('mcp.start rejects payload.workspaceName through workspace gateway', async () => {
    const registry = createMinimalWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, { name: wsName } as any);

    await assert.rejects(
        () => ws.mcp.handle(
            stubAction('mcp.start', { workspaceName: wsName, payload: { workspaceName: wsName } }),
            ws,
        ),
        /mcp actions do not accept payload.workspaceName/,
    );
});

test('mcp.stop rejects payload.workspaceName through workspace gateway', async () => {
    const registry = createMinimalWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, { name: wsName } as any);

    await assert.rejects(
        () => ws.mcp.handle(
            stubAction('mcp.stop', { workspaceName: wsName, payload: { workspaceName: wsName } }),
            ws,
        ),
        /mcp actions do not accept payload.workspaceName/,
    );
});

test('REQUEST_ACTION_TYPES includes MCP actions', () => {
    assert.equal(REQUEST_ACTION_TYPES.MCP_START, 'mcp.start');
    assert.equal(REQUEST_ACTION_TYPES.MCP_STOP, 'mcp.stop');
    assert.equal(REQUEST_ACTION_TYPES.MCP_STATUS, 'mcp.status');
});

test('browser.* StepNames are not in request action types', () => {
    const requestTypes = new Set(Object.values(REQUEST_ACTION_TYPES));
    assert.equal(requestTypes.has('browser.goto'), false);
    assert.equal(requestTypes.has('browser.click'), false);
    assert.equal(requestTypes.has('browser.snapshot'), false);
    assert.equal(requestTypes.has('browser.fill'), false);
});
