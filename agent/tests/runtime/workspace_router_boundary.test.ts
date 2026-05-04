import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkspaceRouter } from '../../src/runtime/workspace/router';
import type { WorkspaceRouterInput, WorkspaceRouterDeps } from '../../src/runtime/workspace/router';
import type { RuntimeWorkspace } from '../../src/runtime/workspace/workspace';
import type { WorkspaceRegistry } from '../../src/runtime/workspace/registry';
import type { ControlPlaneResult } from '../../src/runtime/control_plane';
import type { Action } from '../../src/actions/action_protocol';
import { replyAction } from '../../src/actions/action_protocol';

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

type StubControl = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
    calls: WorkspaceRouterInput[];
};

const createStubControl = (): StubControl => {
    const control: StubControl = {
        calls: [],
        handle: async (input) => {
            control.calls.push(input);
            return { reply: replyAction(input.action, { forwarded: true }), events: [] };
        },
    };
    return control;
};

const createMinimalWorkspace = (name: string): RuntimeWorkspace =>
    ({
        name,
        workflow: { name } as any,
        tabs: {
            listTabs: () => [],
            getActiveTab: () => null,
            hasTab: () => false,
        } as any,
        record: {} as any,
        dsl: {} as any,
        checkpoint: {} as any,
        entityRules: {} as any,
        runner: {} as any,
        mcp: {
            start: async () => ({ workspaceName: name, serviceName: 'mcp', port: 0, status: 'running' }),
            stop: async () => ({ workspaceName: name, serviceName: 'mcp', status: 'stopped' }),
            status: () => ({ workspaceName: name, serviceName: 'mcp', port: null, status: 'stopped' }),
        } as any,
        router: {} as any,
        createdAt: 0,
        updatedAt: 0,
    }) as RuntimeWorkspace;

const createMinimalRegistry = (): WorkspaceRegistry =>
    ({
        getWorkspace: () => null,
        getActiveWorkspace: () => null,
        setActiveWorkspace: () => undefined,
    }) as any;

const createRouterWithStubs = () => {
    const tabsControl = createStubControl();
    const recordControl = createStubControl();
    const dslControl = createStubControl();
    const checkpointControl = createStubControl();
    const entityRulesControl = createStubControl();
    const runnerControl = createStubControl();
    const mcpControl = createStubControl();

    const deps: WorkspaceRouterDeps = {
        tabsControl,
        recordControl,
        dslControl,
        checkpointControl,
        entityRulesControl,
        runnerControl,
        mcpControl,
    };

    const router = createWorkspaceRouter(deps);

    return {
        router,
        tabsControl,
        recordControl,
        dslControl,
        checkpointControl,
        entityRulesControl,
        runnerControl,
        mcpControl,
    };
};

// ---- WorkspaceRouter boundary tests ----

test('tab.list is forwarded to tabsControl', async () => {
    const { router, tabsControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('tab.list', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(tabsControl.calls.length, 1);
    assert.equal(tabsControl.calls[0].action.type, 'tab.list');
});

test('tab.create is forwarded to tabsControl', async () => {
    const { router, tabsControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('tab.create', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(tabsControl.calls.length, 1);
});

test('tab.close is forwarded to tabsControl', async () => {
    const { router, tabsControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('tab.close', { workspaceName: 'ws-1', payload: { tabName: 'tab-1' } });

    await router.handle(action, workspace, registry);
    assert.equal(tabsControl.calls.length, 1);
});

test('mcp.start is forwarded to mcpControl', async () => {
    const { router, mcpControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('mcp.start', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(mcpControl.calls.length, 1);
    assert.equal(mcpControl.calls[0].action.type, 'mcp.start');
});

test('mcp.stop is forwarded to mcpControl', async () => {
    const { router, mcpControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('mcp.stop', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(mcpControl.calls.length, 1);
});

test('mcp.status is forwarded to mcpControl', async () => {
    const { router, mcpControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('mcp.status', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(mcpControl.calls.length, 1);
});

test('WorkspaceRouter does not handle tab.init', async () => {
    const { router, tabsControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('tab.init', { workspaceName: 'ws-1' });

    // Router forwards tab.init to tabsControl (prefix forwarding), but
    // real TabsControl rejects it (tested separately).
    const result = await router.handle(action, workspace, registry);
    assert.equal(tabsControl.calls.length, 1);
    assert.equal(tabsControl.calls[0].action.type, 'tab.init');
    assert.equal(result.reply.type, 'tab.init.result');
});

test('TabsControl rejects tab.init', async () => {
    const tabsControl = createTabsControl();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('tab.init', { workspaceName: 'ws-1' });

    await assert.rejects(
        () => tabsControl.handle({ action, workspace, workspaceRegistry: registry }),
        /unsupported tab action/,
    );
});

test('WorkspaceRouter does not handle workspace.setActive', async () => {
    const { router } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('workspace.setActive', {
        workspaceName: 'ws-1',
        payload: { workspaceName: 'ws-1' },
    });

    await assert.rejects(
        () => router.handle(action, workspace, registry),
        /unsupported action/,
    );
});

test('WorkspaceRouter does not handle workspace.save', async () => {
    const { router } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('workspace.save', { workspaceName: 'ws-1' });

    await assert.rejects(
        () => router.handle(action, workspace, registry),
        /unsupported action/,
    );
});

test('WorkspaceRouter does not handle workspace.restore', async () => {
    const { router } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('workspace.restore', { workspaceName: 'ws-1' });

    await assert.rejects(
        () => router.handle(action, workspace, registry),
        /unsupported action/,
    );
});

test('WorkspaceRouter does not handle workflow.status', async () => {
    const { router } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('workflow.status', { workspaceName: 'ws-1' });

    await assert.rejects(
        () => router.handle(action, workspace, registry),
        /unsupported action/,
    );
});

test('WorkspaceRouter does not parse tab payload', async () => {
    const { router, tabsControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('tab.report', {
        workspaceName: 'ws-1',
        payload: { tabName: 'tab-1', url: 'https://example.com' },
    });

    await router.handle(action, workspace, registry);
    assert.equal(tabsControl.calls.length, 1);
    // Router forwarded the action; it didn't parse the payload itself
    assert.equal(tabsControl.calls[0].action.payload.tabName, 'tab-1');
});

test('WorkspaceRouter does not construct mcp reply', async () => {
    const { router, mcpControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('mcp.status', { workspaceName: 'ws-1' });

    const result = await router.handle(action, workspace, registry);
    // Router forwarded to mcpControl; the reply was constructed by the stub
    assert.equal(mcpControl.calls.length, 1);
    assert.equal(result.reply.type, 'mcp.status.result');
});

test('record.* is forwarded to recordControl', async () => {
    const { router, recordControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('record.start', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(recordControl.calls.length, 1);
});

test('play.* is forwarded to recordControl', async () => {
    const { router, recordControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('play.start', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(recordControl.calls.length, 1);
});

test('dsl.* is forwarded to dslControl', async () => {
    const { router, dslControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('dsl.get', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(dslControl.calls.length, 1);
});

test('checkpoint.* is forwarded to checkpointControl', async () => {
    const { router, checkpointControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('checkpoint.list', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(checkpointControl.calls.length, 1);
});

test('entity_rules.* is forwarded to entityRulesControl', async () => {
    const { router, entityRulesControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('entity_rules.list', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(entityRulesControl.calls.length, 1);
});

test('task.run.* is forwarded to runnerControl', async () => {
    const { router, runnerControl } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('task.run.start', { workspaceName: 'ws-1' });

    await router.handle(action, workspace, registry);
    assert.equal(runnerControl.calls.length, 1);
});

test('unknown action returns unsupported action', async () => {
    const { router } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('unknown.action', { workspaceName: 'ws-1' });

    await assert.rejects(
        () => router.handle(action, workspace, registry),
        /unsupported action/,
    );
});

// ---- TabsControl boundary tests ----
import { createTabsControl } from '../../src/runtime/workspace/tabs';
import { createWorkspaceTabs } from '../../src/runtime/workspace/tabs';

test('TabsControl handles tab.list', async () => {
    const tabsControl = createTabsControl();
    const tabs = createWorkspaceTabs({
        getPage: async () => {
            throw new Error('not implemented');
        },
    });
    const workspace = {
        name: 'ws-1',
        tabs,
    } as RuntimeWorkspace;
    const registry = createMinimalRegistry();
    const action = stubAction('tab.list', { workspaceName: 'ws-1' });

    const result = await tabsControl.handle({ action, workspace, workspaceRegistry: registry });
    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, 'ws-1');
    assert.ok(Array.isArray(payload.tabs));
});

test('TabsControl handles tab.create', async () => {
    const tabsControl = createTabsControl();
    let pageCreated = false;
    const tabs = createWorkspaceTabs({
        getPage: async () => {
            pageCreated = true;
            return { url: () => 'about:blank', isClosed: () => false } as any;
        },
    });
    const workspace = {
        name: 'ws-1',
        tabs,
    } as RuntimeWorkspace;
    const registry = createMinimalRegistry();
    const action = stubAction('tab.create', { workspaceName: 'ws-1' });

    const result = await tabsControl.handle({ action, workspace, workspaceRegistry: registry });
    assert.equal(pageCreated, true);
    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, 'ws-1');
    assert.ok(typeof payload.tabName === 'string');
});

test('TabsControl handles tab.close', async () => {
    const tabsControl = createTabsControl();
    let pageClosed = false;
    const tabs = createWorkspaceTabs({
        getPage: async () => {
            throw new Error('not implemented');
        },
    });
    tabs.createTab({ tabName: 'tab-1', url: 'https://example.com' });
    // Override closeTab to track it
    const originalClose = tabs.closeTab;
    tabs.closeTab = async (tabName: string) => {
        pageClosed = true;
        return await originalClose(tabName);
    };

    const workspace = {
        name: 'ws-1',
        tabs,
    } as RuntimeWorkspace;
    const registry = createMinimalRegistry();
    const action = stubAction('tab.close', {
        workspaceName: 'ws-1',
        payload: { tabName: 'tab-1' },
    });

    const result = await tabsControl.handle({ action, workspace, workspaceRegistry: registry });
    assert.equal(pageClosed, true);
    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.tabName, 'tab-1');
});

test('TabsControl tab.activated returns unsupported', async () => {
    const tabsControl = createTabsControl();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('tab.activated', { workspaceName: 'ws-1' });

    await assert.rejects(
        () => tabsControl.handle({ action, workspace, workspaceRegistry: registry }),
        /unsupported action/,
    );
});

test('TabsControl unknown tab action returns unsupported', async () => {
    const tabsControl = createTabsControl();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('tab.unknown', { workspaceName: 'ws-1' });

    await assert.rejects(
        () => tabsControl.handle({ action, workspace, workspaceRegistry: registry }),
        /unsupported tab action/,
    );
});

// ---- McpControl boundary tests ----
import { createMcpControl } from '../../src/mcp/control';
import type { WorkspaceService } from '../../src/runtime/service/types';

test('McpControl handles mcp.start', async () => {
    let started = false;
    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'ws-1',
        start: async () => {
            started = true;
            return { serviceName: 'mcp', workspaceName: 'ws-1', port: 1234, status: 'running' };
        },
        stop: async () => ({ serviceName: 'mcp', workspaceName: 'ws-1', status: 'stopped' }),
        status: () => ({ serviceName: 'mcp', workspaceName: 'ws-1', port: null, status: 'stopped' }),
    };
    const mcpControl = createMcpControl(service);
    const workspace = createMinimalWorkspace('ws-1');
    // Replace workspace.mcp with the mcpControl itself so handle can call workspace.mcp.start()
    (workspace as any).mcp = mcpControl;
    const registry = createMinimalRegistry();
    const action = stubAction('mcp.start', { workspaceName: 'ws-1' });

    const result = await mcpControl.handle({ action, workspace, workspaceRegistry: registry });
    assert.equal(started, true);
    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, 'ws-1');
    assert.equal(payload.status, 'running');
});

test('McpControl handles mcp.stop', async () => {
    let stopped = false;
    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'ws-1',
        start: async () => ({ serviceName: 'mcp', workspaceName: 'ws-1', port: 0, status: 'running' }),
        stop: async () => {
            stopped = true;
            return { serviceName: 'mcp', workspaceName: 'ws-1', status: 'stopped' };
        },
        status: () => ({ serviceName: 'mcp', workspaceName: 'ws-1', port: null, status: 'running' }),
    };
    const mcpControl = createMcpControl(service);
    const workspace = createMinimalWorkspace('ws-1');
    (workspace as any).mcp = mcpControl;
    const registry = createMinimalRegistry();
    const action = stubAction('mcp.stop', { workspaceName: 'ws-1' });

    const result = await mcpControl.handle({ action, workspace, workspaceRegistry: registry });
    assert.equal(stopped, true);
    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.status, 'stopped');
});

test('McpControl handles mcp.status', async () => {
    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'ws-1',
        start: async () => ({ serviceName: 'mcp', workspaceName: 'ws-1', port: 0, status: 'running' }),
        stop: async () => ({ serviceName: 'mcp', workspaceName: 'ws-1', status: 'stopped' }),
        status: () => ({ serviceName: 'mcp', workspaceName: 'ws-1', port: 5678, status: 'running' }),
    };
    const mcpControl = createMcpControl(service);
    const workspace = createMinimalWorkspace('ws-1');
    (workspace as any).mcp = mcpControl;
    const registry = createMinimalRegistry();
    const action = stubAction('mcp.status', { workspaceName: 'ws-1' });

    const result = await mcpControl.handle({ action, workspace, workspaceRegistry: registry });
    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.port, 5678);
    assert.equal(payload.status, 'running');
});

test('McpControl unknown mcp action returns unsupported', async () => {
    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'ws-1',
        start: async () => ({ serviceName: 'mcp', workspaceName: 'ws-1', port: 0, status: 'running' }),
        stop: async () => ({ serviceName: 'mcp', workspaceName: 'ws-1', status: 'stopped' }),
        status: () => ({ serviceName: 'mcp', workspaceName: 'ws-1', port: null, status: 'stopped' }),
    };
    const mcpControl = createMcpControl(service);
    const workspace = createMinimalWorkspace('ws-1');
    (workspace as any).mcp = mcpControl;
    const registry = createMinimalRegistry();
    const action = stubAction('mcp.unknown', { workspaceName: 'ws-1' });

    await assert.rejects(
        () => mcpControl.handle({ action, workspace, workspaceRegistry: registry }),
        /unsupported mcp action/,
    );
});

// ---- Router does not handle control actions ----

test('WorkspaceRouter does not handle workspace.list', async () => {
    const { router } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('workspace.list', { workspaceName: 'ws-1' });

    await assert.rejects(
        () => router.handle(action, workspace, registry),
        /unsupported action/,
    );
});

test('WorkspaceRouter does not handle workflow.create', async () => {
    const { router } = createRouterWithStubs();
    const workspace = createMinimalWorkspace('ws-1');
    const registry = createMinimalRegistry();
    const action = stubAction('workflow.create', { workspaceName: 'ws-1' });

    await assert.rejects(
        () => router.handle(action, workspace, registry),
        /unsupported action/,
    );
});

// ---- Router source discipline ----

test('WorkspaceRouter source has prefix-forwarder discipline comment', () => {
    const src = fs.readFileSync(
        path.resolve(process.cwd(), 'src/runtime/workspace/router.ts'),
        'utf-8',
    );
    assert.ok(src.includes('prefix-only forwarder'));
    assert.ok(src.includes('MUST NOT parse domain payloads'));
    assert.ok(src.includes('MUST NOT construct domain business replies'));
});
