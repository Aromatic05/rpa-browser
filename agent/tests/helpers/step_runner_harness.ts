import crypto from 'crypto';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { createPageRegistry } from '../../src/runtime/browser/page_registry';
import { createWorkspaceHarness } from './workspace_harness';
import { createWorkflowOnFs } from '../../src/automation/workflow';
import { createExecutionBindings } from '../../src/runtime/execution/bindings';
import { createNoopHooks } from '../../src/automation/runner/trace/hooks';
import { runStepList } from '../../src/automation/runner/run_steps';
import { getRunnerConfig } from '../../src/config';
import type { StepArgsMap, StepName, StepUnion } from '../../src/automation/runner/steps/types';
import { RunnerPluginHost } from '../../src/automation/runner/hotreload/plugin_host';
import {PageSnapshotSessionStore} from '../../src/automation/snapshot/session';
import {SnapshotProjectionBaselineStore} from '../../src/automation/runner/session';

export const createStep = <TName extends StepName>(name: TName, args: StepArgsMap[TName]): StepUnion => ({
    id: crypto.randomUUID(),
    name,
    args,
} as StepUnion);

export const createTestPluginHost = async () => {
    const entryFile = path.resolve(process.cwd(), 'src/automation/runner/plugin_entry.ts');
    const host = new RunnerPluginHost(entryFile);
    await host.load();
    return host;
};

export const createStepExecutionHarness = async (page: Page, tabName = `test-${crypto.randomUUID()}`) => {
    const pageRegistry = createPageRegistry({
        tabNameKey: '__rpa_tab_name',
        getContext: async () => page.context(),
    });
    await pageRegistry.bindPage(page, tabName);
    const workspaceName = `ws-${crypto.randomUUID()}`;

    const pluginHost = await createTestPluginHost();
    const { registry: workspaceRegistry } = createWorkspaceHarness({ pageRegistry });
    const runtimeWorkspace = workspaceRegistry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    runtimeWorkspace.tabs.createTab({
        tabName,
    });
    runtimeWorkspace.tabs.bindPage(tabName, page);
    runtimeWorkspace.tabs.updateTab(tabName, { url: page.url(), title: await page.title() });
    runtimeWorkspace.tabs.setActiveTab(tabName);
    const runtime = createExecutionBindings({
        pageRegistry,
        traceHooks: createNoopHooks(),
        pluginHost,
    });
    runtime.bindPage({ workspaceName, tabName, page });

    const deps = {
        runtime,
        pageSession: new PageSnapshotSessionStore(),
        snapshotProjection: new SnapshotProjectionBaselineStore(),
        config: getRunnerConfig(),
        pluginHost,
        resolveWorkspace: (name: string) => {
            if (name !== workspaceName) {throw new Error(`workspace not found: ${name}`);}
            return runtimeWorkspace;
        },
        dispatchAction: async (action: any) => ({ ...action, id: crypto.randomUUID(), type: `${action.type}.result`, replyTo: action.id }),
    };

    const run = async (steps: StepUnion[]) => {
        const { pipe, checkpoint } = await runStepList(workspaceName, steps, deps, { stopOnError: true });
        const items = pipe.items as Array<{ stepId: string; ok: boolean; data?: unknown; error?: unknown }>;
        const results = items.map((item) => ({ stepId: item.stepId, ok: item.ok, data: item.data, error: item.error }));
        return { ok: checkpoint.status !== 'failed' && results.every((item) => item.ok), results };
    };

    return { run, workspaceName, tabName, pageRegistry, deps };
};
