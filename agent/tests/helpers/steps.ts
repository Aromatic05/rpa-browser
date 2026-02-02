import crypto from 'crypto';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { createPageRegistry } from '../../src/runtime/page_registry';
import { createRuntimeRegistry } from '../../src/runtime/runtime_registry';
import { createNoopHooks } from '../../src/runner/trace/hooks';
import { runSteps } from '../../src/runner/run_steps';
import { getRunnerConfig } from '../../src/runner/config';
import type { StepArgsMap, StepName, StepUnion } from '../../src/runner/steps/types';
import { RunnerPluginHost } from '../../src/runner/hotreload/plugin_host';

export const createStep = <TName extends StepName>(name: TName, args: StepArgsMap[TName]): StepUnion => ({
    id: crypto.randomUUID(),
    name,
    args,
});

export const createTestPluginHost = async () => {
    const entryFile = path.resolve(process.cwd(), 'src/runner/plugin_entry.ts');
    const host = new RunnerPluginHost(entryFile);
    await host.load();
    return host;
};

export const setupStepRunner = async (page: Page, tabToken = `test-${crypto.randomUUID()}`) => {
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
        getContext: async () => page.context(),
    });

    await pageRegistry.bindPage(page, tabToken);
    const scope = pageRegistry.resolveScopeFromToken(tabToken);
    pageRegistry.setActiveWorkspace(scope.workspaceId);
    pageRegistry.setActiveTab(scope.workspaceId, scope.tabId);

    const runtime = createRuntimeRegistry({
        pageRegistry,
        traceHooks: createNoopHooks(),
    });

    const pluginHost = await createTestPluginHost();
    const deps = { runtime, config: getRunnerConfig(), pluginHost };

    const run = async (steps: StepUnion[]) =>
        runSteps({ workspaceId: scope.workspaceId, steps, options: { stopOnError: true } }, deps);

    return { run, workspaceId: scope.workspaceId, tabId: scope.tabId, tabToken, pageRegistry, deps };
};

export const findA11yNodeId = (tree: any, role: string, name: string): string | null => {
    if (!tree) return null;
    if (tree.role === role && tree.name === name) return tree.id;
    for (const child of tree.children || []) {
        const found = findA11yNodeId(child, role, name);
        if (found) return found;
    }
    return null;
};
