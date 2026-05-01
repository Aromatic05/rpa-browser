import test from 'node:test';
import assert from 'node:assert/strict';
import { executeBrowserCaptureResolve } from '../../../src/runner/steps/executors/capture_resolve';
import type { SnapshotResult, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';
import type { Step } from '../../../src/runner/steps/types';

const createNode = (id: string, role: string, name?: string): UnifiedNode => ({
    id,
    role,
    name,
    children: [],
});

const createSnapshot = (count = 1, repeatedText = 'Orders'): SnapshotResult => {
    const root = createNode('root', 'root');
    const nodeIndex: SnapshotResult['nodeIndex'] = { root };
    const locatorIndex: SnapshotResult['locatorIndex'] = {};
    const attrIndex: SnapshotResult['attrIndex'] = { root: { tag: 'body' } };
    const bboxIndex: SnapshotResult['bboxIndex'] = {};

    for (let index = 0; index < count; index += 1) {
        const node = createNode(`node_${index + 1}`, 'button', repeatedText);
        root.children.push(node);
        nodeIndex[node.id] = node;
        locatorIndex[node.id] = {
            origin: { primaryDomId: String(100 + index) },
            direct: { kind: 'css', query: `#target-${index + 1}`, source: 'capture-test' },
        };
        attrIndex[node.id] = { id: `target-${index + 1}`, tag: 'button' };
        bboxIndex[node.id] = { x: index * 10, y: 0, width: 20, height: 10 };
    }

    return {
        root,
        nodeIndex,
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex,
        bboxIndex,
        attrIndex,
        contentStore: {},
    };
};

const createDeps = (snapshot: SnapshotResult) =>
    ({
        runtime: {
            ensureActivePage: async () => ({
                workspaceName: 'ws-1',
                tabId: 'tab-1',
                tabName: 'tk-1',
                traceCtx: { cache: { latestSnapshot: snapshot } },
            }),
        },
        config: {} as any,
        pluginHost: {} as any,
    }) as any;

test('capture_resolve rejects missing target inputs', async () => {
    const step: Step<'browser.capture_resolve'> = {
        id: 'capture-empty',
        name: 'browser.capture_resolve',
        args: {},
    };

    const result = await executeBrowserCaptureResolve(step, createDeps(createSnapshot()), 'ws-1');
    assert.equal(result.ok, false);
    if (result.ok) {return;}
    assert.equal(result.error?.code, 'ERR_BAD_ARGS');
});

test('capture_resolve returns resolve draft for unique selector hit', async () => {
    const step: Step<'browser.capture_resolve'> = {
        id: 'capture-selector',
        name: 'browser.capture_resolve',
        args: { selector: '#target-1' },
    };

    const result = await executeBrowserCaptureResolve(step, createDeps(createSnapshot()), 'ws-1');
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    const data = result.data as any;
    assert.equal(data.resolve?.hint?.target?.nodeId, 'node_1');
    assert.equal(data.resolve?.hint?.locator?.direct?.query, '#target-1');
    assert.equal(data.confidence, 0.95);
});

test('capture_resolve returns ambiguous candidates for repeated text and uses default limit', async () => {
    const step: Step<'browser.capture_resolve'> = {
        id: 'capture-text',
        name: 'browser.capture_resolve',
        args: { text: 'Orders' },
    };

    const result = await executeBrowserCaptureResolve(step, createDeps(createSnapshot(6, 'Orders')), 'ws-1');
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    const data = result.data as any;
    assert.equal(data.candidates.length, 5);
    assert.equal(data.warnings.includes('AMBIGUOUS_TARGET'), true);
});

test('capture_resolve returns ERR_NOT_FOUND when no candidate matches', async () => {
    const step: Step<'browser.capture_resolve'> = {
        id: 'capture-none',
        name: 'browser.capture_resolve',
        args: { name: 'Missing target' },
    };

    const result = await executeBrowserCaptureResolve(step, createDeps(createSnapshot()), 'ws-1');
    assert.equal(result.ok, false);
    if (result.ok) {return;}
    assert.equal(result.error?.code, 'ERR_NOT_FOUND');
});

test('capture_resolve accepts limit up to 20 and rejects larger values', async () => {
    const withinLimit: Step<'browser.capture_resolve'> = {
        id: 'capture-limit-ok',
        name: 'browser.capture_resolve',
        args: { role: 'button', limit: 20 },
    };
    const overLimit: Step<'browser.capture_resolve'> = {
        id: 'capture-limit-bad',
        name: 'browser.capture_resolve',
        args: { role: 'button', limit: 21 },
    };

    const okResult = await executeBrowserCaptureResolve(withinLimit, createDeps(createSnapshot(25, 'Orders')), 'ws-1');
    assert.equal(okResult.ok, true);
    if (okResult.ok) {
        assert.equal(((okResult.data as any).candidates || []).length, 20);
    }

    const badResult = await executeBrowserCaptureResolve(overLimit, createDeps(createSnapshot(25, 'Orders')), 'ws-1');
    assert.equal(badResult.ok, false);
    if (badResult.ok) {return;}
    assert.equal(badResult.error?.code, 'ERR_BAD_ARGS');
});
