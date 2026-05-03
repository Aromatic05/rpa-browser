import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { classifyActionRoute, isControlAction, isWorkspaceAction } from '../../src/actions/classify';
import {
    REQUEST_ACTION_TYPES,
    classifyActionType,
    isRequestActionType,
} from '../../src/actions/action_types';
import { createActionDispatcher } from '../../src/actions/dispatcher';
import { createWorkspaceServiceLifecycle, type WorkspaceService } from '../../src/runtime/service';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createPortAllocator } from '../../src/runtime/port_allocator';
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

test('mcp.start routes through workspace gateway with workspaceName', async () => {
    const registry = createMinimalWorkspaceRegistry();
    const workflow = {
        name: 'test-ws',
        steps: [],
        checkpoints: [],
        recording: null,
        entityRules: { rules: [], bundles: [] },
    };
    const ws = registry.createWorkspace('test-ws', workflow);

    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'test-ws',
        async start() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: 11111, status: 'running' as const };
        },
        async stop() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', status: 'stopped' as const };
        },
        status() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: 11111, status: 'running' as const };
        },
    };
    ws.serviceLifecycle.register(service);

    const dispatcher = createActionDispatcher({
        workspaceRegistry: registry,
        log: () => {},
    });

    const result = await dispatcher.dispatch(
        stubAction('mcp.start', { workspaceName: 'test-ws' }),
    );

    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, 'test-ws');
    assert.equal(payload.serviceName, 'mcp');
    assert.equal(payload.port, 11111);
    assert.equal(payload.status, 'running');
});

test('mcp.stop routes through workspace gateway with workspaceName', async () => {
    const registry = createMinimalWorkspaceRegistry();
    const workflow = {
        name: 'test-ws',
        steps: [],
        checkpoints: [],
        recording: null,
        entityRules: { rules: [], bundles: [] },
    };
    const ws = registry.createWorkspace('test-ws', workflow);

    let running = false;
    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'test-ws',
        async start() {
            running = true;
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: 11111, status: 'running' as const };
        },
        async stop() {
            running = false;
            return { serviceName: 'mcp', workspaceName: 'test-ws', status: 'stopped' as const };
        },
        status() {
            return {
                serviceName: 'mcp',
                workspaceName: 'test-ws',
                port: running ? 11111 : null,
                status: running ? ('running' as const) : ('stopped' as const),
            };
        },
    };
    ws.serviceLifecycle.register(service);
    await ws.serviceLifecycle.start('mcp');

    const dispatcher = createActionDispatcher({
        workspaceRegistry: registry,
        log: () => {},
    });

    const result = await dispatcher.dispatch(
        stubAction('mcp.stop', { workspaceName: 'test-ws' }),
    );

    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, 'test-ws');
    assert.equal(payload.status, 'stopped');
});

test('mcp.status routes through workspace gateway with workspaceName', async () => {
    const registry = createMinimalWorkspaceRegistry();
    const workflow = {
        name: 'test-ws',
        steps: [],
        checkpoints: [],
        recording: null,
        entityRules: { rules: [], bundles: [] },
    };
    const ws = registry.createWorkspace('test-ws', workflow);

    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'test-ws',
        async start() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: 11111, status: 'running' as const };
        },
        async stop() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', status: 'stopped' as const };
        },
        status() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: 11111, status: 'running' as const };
        },
    };
    ws.serviceLifecycle.register(service);
    await ws.serviceLifecycle.start('mcp');

    const dispatcher = createActionDispatcher({
        workspaceRegistry: registry,
        log: () => {},
    });

    const result = await dispatcher.dispatch(
        stubAction('mcp.status', { workspaceName: 'test-ws' }),
    );

    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, 'test-ws');
    assert.equal(payload.port, 11111);
    assert.equal(payload.status, 'running');
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
