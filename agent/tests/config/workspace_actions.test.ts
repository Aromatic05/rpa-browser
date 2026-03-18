import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceHandlers } from '../../src/actions/workspace';
import { createRecordingState, getRecording } from '../../src/record/recording';
import { ERROR_CODES } from '../../src/actions/error_codes';

test('tab.opened activates resolved workspace/tab and logs payload', async () => {
    const logs: unknown[][] = [];
    const activated: Array<{ ws?: string; tab?: string }> = [];
    const ctx: any = {
        tabToken: 'token-1',
        page: {
            url: () => 'chrome-extension://start_extension/newtab.html',
        },
        log: (...args: unknown[]) => logs.push(args),
        pageRegistry: {
            resolveScopeFromToken: (token: string) => {
                assert.equal(token, 'token-1');
                return { workspaceId: 'ws-1', tabId: 'tab-1' };
            },
            setActiveWorkspace: (workspaceId: string) => activated.push({ ws: workspaceId }),
            setActiveTab: (workspaceId: string, tabId: string) => activated.push({ ws: workspaceId, tab: tabId }),
        },
    };

    const action: any = {
        v: 1,
        id: 'a1',
        type: 'tab.opened',
        payload: {
            source: 'start_extension',
            url: 'chrome://newtab/',
            title: 'New Tab',
            at: 123,
        },
    };

    const result = await workspaceHandlers['tab.opened'](ctx, action);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.workspaceId, 'ws-1');
    assert.equal(result.data.tabId, 'tab-1');
    assert.equal(result.data.tabToken, 'token-1');
    assert.equal(result.data.source, 'start_extension');

    assert.deepEqual(activated, [{ ws: 'ws-1' }, { ws: 'ws-1', tab: 'tab-1' }]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'tab.opened');
    assert.deepEqual(logs[0][1], {
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        tabToken: 'token-1',
        pageUrl: 'chrome-extension://start_extension/newtab.html',
        source: 'start_extension',
        reportedUrl: 'chrome://newtab/',
        reportedTitle: 'New Tab',
        reportedAt: 123,
    });
});

test('tab.activated activates resolved workspace/tab and logs payload', async () => {
    const logs: unknown[][] = [];
    const activated: Array<{ ws?: string; tab?: string }> = [];
    const ctx: any = {
        tabToken: 'token-2',
        page: {
            url: () => 'https://example.com/current',
        },
        log: (...args: unknown[]) => logs.push(args),
        pageRegistry: {
            resolveScopeFromToken: () => ({ workspaceId: 'ws-2', tabId: 'tab-9' }),
            setActiveWorkspace: (workspaceId: string) => activated.push({ ws: workspaceId }),
            setActiveTab: (workspaceId: string, tabId: string) => activated.push({ ws: workspaceId, tab: tabId }),
        },
    };
    const action: any = {
        v: 1,
        id: 'a2',
        type: 'tab.activated',
        payload: { source: 'extension.sw', url: 'https://example.com', at: 456 },
    };

    const result = await workspaceHandlers['tab.activated'](ctx, action);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(activated, [{ ws: 'ws-2' }, { ws: 'ws-2', tab: 'tab-9' }]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'tab.activated');
});

test('tab.closed resolves workspace/tab from token', async () => {
    const logs: unknown[][] = [];
    const ctx: any = {
        tabToken: 'token-closed',
        page: { url: () => 'about:blank' },
        log: (...args: unknown[]) => logs.push(args),
        pageRegistry: {
            resolveScopeFromToken: () => ({ workspaceId: 'ws-c', tabId: 'tab-c' }),
        },
    };
    const action: any = {
        v: 1,
        id: 'a3',
        type: 'tab.closed',
        payload: { source: 'extension.sw', at: 789 },
    };

    const result = await workspaceHandlers['tab.closed'](ctx, action);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.workspaceId, 'ws-c');
    assert.equal(result.data.tabId, 'tab-c');
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'tab.closed');
});

test('tab.ping updates alive timestamp and logs payload', async () => {
    const logs: unknown[][] = [];
    const touched: Array<{ token: string; at?: number }> = [];
    const ctx: any = {
        tabToken: 'token-ping',
        page: { url: () => 'https://example.com' },
        log: (...args: unknown[]) => logs.push(args),
        pageRegistry: {
            touchTabToken: (token: string, at?: number) => {
                touched.push({ token, at });
                return { workspaceId: 'ws-p', tabId: 'tab-p' };
            },
        },
    };
    const action: any = {
        v: 1,
        id: 'a4',
        type: 'tab.ping',
        payload: { source: 'extension.content', url: 'https://example.com', title: 'Example', at: 1001 },
    };

    const result = await workspaceHandlers['tab.ping'](ctx, action);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(touched, [{ token: 'token-ping', at: 1001 }]);
    assert.equal(result.data.workspaceId, 'ws-p');
    assert.equal(result.data.tabId, 'tab-p');
    assert.equal(logs[0][0], 'tab.ping');
});

test('tab.setActive records browser.switch_tab during active recording', async () => {
    const recordingState = createRecordingState();
    recordingState.recordingEnabled.add('token-a');
    recordingState.recordings.set('token-a', []);

    const activated: Array<{ ws?: string; tab?: string }> = [];
    const ctx: any = {
        tabToken: 'token-a',
        navDedupeWindowMs: 1200,
        recordingState,
        pageRegistry: {
            resolveScopeFromToken: (token: string) => {
                if (token === 'token-a') return { workspaceId: 'ws-1', tabId: 'tab-a' };
                throw new Error('unknown token');
            },
            resolveTabToken: ({ workspaceId, tabId }: { workspaceId: string; tabId: string }) => {
                assert.equal(workspaceId, 'ws-1');
                assert.equal(tabId, 'tab-b');
                return 'token-b';
            },
            setActiveTab: (workspaceId: string, tabId: string) => activated.push({ ws: workspaceId, tab: tabId }),
            resolvePage: async () => ({ bringToFront: async () => {}, url: () => 'https://example.com/b' }),
        },
    };
    const action: any = {
        v: 1,
        id: 'a5',
        type: 'tab.setActive',
        payload: { workspaceId: 'ws-1', tabId: 'tab-b' },
    };

    const result = await workspaceHandlers['tab.setActive'](ctx, action);
    assert.equal(result.ok, true);
    assert.deepEqual(activated, [{ ws: 'ws-1', tab: 'tab-b' }]);

    const recorded = getRecording(recordingState, 'token-a');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].name, 'browser.switch_tab');
    assert.equal((recorded[0].args as any).tab_id, 'tab-b');
});

test('workspace.save writes workspace snapshot and logs lifecycle', async () => {
    const logs: unknown[][] = [];
    const recordingState = createRecordingState();
    recordingState.recordings.set('rec-1', [
        {
            id: 'step-1',
            name: 'browser.goto',
            args: { url: 'https://example.com/a' },
            meta: { source: 'record', ts: 11, tabToken: 'secret-token', workspaceId: 'ws-1' },
        } as any,
    ]);
    recordingState.recordingManifests.set('rec-1', {
        recordingToken: 'rec-1',
        workspaceId: 'ws-1',
        startedAt: 11,
        tabs: [],
    });
    recordingState.workspaceLatestRecording.set('ws-1', 'rec-1');
    const ctx: any = {
        tabToken: 'token-a',
        recordingState,
        log: (...args: unknown[]) => logs.push(args),
        pageRegistry: {
            getActiveWorkspace: () => ({ workspaceId: 'ws-1' }),
            listTabs: async () => [{ tabId: 'tab-1', url: 'https://example.com/a', title: 'A', active: true }],
        },
    };
    const action: any = { v: 1, id: 'save-1', type: 'workspace.save', payload: {} };
    const result = await workspaceHandlers['workspace.save'](ctx, action);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.saved, true);
    assert.equal(result.data.workspaceId, 'ws-1');
    assert.equal(logs.some((entry) => entry[0] === 'workspace.save.start'), true);
    assert.equal(logs.some((entry) => entry[0] === 'workspace.save.end'), true);
    const snapshot = recordingState.workspaceSnapshots.get('ws-1');
    assert.equal(snapshot?.tabs.length, 1);
    assert.equal(snapshot?.recording.steps.length, 1);
    assert.equal(snapshot?.recording.steps[0].meta?.tabToken, undefined);
});

test('workspace.restore returns ERR_WORKSPACE_SNAPSHOT_NOT_FOUND when no snapshot', async () => {
    const recordingState = createRecordingState();
    const ctx: any = {
        tabToken: 'token-r',
        recordingState,
        log: () => undefined,
        pageRegistry: {
            createWorkspace: async () => ({ workspaceId: 'ws-new', tabId: 'tab-new' }),
        },
    };
    const action: any = {
        v: 1,
        id: 'restore-1',
        type: 'workspace.restore',
        payload: { workspaceId: 'ws-missing' },
    };
    const result = await workspaceHandlers['workspace.restore'](ctx, action);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, ERROR_CODES.ERR_WORKSPACE_SNAPSHOT_NOT_FOUND);
});

test('tab.init returns generated token', async () => {
    const result = await workspaceHandlers['tab.init']({} as any, {
        v: 1,
        id: 'init-1',
        type: 'tab.init',
        payload: {},
    } as any);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(typeof result.data.tabToken, 'string');
    assert.equal(result.data.tabToken.length > 10, true);
});

test('workspace.create opens workspace with tab when workspaceId is not provided', async () => {
    const calls: string[] = [];
    const ctx: any = {
        pageRegistry: {
            createWorkspace: async () => {
                calls.push('createWorkspace');
                return { workspaceId: 'ws-new', tabId: 'tab-new' };
            },
            resolveTabToken: ({ workspaceId, tabId }: { workspaceId: string; tabId: string }) => {
                calls.push('resolveTabToken');
                assert.equal(workspaceId, 'ws-new');
                assert.equal(tabId, 'tab-new');
                return 'token-new';
            },
            createWorkspaceShell: () => {
                throw new Error('should not call createWorkspaceShell');
            },
        },
    };
    const result = await workspaceHandlers['workspace.create'](ctx, {
        v: 1,
        id: 'create-1',
        type: 'workspace.create',
        payload: {},
    } as any);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.workspaceId, 'ws-new');
    assert.equal(result.data.tabId, 'tab-new');
    assert.equal(result.data.tabToken, 'token-new');
    assert.deepEqual(calls, ['createWorkspace', 'resolveTabToken']);
});

test('workspace.create uses shell path when workspaceId is provided', async () => {
    const ctx: any = {
        pageRegistry: {
            createWorkspaceShell: (workspaceId: string) => ({ workspaceId }),
            createWorkspace: async () => {
                throw new Error('should not call createWorkspace');
            },
            resolveTabToken: () => {
                throw new Error('should not call resolveTabToken');
            },
        },
    };
    const result = await workspaceHandlers['workspace.create'](ctx, {
        v: 1,
        id: 'create-2',
        type: 'workspace.create',
        payload: { workspaceId: 'ws-shell' },
    } as any);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.workspaceId, 'ws-shell');
    assert.equal(result.data.tabId, null);
    assert.equal(result.data.tabToken, null);
});

test('tab.reassign moves token to target workspace', async () => {
    const logs: unknown[][] = [];
    const ctx: any = {
        tabToken: 'token-reassign',
        log: (...args: unknown[]) => logs.push(args),
        pageRegistry: {
            moveTokenToWorkspace: (tabToken: string, workspaceId: string) => {
                assert.equal(tabToken, 'token-reassign');
                assert.equal(workspaceId, 'ws-target');
                return { workspaceId: 'ws-target', tabId: 'tab-target' };
            },
            setActiveWorkspace: (_workspaceId: string) => undefined,
            setActiveTab: (_workspaceId: string, _tabId: string) => undefined,
        },
    };

    const result = await workspaceHandlers['tab.reassign'](ctx, {
        v: 1,
        id: 'reassign-1',
        type: 'tab.reassign',
        payload: { workspaceId: 'ws-target', source: 'extension.sw', at: 2001 },
        scope: { tabToken: 'token-reassign' },
    } as any);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.workspaceId, 'ws-target');
    assert.equal(result.data.tabId, 'tab-target');
    assert.equal(logs[0][0], 'tab.reassign');
});
