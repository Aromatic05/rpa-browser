import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Step } from '../../../src/runner/steps/types';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import { getRunnerConfig } from '../../../src/config';
import { executeBrowserClick } from '../../../src/runner/steps/executors/click';
import { executeBrowserFill } from '../../../src/runner/steps/executors/fill';
import { executeBrowserSelectOption } from '../../../src/runner/steps/executors/select_option';
import { executeBrowserPressKey, normalizeBrowserPressKey } from '../../../src/runner/steps/executors/press_key';
import { executeBrowserSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/snapshot';
import { executeBrowserMouse } from '../../../src/runner/steps/executors/mouse';
import { executeBrowserGetContent } from '../../../src/runner/steps/executors/get_content';
import { RunnerPluginHost } from '../../../src/runner/hotreload/plugin_host';
import { setNodeAttr } from '../../../src/runner/steps/executors/snapshot/core/runtime_store';

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

const createSemanticSnapshotPage = (initialUrl = 'https://example.test') => {
    const urlState = { current: initialUrl };
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

    const page = {
        url: () => urlState.current,
        context: () => ({
            newCDPSession: async () => fakeCdp,
        }),
    };

    return {
        page,
        setUrl: (nextUrl: string) => {
            urlState.current = nextUrl;
        },
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

test('click(resolve hint) resolves then scrolls/waits/clicks', async () => {
    const calls: string[] = [];
    const traceTools = {
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
        args: {},
        resolve: { hint: { raw: { selector: '#save' } } },
    };

    const result = await executeBrowserClick(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
        'trace.locator.waitForVisible',
        'trace.locator.scrollIntoView',
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
    assert.equal(calls[0].args.selector, 'form:nth-of-type(1) > input:nth-of-type(1)');
    assert.equal(calls[2].args.selector, 'form:nth-of-type(1) > input:nth-of-type(1)');
});

test('click(id) prefers structural selector for weak aria-label direct locator', async () => {
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
    const minus = { id: 'spin_minus', role: 'button', children: [] as any[] };
    const plus = { id: 'spin_plus', role: 'button', children: [] as any[] };
    root.children.push(form);
    form.children.push(minus, plus);

    setNodeAttr(form as any, 'tag', 'form');
    setNodeAttr(minus as any, 'tag', 'span');
    setNodeAttr(plus as any, 'tag', 'span');
    setNodeAttr(minus as any, 'aria-label', 'Increase Value');
    setNodeAttr(plus as any, 'aria-label', 'Increase Value');

    const deps = createDeps(traceTools, {}, {
        latestSnapshot: {
            root,
            nodeIndex: {
                root,
                form_1: form,
                spin_minus: minus,
                spin_plus: plus,
            },
            entityIndex: {
                entities: {},
                byNodeId: {},
            },
            locatorIndex: {
                spin_plus: {
                    origin: { primaryDomId: '333' },
                    direct: { kind: 'css', query: 'span[aria-label="Increase Value"]', source: 'aria-label' },
                    policy: {
                        preferDirect: true,
                        preferScopedSearch: false,
                        requireVisible: true,
                    },
                },
            },
        },
    });
    const step: Step<'browser.click'> = {
        id: 's2c_aria',
        name: 'browser.click',
        args: { id: 'spin_plus' },
    };

    const result = await executeBrowserClick(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].args.selector, 'span[aria-label="Increase Value"]');
    assert.equal(calls[2].args.selector, 'span[aria-label="Increase Value"]');
});

test('click(id) structural selector keeps unknown ancestors via nth-child segments', async () => {
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
    const body = { id: 'body', role: 'body', children: [] as any[] };
    const sectionA = { id: 'section_a', role: 'region', children: [] as any[] };
    const sectionB = { id: 'section_b', role: 'region', children: [] as any[] };
    const wrap1 = { id: 'wrap_1', role: 'region', children: [] as any[] };
    const wrap2 = { id: 'wrap_2', role: 'region', children: [] as any[] };
    const wrap3 = { id: 'wrap_3', role: 'region', children: [] as any[] };
    const sel1 = { id: 'select_1', role: 'combobox', children: [] as any[] };
    const sel2 = { id: 'select_2', role: 'combobox', children: [] as any[] };
    const sel3 = { id: 'select_3', role: 'combobox', children: [] as any[] };

    root.children.push(body);
    body.children.push(sectionA);
    sectionA.children.push(sectionB);
    sectionB.children.push(wrap1, wrap2, wrap3);
    wrap1.children.push(sel1);
    wrap2.children.push(sel2);
    wrap3.children.push(sel3);

    setNodeAttr(sectionA as any, 'tag', 'section');
    setNodeAttr(sectionB as any, 'tag', 'section');
    setNodeAttr(sel1 as any, 'tag', 'select');
    setNodeAttr(sel2 as any, 'tag', 'select');
    setNodeAttr(sel3 as any, 'tag', 'select');

    const deps = createDeps(traceTools, {}, {
        latestSnapshot: {
            root,
            nodeIndex: {
                root,
                body,
                section_a: sectionA,
                section_b: sectionB,
                wrap_1: wrap1,
                wrap_2: wrap2,
                wrap_3: wrap3,
                select_1: sel1,
                select_2: sel2,
                select_3: sel3,
            },
            entityIndex: {
                entities: {},
                byNodeId: {},
            },
            locatorIndex: {
                select_2: {
                    origin: { primaryDomId: 'sel2' },
                    policy: {
                        preferDirect: false,
                        preferScopedSearch: false,
                        requireVisible: true,
                        allowIndexDrift: true,
                        allowFuzzy: true,
                    },
                },
            },
        },
    });

    const step: Step<'browser.click'> = {
        id: 's2c_struct',
        name: 'browser.click',
        args: { id: 'select_2' },
    };

    const result = await executeBrowserClick(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    const selector = calls[0].args.selector;
    assert.equal(selector, 'body:nth-of-type(1) > section:nth-of-type(1) > section:nth-of-type(1) > select:nth-of-type(1)');
    assert.equal(calls[2].args.selector, selector);
});

test('click returns ERR_TIMEOUT when interaction exceeds timeout budget', async () => {
    const traceTools = {
        'trace.locator.scrollIntoView': async () => ({ ok: true }),
        'trace.locator.waitForVisible': async () => ({ ok: true }),
        'trace.locator.click': async () => new Promise(() => {}),
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.click'> = {
        id: 's2d',
        name: 'browser.click',
        args: { selector: '#save', timeout: 30 },
    };

    const startedAt = Date.now();
    const result = await executeBrowserClick(step, deps, 'ws1');
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.error?.code, 'ERR_TIMEOUT');
    }
    assert.ok(elapsedMs < 500, `expected timeout fallback quickly, got ${elapsedMs}ms`);
});

test('fill uses trace.locator.fill', async () => {
    const calls: string[] = [];
    const traceTools = {
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
        args: { selector: '#name', value: 'hello' },
    };

    const result = await executeBrowserFill(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['trace.locator.fill']);
});

test('select_option validates against selected labels after action', async () => {
    const calls: string[] = [];
    const traceTools = {
        'trace.locator.scrollIntoView': async () => ({ ok: true }),
        'trace.locator.waitForVisible': async () => ({ ok: true }),
        'trace.locator.selectOption': async () => {
            calls.push('trace.locator.selectOption');
            // Simulate UI library returning option values, not labels.
            return { ok: true, data: { selected: ['v-approve'] } };
        },
        'trace.locator.readSelectState': async () => ({
            ok: true,
            data: { selectedValues: ['v-approve'], selectedLabels: ['审批中'] },
        }),
    };
    const deps = createDeps(traceTools);
    const step: Step<'browser.select_option'> = {
        id: 's3-select',
        name: 'browser.select_option',
        args: { selector: '#status', values: ['审批中'] },
    };

    const result = await executeBrowserSelectOption(step, deps, 'ws1');
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['trace.locator.selectOption']);
});

test('press_key(target) focuses before keyboard.press', async () => {
    const calls: string[] = [];
    const traceTools = {
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
        args: { key: 'Enter', selector: '#email' },
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
    const fake = createSemanticSnapshotPage('https://example.test');
    const deps = createDeps({}, fake.page);
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

test('snapshot with invalid contain returns explicit not found error', async () => {
    const fake = createSemanticSnapshotPage('https://example.test');
    const deps = createDeps({}, fake.page);
    const step: Step<'browser.snapshot'> = {
        id: 's5b',
        name: 'browser.snapshot',
        args: { contain: 'missing-node-id' },
    };

    const result = await executeBrowserSnapshot(step, deps, 'ws1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_NOT_FOUND');
});

test('snapshot diff falls back to no_baseline then hits session baseline on next call', async () => {
    const fake = createSemanticSnapshotPage('https://example.test');
    const deps = createDeps({}, fake.page);

    const first: Step<'browser.snapshot'> = {
        id: 's5c-1',
        name: 'browser.snapshot',
        args: { diff: true },
    };
    const firstResult = await executeBrowserSnapshot(first, deps, 'ws1');
    assert.equal(firstResult.ok, true);
    const firstMeta = (firstResult.data as any)?.snapshotMeta;
    assert.equal(firstMeta?.mode, 'full');
    assert.equal(firstMeta?.diffSkipped, 'no_baseline');

    const second: Step<'browser.snapshot'> = {
        id: 's5c-2',
        name: 'browser.snapshot',
        args: { diff: true },
    };
    const secondResult = await executeBrowserSnapshot(second, deps, 'ws1');
    assert.equal(secondResult.ok, true);
    const secondMeta = (secondResult.data as any)?.snapshotMeta;
    assert.equal(secondMeta?.mode, 'diff');
    assert.equal(typeof secondMeta?.baseSnapshotId, 'string');
});

test('snapshot diff falls back with navigation when page identity changes', async () => {
    const fake = createSemanticSnapshotPage('https://example.test/a');
    const deps = createDeps({}, fake.page);

    const first: Step<'browser.snapshot'> = {
        id: 's5d-1',
        name: 'browser.snapshot',
        args: {},
    };
    const firstResult = await executeBrowserSnapshot(first, deps, 'ws1');
    assert.equal(firstResult.ok, true);

    fake.setUrl('https://example.test/b');

    const second: Step<'browser.snapshot'> = {
        id: 's5d-2',
        name: 'browser.snapshot',
        args: { diff: true },
    };
    const secondResult = await executeBrowserSnapshot(second, deps, 'ws1');
    assert.equal(secondResult.ok, true);
    const secondMeta = (secondResult.data as any)?.snapshotMeta;
    assert.equal(secondMeta?.mode, 'full');
    assert.equal(secondMeta?.diffSkipped, 'navigation');
});

test('not found returns error code and message', async () => {
    const traceTools = {};
    const deps = createDeps(traceTools);
    const step: Step<'browser.click'> = {
        id: 's6',
        name: 'browser.click',
        args: {},
        resolve: { hint: { raw: {} } },
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
        args: { coord: { x: 1, y: 2 }, selector: '#x' },
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
