import test from 'node:test';
import assert from 'node:assert/strict';
import type { Step } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { getRunnerConfig } from '../../config';
import { executeBrowserClick } from '../executors/click';
import { executeBrowserFill } from '../executors/fill';
import { executeBrowserPressKey } from '../executors/press_key';
import { executeBrowserSnapshot } from '../executors/snapshot';
import { executeBrowserMouse } from '../executors/mouse';

const createDeps = (traceTools: any): RunStepsDeps => {
    const binding = {
        workspaceId: 'ws1',
        tabId: 'tab1',
        tabToken: 'token1',
        page: {} as any,
        traceTools,
        traceCtx: { cache: {} },
    };
    return {
        runtime: {
            ensureActivePage: async () => binding,
        } as any,
        config: getRunnerConfig(),
    };
};

test('click(coord) uses trace.mouse.action', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const traceTools = {
        'trace.mouse.action': async (args: any) => {
            calls.push({ name: 'trace.mouse.action', args });
            return { ok: true };
        },
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.click'> = {
        id: 's1',
        name: 'browser.click',
        args: { coord: { x: 10, y: 20 } },
    };

    const result = await executeBrowserClick(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args.action, 'down');
    assert.equal(calls[1].args.action, 'up');
});

test('click(target) resolves then scrolls/waits/clicks', async () => {
    const calls: string[] = [];
    const traceTools = {
        'trace.a11y.findByA11yHint': async () => {
            calls.push('trace.a11y.findByA11yHint');
            return { ok: true, data: [{ nodeId: 'n1' }] };
        },
        'trace.locator.scrollIntoView': async () => {
            calls.push('trace.locator.scrollIntoView');
            return { ok: true };
        },
        'trace.locator.waitForVisible': async () => {
            calls.push('trace.locator.waitForVisible');
            return { ok: true };
        },
        'trace.locator.click': async () => {
            calls.push('trace.locator.click');
            return { ok: true };
        },
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.click'> = {
        id: 's2',
        name: 'browser.click',
        args: { target: { a11yHint: { role: 'button', name: 'Save' } } },
    };

    const result = await executeBrowserClick(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
        'trace.a11y.findByA11yHint',
        'trace.locator.scrollIntoView',
        'trace.locator.waitForVisible',
        'trace.locator.click',
    ]);
});

test('fill uses trace.locator.fill', async () => {
    const calls: string[] = [];
    const traceTools = {
        'trace.a11y.findByA11yHint': async () => ({ ok: true, data: [{ nodeId: 'n2' }] }),
        'trace.locator.scrollIntoView': async () => ({ ok: true }),
        'trace.locator.waitForVisible': async () => ({ ok: true }),
        'trace.locator.focus': async () => ({ ok: true }),
        'trace.locator.fill': async () => {
            calls.push('trace.locator.fill');
            return { ok: true };
        },
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.fill'> = {
        id: 's3',
        name: 'browser.fill',
        args: { target: { a11yHint: { role: 'textbox', name: 'Name' } }, value: 'hello' },
    };

    const result = await executeBrowserFill(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['trace.locator.fill']);
});

test('press_key(target) focuses before keyboard.press', async () => {
    const calls: string[] = [];
    const traceTools = {
        'trace.a11y.findByA11yHint': async () => ({ ok: true, data: [{ nodeId: 'n3' }] }),
        'trace.locator.scrollIntoView': async () => ({ ok: true }),
        'trace.locator.waitForVisible': async () => ({ ok: true }),
        'trace.locator.focus': async () => {
            calls.push('trace.locator.focus');
            return { ok: true };
        },
        'trace.keyboard.press': async () => {
            calls.push('trace.keyboard.press');
            return { ok: true };
        },
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.press_key'> = {
        id: 's4',
        name: 'browser.press_key',
        args: { key: 'Enter', target: { a11yHint: { role: 'textbox', name: 'Email' } } },
    };

    const result = await executeBrowserPressKey(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['trace.locator.focus', 'trace.keyboard.press']);
});

test('snapshot returns snapshot_id and calls snapshotA11y when includeA11y', async () => {
    const calls: string[] = [];
    const traceTools = {
        'trace.page.getInfo': async () => ({ ok: true, data: { url: 'http://x', title: 'X' } }),
        'trace.page.snapshotA11y': async () => {
            calls.push('trace.page.snapshotA11y');
            return { ok: true, data: { snapshotId: 'snap1', a11y: '{}' } };
        },
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.snapshot'> = {
        id: 's5',
        name: 'browser.snapshot',
        args: { includeA11y: true },
    };

    const result = await executeBrowserSnapshot(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.equal((result.data as any).snapshot_id, 'snap1');
    assert.deepEqual(calls, ['trace.page.snapshotA11y']);
});

test('not found returns error code and message', async () => {
    const traceTools = {
        'trace.a11y.findByA11yHint': async () => ({ ok: true, data: [] }),
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.click'> = {
        id: 's6',
        name: 'browser.click',
        args: { target: { a11yHint: { role: 'button', name: 'Missing' } } },
    };

    const result = await executeBrowserClick(step, deps, 'ws1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_NOT_FOUND');
    assert.ok(result.error?.message);
});

test('click rejects coord with target', async () => {
    const traceTools = {
        'trace.mouse.action': async () => ({ ok: true }),
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.click'> = {
        id: 's7',
        name: 'browser.click',
        args: { coord: { x: 1, y: 2 }, target: { a11yHint: { role: 'button', name: 'X' } } },
    };

    const result = await executeBrowserClick(step, deps, 'ws1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_INTERNAL');
});

test('mouse wheel requires deltaY', async () => {
    const traceTools = {
        'trace.mouse.action': async () => ({ ok: true }),
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.mouse'> = {
        id: 's8',
        name: 'browser.mouse',
        args: { action: 'wheel', x: 10, y: 20 },
    };

    const result = await executeBrowserMouse(step, deps, 'ws1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_INTERNAL');
});
