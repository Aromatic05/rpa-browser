import type { Page } from 'playwright';
import type { ActionContext } from '../../src/actions/execute';
import { executeCommand } from '../../src/actions/execute';
import { createRecordingState } from '../../src/record/recording';
import type { PageRegistry } from '../../src/runtime/page_registry';

export const createRegistry = (page: Page, tabToken: string): PageRegistry => ({
    bindPage: async () => tabToken,
    getPage: async () => page,
    listPages: () => [{ tabToken, page }],
    cleanup: () => {},
    createWorkspace: async () => ({ workspaceId: 'ws-test', tabId: 'tab-test' }),
    listWorkspaces: () => [{ workspaceId: 'ws-test', activeTabId: 'tab-test', tabCount: 1, createdAt: Date.now(), updatedAt: Date.now() }],
    setActiveWorkspace: () => {},
    getActiveWorkspace: () => null,
    createTab: async () => 'tab-test',
    closeTab: async () => {},
    setActiveTab: () => {},
    listTabs: async () => [{ tabId: 'tab-test', url: page.url(), title: '', active: true, createdAt: Date.now(), updatedAt: Date.now() }],
    resolvePage: async () => page,
    resolveScope: () => ({ workspaceId: 'ws-test', tabId: 'tab-test' }),
    resolveScopeFromToken: () => ({ workspaceId: 'ws-test', tabId: 'tab-test' }),
    resolveTabToken: () => tabToken,
});

export const createCtx = (page: Page, tabToken: string): ActionContext => {
    const pageRegistry = createRegistry(page, tabToken);
    const ctx: ActionContext = {
        page,
        tabToken,
        pageRegistry,
        log: () => {},
        recordingState: createRecordingState(),
        replayOptions: {
            clickDelayMs: 0,
            stepDelayMs: 0,
            scroll: { minDelta: 200, maxDelta: 300, minSteps: 1, maxSteps: 2 },
        },
        navDedupeWindowMs: 300,
        execute: undefined,
    };
    ctx.execute = (cmd) => executeCommand(ctx, cmd);
    return ctx;
};
