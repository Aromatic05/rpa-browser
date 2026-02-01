/**
 * runSteps 集成测试（无头）：
 * - 两个 workspace 各自执行 goto + snapshot + click + fill
 * - 断言互不干扰、日志与 trace 事件包含 workspace 标签
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createPageRegistry } from '../../runtime/page_registry';
import { createRuntimeRegistry } from '../../runtime/runtime_registry';
import { runSteps, MemoryStepSink } from '../run_steps';
import { MemorySink } from '../trace/sink';
import { createNoopHooks } from '../trace/hooks';
import { getRunnerConfig } from '../config';

const fixtureUrl = (name: string) =>
    pathToFileURL(
        path.resolve(process.cwd(), 'src/runner/demo/fixtures', name),
    ).toString();

const findNodeId = (tree: any, role: string, name: string): string | null => {
    if (!tree) return null;
    if (tree.role === role && tree.name === name) return tree.id;
    for (const child of tree.children || []) {
        const found = findNodeId(child, role, name);
        if (found) return found;
    }
    return null;
};

test('runSteps isolates workspaces and emits step/trace events', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
        getContext: async () => context,
    });

    const traceSink = new MemorySink();
    const runtimeRegistry = createRuntimeRegistry({
        pageRegistry,
        traceSinks: [traceSink],
        traceHooks: createNoopHooks(),
    });
    const stepSink = new MemoryStepSink();

    const ws1 = await pageRegistry.createWorkspace();
    const ws2 = await pageRegistry.createWorkspace();

    const steps1 = await runSteps(
        {
            workspaceId: ws1.workspaceId,
            steps: [
                { id: 'ws1-goto', name: 'browser.goto', args: { url: fixtureUrl('run_steps_fixture_a.html') }, meta: { source: 'script' } },
                { id: 'ws1-snap', name: 'browser.snapshot', args: { includeA11y: true }, meta: { source: 'script' } },
            ],
        },
        { runtime: runtimeRegistry, stepSinks: [stepSink], config: getRunnerConfig() },
    );
    assert.equal(steps1.ok, true);
    const snap1 = steps1.results.find((r) => r.stepId === 'ws1-snap');
    assert.ok(snap1?.ok);
    const tree1 = JSON.parse((snap1?.data as any)?.a11y || '{}');
    const btn1 = findNodeId(tree1, 'button', 'Action A');
    const input1 = findNodeId(tree1, 'textbox', 'Name A');
    assert.ok(btn1);
    assert.ok(input1);

    const steps1b = await runSteps(
        {
            workspaceId: ws1.workspaceId,
            steps: [
                { id: 'ws1-click', name: 'browser.click', args: { a11yNodeId: btn1! }, meta: { source: 'script' } },
                { id: 'ws1-fill', name: 'browser.fill', args: { a11yNodeId: input1!, value: 'hello-a' }, meta: { source: 'script' } },
            ],
        },
        { runtime: runtimeRegistry, stepSinks: [stepSink], config: getRunnerConfig() },
    );
    assert.equal(steps1b.ok, true);

    const steps2 = await runSteps(
        {
            workspaceId: ws2.workspaceId,
            steps: [
                { id: 'ws2-goto', name: 'browser.goto', args: { url: fixtureUrl('run_steps_fixture_b.html') }, meta: { source: 'script' } },
                { id: 'ws2-snap', name: 'browser.snapshot', args: { includeA11y: true }, meta: { source: 'script' } },
            ],
        },
        { runtime: runtimeRegistry, stepSinks: [stepSink], config: getRunnerConfig() },
    );
    assert.equal(steps2.ok, true);
    const snap2 = steps2.results.find((r) => r.stepId === 'ws2-snap');
    const tree2 = JSON.parse((snap2?.data as any)?.a11y || '{}');
    const btn2 = findNodeId(tree2, 'button', 'Action B');
    const input2 = findNodeId(tree2, 'textbox', 'Name B');
    assert.ok(btn2);
    assert.ok(input2);

    const steps2b = await runSteps(
        {
            workspaceId: ws2.workspaceId,
            steps: [
                { id: 'ws2-click', name: 'browser.click', args: { a11yNodeId: btn2! }, meta: { source: 'script' } },
                { id: 'ws2-fill', name: 'browser.fill', args: { a11yNodeId: input2!, value: 'hello-b' }, meta: { source: 'script' } },
            ],
        },
        { runtime: runtimeRegistry, stepSinks: [stepSink], config: getRunnerConfig() },
    );
    assert.equal(steps2b.ok, true);

    const binding1 = await runtimeRegistry.ensureActivePage(ws1.workspaceId);
    const binding2 = await runtimeRegistry.ensureActivePage(ws2.workspaceId);
    assert.ok(binding1.page.url().includes('run_steps_fixture_a.html'));
    assert.ok(binding2.page.url().includes('run_steps_fixture_b.html'));

    assert.ok(stepSink.events.length > 0);
    const traceEvents = traceSink.getEvents();
    assert.ok(traceEvents.length > 0);
    const hasTaggedTrace = traceEvents.some(
        (event) => event.type === 'op.end' && event.tags?.workspaceId,
    );
    assert.ok(hasTaggedTrace);

    await browser.close();
});
