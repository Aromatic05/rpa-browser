import crypto from 'crypto';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { createPageRegistry } from '../../src/runtime/page_registry';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createRuntimeRegistry } from '../../src/runtime/runtime_registry';
import { createNoopHooks } from '../../src/runner/trace/hooks';
import { runStepList } from '../../src/runner/run_steps';
import { getRunnerConfig } from '../../src/config';
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

export const setupStepRunner = async (page: Page, tabName = `test-${crypto.randomUUID()}`) => {
    const pageRegistry = createPageRegistry({
        tabNameKey: '__rpa_tab_name',
        getContext: async () => page.context(),
    });
    await pageRegistry.bindPage(page, tabName);
    const workspaceName = `ws-${crypto.randomUUID()}`;
    const tabName = tabName;

    const pluginHost = await createTestPluginHost();
    const workspaceRegistry = createWorkspaceRegistry();
    const runtimeWorkspace = workspaceRegistry.createWorkspace(workspaceName);
    runtimeWorkspace.tabRegistry.createTab({
        tabName: tabName,
        page,
        url: page.url(),
    });
    runtimeWorkspace.tabRegistry.setActiveTab(tabName);
    const runtime = createRuntimeRegistry({
        traceHooks: createNoopHooks(),
        pluginHost,
    });
    runtime.bindPage({ workspaceName, tabName: tabName, page });

    const deps = { runtime, config: getRunnerConfig(), pluginHost };

    const run = async (steps: StepUnion[]) => {
        const { pipe, checkpoint } = await runStepList(workspaceName, steps, deps, { stopOnError: true });
        const items = pipe.items as Array<{ stepId: string; ok: boolean; data?: unknown }>;
        const results = items.map((item) => ({ stepId: item.stepId, ok: item.ok, data: item.data }));
        return { ok: checkpoint.status !== 'failed' && results.every((item) => item.ok), results };
    };

    return { run, workspaceName, tabName, tabName, pageRegistry, deps };
};

export const findA11yNodeId = (tree: any, role: string, name: string): string | null => {
    if (!tree) {return null;}
    if (tree.role === role && tree.name === name) {return tree.id;}
    for (const child of tree.children || []) {
        const found = findA11yNodeId(child, role, name);
        if (found) {return found;}
    }
    return null;
};
