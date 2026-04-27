/**
 * headed_run_steps_demo：用于人工验收 runSteps 的有头演示。
 *
 * 流程：
 * - 启动可见浏览器
 * - goto -> snapshot -> click -> fill
 * - 输出 step/trace 日志
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createPageRegistry } from '../../runtime/page_registry';
import { createRuntimeRegistry } from '../../runtime/runtime_registry';
import { createConsoleStepSink, runStepList } from '../run_steps';
import { MemorySink } from '../trace/sink';
import { createLoggingHooks } from '../trace/hooks';
import { getRunnerConfig } from '../../config';
import { RunnerPluginHost } from '../hotreload/plugin_host';

const fixtureUrl = () =>
    pathToFileURL(
        path.resolve(process.cwd(), 'tests/fixtures/run_steps_fixture_a.html'),
    ).toString();

const findNodeId = (tree: any, role: string, name: string): string | null => {
    if (!tree) {return null;}
    if (tree.role === role && tree.name === name) {return tree.id;}
    for (const child of tree.children || []) {
        const found = findNodeId(child, role, name);
        if (found) {return found;}
    }
    return null;
};

const run = async () => {
    const browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
        getContext: async () => context,
    });
    const pluginHost = new RunnerPluginHost(path.resolve(process.cwd(), '.runner-dist/plugin.mjs'));
    await pluginHost.load();
    const traceSink = new MemorySink();
    const runtimeRegistry = createRuntimeRegistry({
        pageRegistry,
        traceSinks: [traceSink],
        traceHooks: createLoggingHooks(),
        pluginHost,
    });
    const workspace = await pageRegistry.createWorkspace();

    const firstResp = await runStepList(
        workspace.workspaceId,
        [
            {
                id: 'demo-goto',
                name: 'browser.goto',
                args: { url: fixtureUrl() },
                meta: { source: 'script' },
            },
            {
                id: 'demo-snap',
                name: 'browser.snapshot',
                args: { includeA11y: true },
                meta: { source: 'script' },
            },
        ],
        { runtime: runtimeRegistry, stepSinks: [createConsoleStepSink('[step]')], config: getRunnerConfig(), pluginHost },
        { stopOnError: true },
    );
    if (firstResp.checkpoint.status === 'failed') {
        throw new Error('demo initial run failed');
    }
    const first = { ok: true, results: firstResp.pipe.items as any[] };

    const snap = first.results.find((r) => r.stepId === 'demo-snap');
    const tree = JSON.parse((snap?.data)?.a11y || '{}');
    const buttonId = findNodeId(tree, 'button', 'Action A');
    const inputId = findNodeId(tree, 'textbox', 'Name A');
    if (!buttonId || !inputId) {
        console.error('Unable to find a11y nodes for demo.');
        await browser.close();
        return;
    }

    const secondResp = await runStepList(
        workspace.workspaceId,
        [
            {
                id: 'demo-click',
                name: 'browser.click',
                args: {},
                resolve: { hint: { target: { nodeId: buttonId } } },
                meta: { source: 'script' },
            },
            {
                id: 'demo-fill',
                name: 'browser.fill',
                args: { value: 'headed demo' },
                resolve: { hint: { target: { nodeId: inputId } } },
                meta: { source: 'script' },
            },
        ],
        { runtime: runtimeRegistry, stepSinks: [createConsoleStepSink('[step]')], config: getRunnerConfig(), pluginHost },
        { stopOnError: true },
    );
    if (secondResp.checkpoint.status === 'failed') {
        throw new Error('demo action run failed');
    }

    console.log('Demo finished, please verify UI changes in the visible browser window.');
    await browser.close();
};

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
