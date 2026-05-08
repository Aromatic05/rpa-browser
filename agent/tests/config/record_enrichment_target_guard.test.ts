import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichRecordedStepWithSnapshot } from '../../src/record/enrichment';
import type { SnapshotResult } from '../../src/runner/steps/executors/snapshot/core/types';
import { setNodeAttr } from '../../src/runner/steps/executors/snapshot/core/runtime_store';

const createInputSnapshot = (): SnapshotResult => {
    const root: any = { id: 'root', role: 'root', children: [] };
    const row1: any = { id: 'row_1', role: 'textbox', name: '', children: [] };
    const row2: any = { id: 'row_2', role: 'textbox', name: '', children: [] };
    const row3: any = { id: 'row_3', role: 'textbox', name: '', children: [] };
    root.children.push(row1, row2, row3);
    setNodeAttr(row1, 'tag', 'input');
    setNodeAttr(row2, 'tag', 'input');
    setNodeAttr(row3, 'tag', 'input');

    return {
        snapshotMeta: {
            mode: 'full',
            snapshotId: 'snap-record-1',
            pageIdentity: { workspaceName: 'ws', tabName: 'tab-1', url: 'https://example.test' },
        },
        root,
        nodeIndex: { root, row_1: row1, row_2: row2, row_3: row3 },
        locatorIndex: {
            row_1: { origin: { primaryDomId: '101' }, direct: { kind: 'css', query: 'table tr:nth-of-type(1) input', source: 'path' } },
            row_2: { origin: { primaryDomId: '102' }, direct: { kind: 'css', query: 'table tr:nth-of-type(2) input', source: 'path' } },
            row_3: { origin: { primaryDomId: '103' }, direct: { kind: 'css', query: 'table tr:nth-of-type(3) input', source: 'path' } },
        },
        attrIndex: {
            row_1: { tag: 'input', class: 'ant-input' },
            row_2: { tag: 'input', class: 'ant-input' },
            row_3: { tag: 'input', class: 'ant-input' },
        },
        bboxIndex: {},
        contentStore: {},
        entityIndex: { entities: {}, byNodeId: {} },
        textIndex: {},
        relationIndex: {},
        treeVersion: 1,
    } as any;
};

const createMockPage = (snapshot: SnapshotResult) => ({
    url: () => 'https://example.test',
}) as any;

test('record enrichment does not bind different row selectors to the same nodeId', async () => {
    const snapshot = createInputSnapshot();
    const cache = new Map<string, { snapshot: SnapshotResult; capturedAt: number; pageUrl: string }>();
    cache.set('k', { snapshot, capturedAt: Date.now(), pageUrl: 'https://example.test' });

    const a = await enrichRecordedStepWithSnapshot({
        event: { tabName: 'tab-1', ts: Date.now(), type: 'input', selector: 'table tr:nth-of-type(1) input', value: 'a' },
        page: createMockPage(snapshot),
        snapshotCache: cache,
        cacheKey: 'k',
    });
    const b = await enrichRecordedStepWithSnapshot({
        event: { tabName: 'tab-1', ts: Date.now(), type: 'input', selector: 'table tr:nth-of-type(2) input', value: 'b' },
        page: createMockPage(snapshot),
        snapshotCache: cache,
        cacheKey: 'k',
    });
    const c = await enrichRecordedStepWithSnapshot({
        event: { tabName: 'tab-1', ts: Date.now(), type: 'input', selector: 'table tr:nth-of-type(3) input', value: 'c' },
        page: createMockPage(snapshot),
        snapshotCache: cache,
        cacheKey: 'k',
    });

    assert.equal(a.target?.nodeId, 'row_1');
    assert.equal(b.target?.nodeId, 'row_2');
    assert.equal(c.target?.nodeId, 'row_3');
    assert.notEqual(a.target?.nodeId, b.target?.nodeId);
    assert.notEqual(b.target?.nodeId, c.target?.nodeId);
});

test('record enrichment target event without selector does not generate strong target', async () => {
    const out = await enrichRecordedStepWithSnapshot({
        event: { tabName: 'tab-1', ts: Date.now(), type: 'click' },
        page: undefined,
        snapshotCache: new Map(),
        cacheKey: 'k',
    });

    assert.equal(out.target?.nodeId, undefined);
    assert.equal(out.resolveHint?.locator?.direct?.query, undefined);
    assert.equal(out.resolveHint?.capture?.warnings?.includes('MISSING_SELECTOR_FOR_TARGET_EVENT'), true);
});

test('record enrichment does not write target nodeId and direct locator when selector mismatches snapshot node', async () => {
    const snapshot = createInputSnapshot();
    const cache = new Map<string, { snapshot: SnapshotResult; capturedAt: number; pageUrl: string }>();
    cache.set('k', { snapshot, capturedAt: Date.now(), pageUrl: 'https://example.test' });

    const out = await enrichRecordedStepWithSnapshot({
        event: { tabName: 'tab-1', ts: Date.now(), type: 'input', selector: 'table tr:nth-of-type(9) input', value: 'x' },
        page: createMockPage(snapshot),
        snapshotCache: cache,
        cacheKey: 'k',
    });

    assert.equal(out.target?.nodeId, undefined);
    assert.equal(out.resolveHint?.target?.nodeId, undefined);
    assert.equal(out.resolveHint?.locator?.direct?.query, undefined);
});
