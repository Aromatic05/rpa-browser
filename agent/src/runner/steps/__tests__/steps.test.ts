import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Step } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { getRunnerConfig } from '../../../config';
import { executeBrowserClick } from '../executors/click';
import { executeBrowserFill } from '../executors/fill';
import { executeBrowserPressKey, normalizeBrowserPressKey } from '../executors/press_key';
import { executeBrowserSnapshot } from '../executors/snapshot';
import { executeBrowserMouse } from '../executors/mouse';
import { executeBrowserGetContent } from '../executors/get_content';
import { RunnerPluginHost } from '../../hotreload/plugin_host';
import { setNodeAttr } from '../executors/snapshot/core/runtime_store';

const createDeps = (traceTools: any, page: any = {}, cache: Record<string, unknown> = {}): RunStepsDeps => {
    const binding = {
        workspaceId: 'ws1',
        tabId: 'tab1',
        tabToken: 'token1',
        page: page as any,
        traceTools,
        traceCtx: { cache: { ...cache } },
    };
    return {
        runtime: {
            ensureActivePage: async () => binding,
        } as any,
        config: getRunnerConfig(),
        pluginHost: new RunnerPluginHost(path.resolve(process.cwd(), 'src/runner/plugin_entry.ts')),
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

test('click(id) resolves via snapshot locator index and uses selector path', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const traceTools = {
        'trace.locator.scrollIntoView': async (args: any) => {
            calls.push({ name: 'trace.locator.scrollIntoView', args });
            return { ok: true };
        },
        'trace.locator.waitForVisible': async (args: any) => {
            calls.push({ name: 'trace.locator.waitForVisible', args });
            return { ok: true };
        },
        'trace.locator.click': async (args: any) => {
            calls.push({ name: 'trace.locator.click', args });
            return { ok: true };
        },
    };
    const deps = createDeps(traceTools, {}, {
        latestSnapshot: {
            locatorIndex: {
                node_btn: {
                    origin: { primaryDomId: '42' },
                    direct: { kind: 'css', query: '#submit-btn', source: 'id' },
                },
            },
        },
    });
    const step: Step<'browser.click'> = {
        id: 's2b',
        name: 'browser.click',
        args: { id: 'node_btn' },
    };

    const result = await executeBrowserClick(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].args.selector, '#submit-btn');
    assert.equal(calls[2].args.selector, '#submit-btn');
});

test('click(id) falls back to structural selector when direct locator is missing', async () => {
    const calls: Array<{ name: string; args: any }> = [];
    const traceTools = {
        'trace.locator.scrollIntoView': async (args: any) => {
            calls.push({ name: 'trace.locator.scrollIntoView', args });
            return { ok: true };
        },
        'trace.locator.waitForVisible': async (args: any) => {
            calls.push({ name: 'trace.locator.waitForVisible', args });
            return { ok: true };
        },
        'trace.locator.click': async (args: any) => {
            calls.push({ name: 'trace.locator.click', args });
            return { ok: true };
        },
    };

    const root = { id: 'root', role: 'root', children: [] as any[] };
    const form = { id: 'form_1', role: 'form', children: [] as any[] };
    const textbox = { id: 'textbox_1', role: 'textbox', children: [] as any[] };
    root.children.push(form);
    form.children.push(textbox);
    setNodeAttr(form as any, 'tag', 'form');
    setNodeAttr(textbox as any, 'tag', 'input');

    const deps = createDeps(traceTools, {}, {
        latestSnapshot: {
            root,
            nodeIndex: {
                root,
                form_1: form,
                textbox_1: textbox,
            },
            entityIndex: {
                entities: {
                    ent_region_form_1: {
                        id: 'ent_region_form_1',
                        type: 'region',
                        kind: 'form',
                        nodeId: 'form_1',
                    },
                },
                byNodeId: {},
            },
            locatorIndex: {
                textbox_1: {
                    origin: { primaryDomId: '222' },
                    scope: { id: 'ent_region_form_1', kind: 'form' },
                    policy: {
                        preferDirect: false,
                        preferScopedSearch: true,
                        requireVisible: true,
                        allowIndexDrift: true,
                        allowFuzzy: true,
                    },
                },
            },
        },
    });
    const step: Step<'browser.click'> = {
        id: 's2c',
        name: 'browser.click',
        args: { id: 'textbox_1' },
    };

    const result = await executeBrowserClick(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].args.selector, 'form:nth-of-type(1) input:nth-of-type(1):visible');
    assert.equal(calls[2].args.selector, 'form:nth-of-type(1) input:nth-of-type(1):visible');
});

test('click returns ERR_TIMEOUT when interaction exceeds timeout budget', async () => {
    const traceTools = {
        'trace.a11y.findByA11yHint': async () => ({ ok: true, data: [{ nodeId: 'n1' }] }),
        'trace.locator.scrollIntoView': async () => ({ ok: true }),
        'trace.locator.waitForVisible': async () => ({ ok: true }),
        'trace.locator.click': async () => new Promise(() => {}),
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.click'> = {
        id: 's2d',
        name: 'browser.click',
        args: { target: { a11yHint: { role: 'button', name: 'Save' } }, timeout: 30 },
    };

    const startedAt = Date.now();
    const result = await executeBrowserClick(step, deps, 'ws1');
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.error.code, 'ERR_TIMEOUT');
    }
    assert.ok(elapsedMs < 500, `expected timeout fallback quickly, got ${elapsedMs}ms`);
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

test('press_key normalizes primary shortcut by platform', () => {
    assert.equal(normalizeBrowserPressKey('ctrl+a', 'darwin'), 'Meta+A');
    assert.equal(normalizeBrowserPressKey('Control+Shift+a', 'darwin'), 'Meta+Shift+A');
    assert.equal(normalizeBrowserPressKey('CmdOrCtrl+a', 'linux'), 'Control+A');
    assert.equal(normalizeBrowserPressKey('CmdOrCtrl+a', 'darwin'), 'Meta+A');
});

test('snapshot returns UnifiedNode root and keeps latest snapshot in trace cache', async () => {
    const fakeCdp = {
        send: async (method: string) => {
            if (method === 'DOMSnapshot.captureSnapshot') {
                return {
                    documents: [
                        {
                            nodes: {
                                parentIndex: [-1, 0, 1, 2, 3],
                                nodeType: [9, 1, 1, 1, 3],
                                nodeName: [0, 1, 2, 3, 0],
                                nodeValue: [0, 0, 0, 0, 4],
                                backendNodeId: [0, 11, 12, 13, 0],
                                attributes: [[], [], [], [5, 6], []],
                            },
                            layout: {
                                nodeIndex: [1, 2, 3],
                                bounds: [
                                    [0, 0, 1280, 800],
                                    [0, 0, 1280, 800],
                                    [24, 40, 120, 30],
                                ],
                            },
                        },
                    ],
                    strings: ['#document', 'HTML', 'BODY', 'BUTTON', 'Click me', 'id', 'submit-btn'],
                };
            }
            if (method === 'Accessibility.enable') {
                return {};
            }
            if (method === 'Accessibility.getFullAXTree') {
                return {
                    nodes: [
                        { nodeId: 'ax0', role: { value: 'WebArea' }, backendDOMNodeId: 11, childIds: ['ax1'] },
                        { nodeId: 'ax1', role: { value: 'generic' }, backendDOMNodeId: 12, childIds: ['ax2'] },
                        { nodeId: 'ax2', role: { value: 'button' }, name: { value: 'Click me' }, backendDOMNodeId: 13 },
                    ],
                };
            }
            return {};
        },
        detach: async () => {},
    };
    const fakePage = {
        url: () => 'https://example.test',
        context: () => ({
            newCDPSession: async () => fakeCdp,
        }),
    };
    const deps = createDeps({}, fakePage);
    const step: Step<'browser.snapshot'> = {
        id: 's5',
        name: 'browser.snapshot',
        args: { includeA11y: true },
    };

    const result = await executeBrowserSnapshot(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.equal((result.data as any)?.role, 'root');
    assert.ok(Array.isArray((result.data as any)?.children));
    assert.equal((result.data as any)?.snapshot_id, undefined);
    assert.equal((result.data as any)?.a11y, undefined);
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

test('mouse click forwards action without deltaY', async () => {
    const calls: any[] = [];
    const traceTools = {
        'trace.mouse.action': async (args: any) => {
            calls.push(args);
            return { ok: true };
        },
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.mouse'> = {
        id: 's8b',
        name: 'browser.mouse',
        args: { action: 'click', x: 10, y: 20, button: 'left' },
    };

    const result = await executeBrowserMouse(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'click');
});

test('get_content returns resolved content text by ref', async () => {
    const traceTools = {
        'trace.page.getContent': async (args: any) => ({ ok: true, data: { ref: args.ref, content: 'hello world' } }),
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.get_content'> = {
        id: 's9',
        name: 'browser.get_content',
        args: { ref: 'content_node_1' },
    };

    const result = await executeBrowserGetContent(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.equal((result.data as any)?.ref, 'content_node_1');
    assert.equal((result.data as any)?.content, 'hello world');
});
