import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Step } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { getRunnerConfig } from '../../../config';
import { RunnerPluginHost } from '../../hotreload/plugin_host';
import { executeBrowserSnapshot } from '../executors/snapshot/pipeline/snapshot';
import { markSnapshotSessionDirty } from '../executors/snapshot/core/session_store';

const createDeps = (page: any, cache: Record<string, unknown> = {}): RunStepsDeps => {
    const binding = {
        workspaceId: 'ws-token',
        tabId: 'tab-token',
        tabToken: 'tab-token',
        page: page as any,
        traceTools: {},
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

const createDynamicSnapshotPage = (initialValue = '') => {
    const state = {
        value: initialValue,
    };
    const calls = {
        runtimeEvaluate: 0,
        loadStates: [] as Array<'domcontentloaded' | 'networkidle'>,
    };

    const fakeCdp = {
        send: async (method: string) => {
            if (method === 'DOMSnapshot.captureSnapshot') {
                return buildDomSnapshot(state.value);
            }
            if (method === 'Accessibility.enable') {
                return {};
            }
            if (method === 'Accessibility.getFullAXTree') {
                return {
                    nodes: [
                        { nodeId: 'ax0', role: { value: 'WebArea' }, backendDOMNodeId: 11, childIds: ['ax1'] },
                        { nodeId: 'ax1', role: { value: 'generic' }, backendDOMNodeId: 12, childIds: ['ax2'] },
                        { nodeId: 'ax2', role: { value: 'textbox' }, name: { value: '用户名' }, backendDOMNodeId: 13 },
                    ],
                };
            }
            return {};
        },
        detach: async () => {},
    };

    const page = {
        url: () => 'https://example.test/form',
        waitForLoadState: async (state: 'domcontentloaded' | 'networkidle') => {
            calls.loadStates.push(state);
        },
        context: () => ({
            newCDPSession: async () => fakeCdp,
        }),
        evaluate: async (fn: unknown) => {
            const marker = typeof fn === 'function' ? String(fn) : '';
            if (!marker.includes('[contenteditable]')) return undefined;
            calls.runtimeEvaluate += 1;
            return [
                {
                    pathKey: 'n0.0.0',
                    value: state.value,
                    focused: 'false',
                },
            ];
        },
    };

    return {
        page,
        calls,
        setValue: (nextValue: string) => {
            state.value = nextValue;
        },
    };
};

const createDynamicSelectPage = (initialSelected = '') => {
    const state = {
        selected: initialSelected,
    };
    const calls = {
        runtimeEvaluate: 0,
        loadStates: [] as Array<'domcontentloaded' | 'networkidle'>,
    };

    const fakeCdp = {
        send: async (method: string) => {
            if (method === 'DOMSnapshot.captureSnapshot') {
                return buildSelectDomSnapshot();
            }
            if (method === 'Accessibility.enable') {
                return {};
            }
            if (method === 'Accessibility.getFullAXTree') {
                return {
                    nodes: [
                        { nodeId: 'ax0', role: { value: 'WebArea' }, backendDOMNodeId: 31, childIds: ['ax1'] },
                        { nodeId: 'ax1', role: { value: 'generic' }, backendDOMNodeId: 32, childIds: ['ax2'] },
                        {
                            nodeId: 'ax2',
                            role: { value: 'combobox' },
                            name: { value: '城市' },
                            value: { value: state.selected },
                            backendDOMNodeId: 33,
                        },
                    ],
                };
            }
            return {};
        },
        detach: async () => {},
    };

    const page = {
        url: () => 'https://example.test/select',
        waitForLoadState: async (state: 'domcontentloaded' | 'networkidle') => {
            calls.loadStates.push(state);
        },
        context: () => ({
            newCDPSession: async () => fakeCdp,
        }),
        evaluate: async (fn: unknown) => {
            const marker = typeof fn === 'function' ? String(fn) : '';
            if (!marker.includes('[contenteditable]')) return undefined;
            calls.runtimeEvaluate += 1;
            return [
                {
                    pathKey: 'n0.0.0',
                    value: state.selected,
                    selected: state.selected,
                    focused: 'false',
                },
            ];
        },
    };

    return {
        page,
        calls,
        setSelected: (nextSelected: string) => {
            state.selected = nextSelected;
        },
    };
};

const buildDomSnapshot = (value: string) => {
    return {
        documents: [
            {
                nodes: {
                    parentIndex: [-1, 0, 1, 2],
                    nodeType: [9, 1, 1, 1],
                    nodeName: [0, 1, 2, 3],
                    nodeValue: [0, 0, 0, 0],
                    backendNodeId: [0, 11, 12, 13],
                    attributes: [[], [], [], [4, 5, 6, 7, 8, 9, 10, 11]],
                },
                layout: {
                    nodeIndex: [1, 2, 3],
                    bounds: [
                        [0, 0, 1280, 800],
                        [0, 0, 1280, 800],
                        [40, 80, 260, 32],
                    ],
                },
            },
        ],
        strings: [
            '#document',
            'HTML',
            'BODY',
            'INPUT',
            'id',
            'name-input',
            'type',
            'text',
            'value',
            value,
            'placeholder',
            '请输入用户名',
        ],
    };
};

const buildSelectDomSnapshot = () => {
    return {
        documents: [
            {
                nodes: {
                    parentIndex: [-1, 0, 1, 2],
                    nodeType: [9, 1, 1, 1],
                    nodeName: [0, 1, 2, 3],
                    nodeValue: [0, 0, 0, 0],
                    backendNodeId: [0, 31, 32, 33],
                    attributes: [[], [], [], [4, 5]],
                },
                layout: {
                    nodeIndex: [1, 2, 3],
                    bounds: [
                        [0, 0, 1280, 800],
                        [0, 0, 1280, 800],
                        [40, 80, 260, 32],
                    ],
                },
            },
        ],
        strings: ['#document', 'HTML', 'BODY', 'SELECT', 'id', 'city-select'],
    };
};

const hasProjectedContent = (node: any, expected: string): boolean => {
    if (!node || typeof node !== 'object') return false;
    if (node.content === expected) return true;
    const children = Array.isArray(node.children) ? node.children : [];
    return children.some((child) => hasProjectedContent(child, expected));
};

test('executeBrowserSnapshot diff surfaces textbox interaction as content token change', async () => {
    const fake = createDynamicSnapshotPage('');
    const deps = createDeps(fake.page);

    const first: Step<'browser.snapshot'> = {
        id: 'snap-1',
        name: 'browser.snapshot',
        args: { refresh: true },
    };
    const firstResult = await executeBrowserSnapshot(first, deps, 'ws-token');
    assert.equal(firstResult.ok, true);
    assert.equal(fake.calls.runtimeEvaluate, 0);

    fake.setValue('alice;bob');
    const binding = await deps.runtime.ensureActivePage('ws-token');
    markSnapshotSessionDirty(binding, 'step:browser.fill');

    const second: Step<'browser.snapshot'> = {
        id: 'snap-2',
        name: 'browser.snapshot',
        args: { refresh: true, diff: true },
    };
    const secondResult = await executeBrowserSnapshot(second, deps, 'ws-token');
    assert.equal(secondResult.ok, true);

    const data = secondResult.data as any;
    const meta = data?.snapshotMeta;
    assert.equal(meta?.mode, 'diff');
    assert.ok((meta?.changedNodeCount || 0) > 0);
    assert.equal(hasProjectedContent(data, 'value="alice,bob"'), true);
    assert.equal(fake.calls.runtimeEvaluate, 1);
});

test('executeBrowserSnapshot diff surfaces select interaction as content token change', async () => {
    const fake = createDynamicSelectPage('');
    const deps = createDeps(fake.page);

    const first: Step<'browser.snapshot'> = {
        id: 'snap-select-1',
        name: 'browser.snapshot',
        args: { refresh: true },
    };
    const firstResult = await executeBrowserSnapshot(first, deps, 'ws-token');
    assert.equal(firstResult.ok, true);
    assert.equal(fake.calls.runtimeEvaluate, 0);

    fake.setSelected('北京');
    const binding = await deps.runtime.ensureActivePage('ws-token');
    markSnapshotSessionDirty(binding, 'step:browser.select_option');

    const second: Step<'browser.snapshot'> = {
        id: 'snap-select-2',
        name: 'browser.snapshot',
        args: { refresh: true, diff: true },
    };
    const secondResult = await executeBrowserSnapshot(second, deps, 'ws-token');
    assert.equal(secondResult.ok, true);

    const data = secondResult.data as any;
    const meta = data?.snapshotMeta;
    assert.equal(meta?.mode, 'diff');
    assert.ok((meta?.changedNodeCount || 0) > 0);
    assert.equal(hasProjectedContent(data, 'selected="北京"'), true);
    assert.equal(fake.calls.runtimeEvaluate, 1);
});

test('runtime state sampling is skipped on non-dirty forced refresh', async () => {
    const fake = createDynamicSnapshotPage('');
    const deps = createDeps(fake.page);

    const first: Step<'browser.snapshot'> = {
        id: 'snap-force-1',
        name: 'browser.snapshot',
        args: { refresh: true },
    };
    const firstResult = await executeBrowserSnapshot(first, deps, 'ws-token');
    assert.equal(firstResult.ok, true);

    fake.setValue('alice');
    const second: Step<'browser.snapshot'> = {
        id: 'snap-force-2',
        name: 'browser.snapshot',
        args: { refresh: true, diff: true },
    };
    const secondResult = await executeBrowserSnapshot(second, deps, 'ws-token');
    assert.equal(secondResult.ok, true);
    assert.equal(fake.calls.runtimeEvaluate, 0);
});

test('interaction dirty refresh should not wait for networkidle', async () => {
    const fake = createDynamicSnapshotPage('');
    const deps = createDeps(fake.page);

    const first: Step<'browser.snapshot'> = {
        id: 'snap-interaction-wait-1',
        name: 'browser.snapshot',
        args: { refresh: true },
    };
    const firstResult = await executeBrowserSnapshot(first, deps, 'ws-token');
    assert.equal(firstResult.ok, true);

    fake.calls.loadStates.length = 0;
    const binding = await deps.runtime.ensureActivePage('ws-token');
    markSnapshotSessionDirty(binding, 'step:browser.click');

    const second: Step<'browser.snapshot'> = {
        id: 'snap-interaction-wait-2',
        name: 'browser.snapshot',
        args: { refresh: true },
    };
    const secondResult = await executeBrowserSnapshot(second, deps, 'ws-token');
    assert.equal(secondResult.ok, true);
    assert.deepEqual(fake.calls.loadStates, []);
});

test('navigation dirty refresh should keep domcontentloaded and networkidle waits', async () => {
    const fake = createDynamicSnapshotPage('');
    const deps = createDeps(fake.page);

    const first: Step<'browser.snapshot'> = {
        id: 'snap-navigation-wait-1',
        name: 'browser.snapshot',
        args: { refresh: true },
    };
    const firstResult = await executeBrowserSnapshot(first, deps, 'ws-token');
    assert.equal(firstResult.ok, true);

    fake.calls.loadStates.length = 0;
    const binding = await deps.runtime.ensureActivePage('ws-token');
    markSnapshotSessionDirty(binding, 'step:browser.goto');

    const second: Step<'browser.snapshot'> = {
        id: 'snap-navigation-wait-2',
        name: 'browser.snapshot',
        args: { refresh: true },
    };
    const secondResult = await executeBrowserSnapshot(second, deps, 'ws-token');
    assert.equal(secondResult.ok, true);
    assert.deepEqual(fake.calls.loadStates, ['domcontentloaded', 'networkidle']);
});
