import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { createWorkspaceToolHandlers } from '../../src/mcp/tool_handlers';
import { createWorkspaceTabs } from '../../src/runtime/workspace/tabs';
import type { WorkspaceService, WorkspaceServiceName, WorkspaceServiceStartResult, WorkspaceServiceStopResult, WorkspaceServiceStatusResult } from '../../src/runtime/service/types';

const createServiceLifecycle = (workspaceName: string) => {
    const services = new Map<WorkspaceServiceName, WorkspaceService>();
    return {
        register(service: WorkspaceService) { services.set(service.name, service); },
        async start(serviceName: WorkspaceServiceName): Promise<WorkspaceServiceStartResult> {
            const service = services.get(serviceName);
            if (!service) { throw new Error(`service not registered: ${serviceName}`); }
            return await service.start();
        },
        async stop(serviceName: WorkspaceServiceName): Promise<WorkspaceServiceStopResult> {
            const service = services.get(serviceName);
            if (!service) { throw new Error(`service not registered: ${serviceName}`); }
            return await service.stop();
        },
        status(serviceName: WorkspaceServiceName): WorkspaceServiceStatusResult {
            const service = services.get(serviceName);
            if (!service) { return { serviceName, workspaceName, port: null, status: 'stopped' as const }; }
            return service.status();
        },
    };
};
import type { RuntimeWorkspace } from '../../src/runtime/workspace/workspace';
import type { RunStepsDeps } from '../../src/runner/run_steps_types';

const projectRoot = path.resolve(process.cwd());

const createStubPage = (tabName: string): Page => {
    const stub = new EventEmitter() as unknown as Page & { url: () => string };
    (stub as any).url = () => `about:blank#${tabName}`;
    (stub as any).close = async () => {};
    (stub as any).bringToFront = async () => {};
    (stub as any).goto = async (_url: string) => null;
    return stub as Page;
};

const createRunStepsDeps = (): RunStepsDeps => ({
    runtime: null as unknown as RunStepsDeps['runtime'],
    config: {} as RunStepsDeps['config'],
    pluginHost: { getExecutors: () => ({}) } as RunStepsDeps['pluginHost'],
});

const createMockWorkspace = (name: string, overrides?: Partial<RuntimeWorkspace>): RuntimeWorkspace => ({
    name,
    workflow: { name, steps: [], checkpoints: [], recording: null, entityRules: { rules: [], bundles: [] } },
    runner: null,
    tabRegistry: createWorkspaceTabs({ getPage: async (tabName: string) => createStubPage(tabName) as Page }),
    controls: {} as RuntimeWorkspace['controls'],
    serviceLifecycle: createServiceLifecycle(name),
    getPage: async () => createStubPage(name) as Page,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
});

test('bootstrap creates tab via workspace scoped getPage when tab missing', async () => {
    const getPageCalls: string[] = [];
    const ws = createMockWorkspace('test-ws', {
        getPage: async (tabName: string) => {
            getPageCalls.push(tabName);
            return createStubPage(tabName) as Page;
        },
    });
    const handlers = createWorkspaceToolHandlers({
        workspace: ws,
        getPage: (tabName: string) => ws.getPage(tabName),
        runStepsDeps: createRunStepsDeps(),
    });

    await assert.doesNotReject(
        () => handlers['browser.goto']({ url: 'https://example.com', tabName: 'fresh-tab' }),
    );
    assert.equal(getPageCalls.length, 1);
    assert.equal(getPageCalls[0], 'fresh-tab');
});

test('new tab is written to workspace.tabRegistry after bootstrap', async () => {
    const ws = createMockWorkspace('test-ws');
    const handlers = createWorkspaceToolHandlers({
        workspace: ws,
        getPage: (tabName: string) => ws.getPage(tabName),
        runStepsDeps: createRunStepsDeps(),
    });

    assert.equal(ws.tabRegistry.hasTab('registered-tab'), false);

    await handlers['browser.goto']({ url: 'https://example.com', tabName: 'registered-tab' });

    assert.equal(ws.tabRegistry.hasTab('registered-tab'), true);
});

test('new tab is set as active tab after bootstrap', async () => {
    const ws = createMockWorkspace('test-ws');
    const handlers = createWorkspaceToolHandlers({
        workspace: ws,
        getPage: (tabName: string) => ws.getPage(tabName),
        runStepsDeps: createRunStepsDeps(),
    });

    await handlers['browser.goto']({ url: 'https://example.com', tabName: 'target-tab' });

    const activeTab = ws.tabRegistry.getActiveTab();
    assert.ok(activeTab);
    assert.equal(activeTab!.name, 'target-tab');
});

test('existing tab is not re-created', async () => {
    const getPageCalls: string[] = [];
    const ws = createMockWorkspace('test-ws', {
        getPage: async (tabName: string) => {
            getPageCalls.push(tabName);
            return createStubPage(tabName) as Page;
        },
    });
    const preExistingPage = createStubPage('existing') as Page;
    ws.tabRegistry.createTab({ tabName: 'existing', page: preExistingPage, url: preExistingPage.url() });

    const handlers = createWorkspaceToolHandlers({
        workspace: ws,
        getPage: (tabName: string) => ws.getPage(tabName),
        runStepsDeps: createRunStepsDeps(),
    });

    await handlers['browser.goto']({ url: 'https://example.com', tabName: 'existing' });

    assert.equal(getPageCalls.length, 0);
    assert.equal(ws.tabRegistry.getActiveTab()?.name, 'existing');
});

test('no active tab bootstrap throws active tab not found', async () => {
    const ws = createMockWorkspace('test-ws');
    const handlers = createWorkspaceToolHandlers({
        workspace: ws,
        getPage: (tabName: string) => ws.getPage(tabName),
        runStepsDeps: createRunStepsDeps(),
    });

    await assert.rejects(
        () => handlers['browser.goto']({ url: 'https://example.com' }),
        /active tab not found/,
    );
});

test('bootstrap with tabName but no getPage throws clear error', async () => {
    const ws = createMockWorkspace('test-ws');
    const handlers = createWorkspaceToolHandlers({
        workspace: ws,
        runStepsDeps: createRunStepsDeps(),
    });

    await assert.rejects(
        () => handlers['browser.goto']({ url: 'https://example.com', tabName: 'no-provider' }),
        /cannot bootstrap tab: getPage not provided/,
    );
});

test('browser.create_tab calls workspace scoped getPage for new tab', async () => {
    const getPageCalls: string[] = [];
    const ws = createMockWorkspace('test-ws', {
        getPage: async (tabName: string) => {
            getPageCalls.push(tabName);
            return createStubPage(tabName) as Page;
        },
    });
    const handlers = createWorkspaceToolHandlers({
        workspace: ws,
        getPage: (tabName: string) => ws.getPage(tabName),
        runStepsDeps: createRunStepsDeps(),
    });

    await handlers['browser.create_tab']({ url: 'https://example.com', tabName: 'created-tab' });

    assert.ok(getPageCalls.length >= 1);
    assert.equal(getPageCalls[0], 'created-tab');
});

test('browser.create_tab registers new tab in workspace.tabRegistry', async () => {
    const ws = createMockWorkspace('test-ws');
    const handlers = createWorkspaceToolHandlers({
        workspace: ws,
        getPage: (tabName: string) => ws.getPage(tabName),
        runStepsDeps: createRunStepsDeps(),
    });

    assert.equal(ws.tabRegistry.hasTab('new-created-tab'), false);
    await handlers['browser.create_tab']({ url: 'https://example.com', tabName: 'new-created-tab' });
    assert.equal(ws.tabRegistry.hasTab('new-created-tab'), true);
});

test('bootstrap binds real Page to created tab', async () => {
    const ws = createMockWorkspace('test-ws');
    const handlers = createWorkspaceToolHandlers({
        workspace: ws,
        getPage: (tabName: string) => ws.getPage(tabName),
        runStepsDeps: createRunStepsDeps(),
    });

    await handlers['browser.goto']({ url: 'https://example.com', tabName: 'bound-tab' });

    const tab = ws.tabRegistry.getTab('bound-tab');
    assert.ok(tab);
    assert.ok(tab!.page);
});

test('createWorkspaceToolHandlers accepts getPage from deps', async () => {
    const ws = createMockWorkspace('test-ws');
    const handlers = createWorkspaceToolHandlers({
        workspace: ws,
        getPage: (tabName: string) => ws.getPage(tabName),
    });

    assert.ok(typeof handlers['browser.goto'] === 'function');
    assert.ok(typeof handlers['browser.create_tab'] === 'function');
    assert.ok(typeof handlers['browser.click'] === 'function');
});

test('tool_handlers.ts does not import PageRegistry', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_handlers.ts'), 'utf8');
    assert.ok(!content.includes('PageRegistry'));
});

test('tool_handlers.ts does not import WorkspaceRegistry', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_handlers.ts'), 'utf8');
    assert.ok(!/WorkspaceRegistry/.test(content));
});

test('no repo references to McpToolDeps (standalone, not WorkspaceMcpToolDeps)', () => {
    const result = execSync(
        'grep -rnE "export type McpToolDeps\\b|: McpToolDeps[^W]|deps: McpToolDeps" --include="*.ts" --include="*.tsx" src/ || true',
        { cwd: projectRoot, encoding: 'utf8' },
    ).trim();
    assert.equal(result, '');
});

test('no repo references to startMcpServer', () => {
    const result = execSync(
        'grep -rn "startMcpServer" --include="*.ts" --include="*.tsx" src/ || true',
        { cwd: projectRoot, encoding: 'utf8' },
    ).trim();
    assert.equal(result, '');
});

test('no repo references to createMcpServer export', () => {
    const result = execSync(
        'grep -rnE "export.*createMcpServer|import.*createMcpServer" --include="*.ts" --include="*.tsx" src/ || true',
        { cwd: projectRoot, encoding: 'utf8' },
    ).trim();
    assert.equal(result, '');
});

test('agent/src/mcp/server.ts does not exist', () => {
    assert.equal(fs.existsSync(path.join(projectRoot, 'src/mcp/server.ts')), false);
});
