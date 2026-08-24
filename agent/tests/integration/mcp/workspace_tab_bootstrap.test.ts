import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright';
import { createWorkspaceToolHandlers } from '../../../src/interface/mcp/tool_handlers';
import { createWorkspaceTabs } from '../../../src/runtime/workspace/tabs';
import type { RuntimeWorkspace } from '../../../src/runtime/workspace/workspace';
import { runWorkspaceExecution } from '../../../src/runtime/workspace/execution_coordinator';
import type { StepUnion } from '../../../src/runner/steps/types';
import { completeRunStepsDeps } from '../../helpers/run_steps_workspace';
import {ActionError, ERROR_CODES} from '../../../src/interface/actions/results';

const createStubPage = (url = 'about:blank'): Page => ({
    url: () => url,
    isClosed: () => false,
    close: async () => undefined,
    bringToFront: async () => undefined,
    on: () => undefined,
    context: () => ({}) as BrowserContext,
} as unknown as Page);

type Harness = {
    workspace: RuntimeWorkspace;
    calls: StepUnion[];
    awaitedTabs: string[];
    handlers: ReturnType<typeof createWorkspaceToolHandlers>;
};

const createHarness = (): Harness => {
    const calls: StepUnion[] = [];
    const awaitedTabs: string[] = [];
    const pages = new Map<string, Page>();
    const tabs = createWorkspaceTabs({
        awaitPageBinding: async (tabName) => {
            const page = pages.get(tabName);
            if (!page) {throw new Error(`page binding missing: ${tabName}`);}
            return page;
        },
        createPageBinding: async (tabName, input) => {
            const page = createStubPage(input?.startUrl || `about:blank#${tabName}`);
            pages.set(tabName, page);
            return page;
        },
    });
    const workspace = {
        name: 'test-ws',
        tabs,
        state: 'idle',
        executionOwner: null,
    } as unknown as RuntimeWorkspace;
    const execute = async (step: StepUnion) => {
        calls.push(step);
        return {
            stepId: step.id,
            ok: true,
            data: step.name === 'browser.create_tab'
                ? { tabName: 'created-by-executor' }
                : { name: step.name },
        };
    };
    const pluginHost = {
        getExecutors: () => ({
            'browser.goto': execute,
            'browser.get_page_info': execute,
            'browser.list_tabs': execute,
            'browser.create_tab': execute,
        }),
    } as any;
    const runStepsDeps = completeRunStepsDeps({
        pluginHost,
        resolveWorkspace: () => workspace,
    });
    const handlers = createWorkspaceToolHandlers({
        workspace,
        runStepsDeps,
        runWorkspaceExecution: async (actionType, run) => await runWorkspaceExecution(workspace, actionType, run),
        awaitTabPage: async (tabName, timeoutMs) => {
            awaitedTabs.push(tabName);
            return await tabs.awaitTabPage(tabName, timeoutMs);
        },
    });
    return { workspace, calls, awaitedTabs, handlers };
};

const registerTab = (harness: Harness, tabName: string, url = `about:blank#${tabName}`) => {
    harness.workspace.tabs.createTab({ tabName });
    harness.workspace.tabs.bindPage(tabName, createStubPage(url));
};

test('goto rejects an unknown explicit tab before page bootstrap', async () => {
    const harness = createHarness();
    await assert.rejects(
        () => harness.handlers['browser.goto']({ url: 'https://example.com', tabName: 'missing' }),
        /tab not found/,
    );
    assert.deepEqual(harness.awaitedTabs, []);
    assert.deepEqual(harness.calls, []);
});

test('goto without an active tab defers first-tab bootstrap to the executor', async () => {
    const harness = createHarness();
    const result = await harness.handlers['browser.goto']({ url: 'https://example.com' });
    assert.equal(result.ok, true);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].name, 'browser.goto');
    assert.deepEqual(harness.awaitedTabs, []);
});

test('goto awaits the selected workspace page then executes the current step', async () => {
    const harness = createHarness();
    registerTab(harness, 'existing');

    const result = await harness.handlers['browser.goto']({
        url: 'https://example.com',
        tabName: 'existing',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(harness.awaitedTabs, ['existing']);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].name, 'browser.goto');
    assert.deepEqual(harness.calls[0].args, { url: 'https://example.com' });
    assert.equal(harness.workspace.tabs.getActiveTab()?.name, 'existing');
});

test('goto can await a page for an existing metadata-only tab', async () => {
    const harness = createHarness();
    harness.workspace.tabs.createTab({ tabName: 'metadata-only' });
    const page = await harness.workspace.tabs.createTabPage('metadata-only', {
        startUrl: 'https://metadata.test',
    });
    harness.workspace.tabs.bindPage('metadata-only', page);

    const result = await harness.handlers['browser.goto']({
        url: 'https://destination.test',
        tabName: 'metadata-only',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(harness.awaitedTabs, ['metadata-only']);
});

test('read-only page info does not run the page bootstrap hook', async () => {
    const harness = createHarness();
    registerTab(harness, 'info-tab');

    const result = await harness.handlers['browser.get_page_info']({ tabName: 'info-tab' });

    assert.equal(result.ok, true);
    assert.deepEqual(harness.awaitedTabs, []);
    assert.equal(harness.calls[0].name, 'browser.get_page_info');
});

test('workspace execution blocks tab-scoped MCP tools while list_tabs remains observable', async () => {
    const harness = createHarness();
    registerTab(harness, 'owned-tab');
    registerTab(harness, 'other-tab');
    harness.workspace.state = 'executing';
    harness.workspace.executionOwner = Symbol('active-task-run');

    await assert.rejects(
        () => harness.handlers['browser.goto']({
            url: 'https://blocked.test',
            tabName: 'owned-tab',
        }),
        (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
    );
    assert.deepEqual(harness.awaitedTabs, []);
    assert.equal(harness.calls.length, 0);

    await assert.rejects(
        () => harness.handlers['browser.get_page_info']({tabName: 'other-tab'}),
        (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
    );
    assert.equal(harness.workspace.tabs.getActiveTab()?.name, 'owned-tab');
    assert.equal(harness.calls.length, 0);

    const observed = await harness.handlers['browser.list_tabs']({});
    assert.equal(observed.ok, true);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].name, 'browser.list_tabs');
    assert.equal(harness.workspace.tabs.getActiveTab()?.name, 'owned-tab');
});

test('browser.create_tab rejects the removed MCP tabName argument', async () => {
    const harness = createHarness();
    const result = await harness.handlers['browser.create_tab']({ tabName: 'legacy-name' });
    assert.equal(result.ok, false);
    assert.equal((result.error as { code?: string })?.code, 'ERR_BAD_ARGS');
    assert.deepEqual(harness.calls, []);
});

test('browser.create_tab executes without requiring an active source tab', async () => {
    const harness = createHarness();
    const result = await harness.handlers['browser.create_tab']({});
    assert.equal(result.ok, true);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0].name, 'browser.create_tab');
});

test('workspace tool handler set exposes the supported browser entrypoints', () => {
    const harness = createHarness();
    for (const name of [
        'browser.goto',
        'browser.create_tab',
        'browser.switch_tab',
        'browser.close_tab',
        'browser.click',
        'browser.snapshot',
    ]) {
        assert.equal(typeof harness.handlers[name], 'function', `missing handler: ${name}`);
    }
});
