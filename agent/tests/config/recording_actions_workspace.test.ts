import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingHandlers } from '../../src/actions/recording';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createRecordingState } from '../../src/record/recording';
import type { ActionContext } from '../../src/actions/execute';
import type { Workflow, WorkflowArtifact, WorkflowDummy } from '../../src/workflow';

const createWorkflowStub = (name: string): Workflow => {
    const store = new Map<string, WorkflowArtifact>();
    return {
        name,
        save: (value) => {
            store.set(`${value.kind}:${value.name}`, value);
            return value;
        },
        get: (artifactName: string, dummy: WorkflowDummy) => store.get(`${dummy.kind}:${artifactName}`) || null,
        list: (dummy: WorkflowDummy) =>
            Array.from(store.values())
                .filter((item) => item.kind === dummy.kind)
                .map((item) => ({ kind: item.kind, name: item.name, title: item.name, createdAt: 1, updatedAt: 1, summary: '' })),
        delete: (artifactName: string, dummy: WorkflowDummy) => store.delete(`${dummy.kind}:${artifactName}`),
    };
};

const createMockPage = (url: string) => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
        url: () => url,
        on: (event: string, handler: (...args: unknown[]) => void) => {
            listeners.set(event, [...(listeners.get(event) || []), handler]);
        },
        mainFrame: () => ({ url: () => url }),
        frames: () => [],
        exposeBinding: async () => {},
        addInitScript: async () => {},
        evaluate: async () => {},
    } as any;
};

const createContext = (): ActionContext => {
    const workspaceRegistry = createWorkspaceRegistry();
    return {
        workspaceRegistry,
        workspace: null,
        resolveTab: () => {
            throw new Error('resolveTab should not be called');
        },
        resolvePage: () => {
            throw new Error('resolvePage should not be called');
        },
        pageRegistry: {} as any,
        log: () => {},
        recordingState: createRecordingState(),
        replayOptions: {
            clickDelayMs: 10,
            stepDelayMs: 10,
            scroll: { minDelta: 10, maxDelta: 20, minSteps: 1, maxSteps: 2 },
        },
        navDedupeWindowMs: 1200,
    };
};

test('record.start fails clearly when workspace has no bound page', async () => {
    const ctx = createContext();
    ctx.workspaceRegistry.createWorkspace('ws-empty', createWorkflowStub('ws-empty'));
    const action = { v: 1 as const, id: 'a1', type: 'record.start', workspaceName: 'ws-empty', payload: {} };
    const reply = await recordingHandlers['record.start'](ctx, action);
    assert.equal(reply.type, 'record.start.failed');
    assert.match(String((reply as any).payload?.message || ''), /bound page/i);
});

test('record.start succeeds with workspace bound page without resolvePage', async () => {
    const ctx = createContext();
    const workspace = ctx.workspaceRegistry.createWorkspace('ws-a', createWorkflowStub('ws-a'));
    workspace.tabRegistry.createTab({ tabName: 'tab-a', page: createMockPage('https://example.com/a'), url: 'https://example.com/a' });
    const action = { v: 1 as const, id: 'a2', type: 'record.start', workspaceName: 'ws-a', payload: {} };
    const reply = await recordingHandlers['record.start'](ctx, action);
    assert.equal(reply.type, 'record.start.result');
    assert.equal((reply as any).payload?.pageUrl, 'https://example.com/a');
});

test('record.get/save/clear use workspaceName', async () => {
    const ctx = createContext();
    const workspace = ctx.workspaceRegistry.createWorkspace('ws-b', createWorkflowStub('ws-b'));
    workspace.tabRegistry.createTab({ tabName: 'tab-b', page: createMockPage('https://example.com/b'), url: 'https://example.com/b' });
    await recordingHandlers['record.start'](ctx, { v: 1, id: 'b1', type: 'record.start', workspaceName: 'ws-b', payload: {} });

    const got = await recordingHandlers['record.get'](ctx, { v: 1, id: 'b2', type: 'record.get', workspaceName: 'ws-b', payload: {} });
    assert.equal(got.type, 'record.get.result');

    const saved = await recordingHandlers['record.save'](ctx, {
        v: 1,
        id: 'b3',
        type: 'record.save',
        workspaceName: 'ws-b',
        payload: { recordingName: 'rec-b' },
    });
    assert.equal(saved.type, 'record.save.result');

    const cleared = await recordingHandlers['record.clear'](ctx, { v: 1, id: 'b4', type: 'record.clear', workspaceName: 'ws-b', payload: {} });
    assert.equal(cleared.type, 'record.clear.result');
});
