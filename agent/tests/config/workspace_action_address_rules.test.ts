import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceHandlers } from '../../src/actions/workspace';
import { createActionDispatcher } from '../../src/actions/dispatcher';
import { createRecordingState } from '../../src/record/recording';
import type { Action } from '../../src/actions/action_protocol';

const createWorkspaceRuntime = () => {
    const tabs = new Map<string, { name: string; url: string; title: string; createdAt: number; updatedAt: number }>([
        ['tab-1', { name: 'tab-1', url: 'https://example.com', title: 'Example', createdAt: 1, updatedAt: 2 }],
    ]);
    let activeTab = 'tab-1';
    return {
        name: 'ws-1',
        createdAt: 1,
        updatedAt: 2,
        tabRegistry: {
            listTabs: () => Array.from(tabs.values()),
            getActiveTab: () => tabs.get(activeTab),
            setActiveTab: (tabName: string) => {
                if (!tabs.has(tabName)) {throw new Error(`tab not found: ${tabName}`);}
                activeTab = tabName;
            },
            hasTab: (tabName: string) => tabs.has(tabName),
            resolveTab: (tabName?: string) => {
                const key = tabName || activeTab;
                const tab = tabs.get(key);
                if (!tab) {throw new Error(`tab not found: ${key}`);}
                return tab;
            },
        },
    };
};

const createCtx = () => {
    const workspace = createWorkspaceRuntime();
    return {
        workspaceRegistry: {
            getWorkspace: (name: string) => (name === workspace.name ? workspace : null),
            setActiveWorkspace: () => undefined,
            createWorkspace: () => workspace,
            listWorkspaces: () => [workspace],
            getActiveWorkspace: () => workspace,
        },
        pageRegistry: { getPage: async () => ({ url: () => 'https://example.com' }) },
        recordingState: createRecordingState(),
        replayOptions: {} as any,
        navDedupeWindowMs: 0,
        emit: () => undefined,
        log: () => undefined,
    } as any;
};

test('tab.list accepts top-level workspaceName with empty payload', async () => {
    const handler = workspaceHandlers['tab.list'];
    const reply = await handler(createCtx(), { v: 1, id: 'a1', type: 'tab.list', workspaceName: 'ws-1', payload: {} } as Action);
    assert.equal(reply.type, 'tab.list.result');
});

test('tab.setActive accepts top-level workspaceName with payload.tabName', async () => {
    const handler = workspaceHandlers['tab.setActive'];
    const reply = await handler(createCtx(), {
        v: 1,
        id: 'a2',
        type: 'tab.setActive',
        workspaceName: 'ws-1',
        payload: { tabName: 'tab-1' },
    } as Action);
    assert.equal(reply.type, 'tab.setActive.result');
});

test('workspace.setActive accepts top-level workspaceName with empty payload', async () => {
    const handler = workspaceHandlers['workspace.setActive'];
    const reply = await handler(createCtx(), { v: 1, id: 'a3', type: 'workspace.setActive', workspaceName: 'ws-1', payload: {} } as Action);
    assert.equal(reply.type, 'workspace.setActive.result');
});

test('workspace action fails when top-level workspaceName is missing', async () => {
    const handler = workspaceHandlers['tab.list'];
    const reply = await handler(createCtx(), { v: 1, id: 'a4', type: 'tab.list', payload: {} } as Action);
    assert.equal(reply.type, 'tab.list.failed');
});

test('dispatcher rejects payload.workspaceName for tab.list', async () => {
    const dispatcher = createActionDispatcher({
        pageRegistry: {} as any,
        workspaceRegistry: {
            getWorkspace: () => null,
        } as any,
        recordingState: createRecordingState(),
        log: () => undefined,
        replayOptions: {} as any,
        navDedupeWindowMs: 0,
    });
    await assert.rejects(
        async () =>
            await dispatcher.dispatch({
                v: 1,
                id: 'a5',
                type: 'tab.list',
                workspaceName: 'ws-1',
                payload: { workspaceName: 'ws-1' },
            } as Action),
        /legacy payload address fields are not allowed/,
    );
});
