import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Step } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { getRunnerConfig } from '../../../config';
import { RunnerPluginHost } from '../../hotreload/plugin_host';
import { executeBrowserSnapshot } from '../executors/snapshot';

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
        context: () => ({
            newCDPSession: async () => fakeCdp,
        }),
    };

    return {
        page,
        setValue: (nextValue: string) => {
            state.value = nextValue;
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

    fake.setValue('alice;bob');

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
});
