import type { Page } from 'playwright';
import type { ActionContext } from '../../src/actions/execute';
import { executeCommand } from '../../src/actions/execute';
import { createRecordingState } from '../../src/record/recording';
import type { PageRegistry } from '../../src/runtime/page_registry';

export const createRegistry = (page: Page, tabName: string): PageRegistry => ({
    bindPage: async () => tabName,
    getPage: async () => page,
    listPages: () => [{ tabName, page }],
    cleanup: () => {},
    createWorkspace: async () => ({ workspaceName: 'ws-test', tabName: 'tab-test' }),
    listWorkspaces: () => [{ workspaceName: 'ws-test', activeTabName: 'tab-test', tabCount: 1, createdAt: Date.now(), updatedAt: Date.now() }],
    setActiveWorkspace: () => {},
    getActiveWorkspace: () => null,
    createTab: async () => 'tab-test',
    closeTab: async () => {},
    setActiveTab: () => {},
    listTabs: async () => [{ tabName: 'tab-test', url: page.url(), title: '', active: true, createdAt: Date.now(), updatedAt: Date.now() }],
    resolvePage: async () => page,
    resolveScope: () => ({ workspaceName: 'ws-test', tabName: 'tab-test' }),
    resolveTabBinding: () => ({ workspaceName: 'ws-test', tabName: 'tab-test' }),
    resolveTabName: () => tabName,
});

export const createCtx = (page: Page, tabName: string): ActionContext => {
    const pageRegistry = createRegistry(page, tabName);
    const ctx: ActionContext = {
        page,
        tabName,
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
