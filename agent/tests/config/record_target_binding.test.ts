import test from 'node:test';
import assert from 'node:assert/strict';
import type { SnapshotResult, UnifiedNode } from '../../src/runner/steps/executors/snapshot/core/types';
import {
    findControlByNodeId,
    readControlOptionByNodeId,
    readOptionRecordedValue,
    readSelectedValuesFromControl,
    resolveRecordTargetBinding,
    setRecordTargetSnapshotResolverForTest,
} from '../../src/record/pipeline/target_binding';

const node = (id: string, controlRef?: string): UnifiedNode => ({
    id,
    role: 'generic',
    children: [],
    ...(controlRef ? { control: { kind: 'x', ref: controlRef } } : {}),
});

const makeSnapshot = (): SnapshotResult => ({
    root: node('root'),
    nodeIndex: {
        root: node('root'),
        n1: node('n1'),
        opt1: node('opt1'),
    },
    entityIndex: { entities: {}, byNodeId: {} },
    locatorIndex: {
        n1: { origin: { primaryDomId: 'd1' }, direct: { kind: 'css', query: '#a', source: 'test' } },
    },
    bboxIndex: {},
    attrIndex: { n1: {}, opt1: {} },
    contentStore: {},
    controlIndex: {
        ref1: {
            id: 'c1',
            kind: 'checkbox_group',
            owner: 'browser.select_option',
            capabilities: ['select_option'],
            source: 'test',
            confidence: 1,
            rootNodeId: 'n1',
            optionNodeIds: ['opt1'],
            state: { expanded: false, multiple: true, disabled: false, readonly: false, focused: false },
            data: { options: [
                { nodeId: 'opt1', value: 'A', selected: true },
                { nodeId: 'opt2', label: 'B', selected: true },
            ] },
        },
    },
});

test('findControlByNodeId resolves via optionNodeIds', () => {
    const snapshot = makeSnapshot();
    const found = findControlByNodeId(snapshot, 'opt1');
    assert.equal(found?.controlRef, 'ref1');
    assert.equal(found?.componentKind, 'checkbox_group');
});

test('option value reading and selected values keep option order', () => {
    const snapshot = makeSnapshot();
    const comp = snapshot.controlIndex.ref1;
    const option = readControlOptionByNodeId(comp, 'opt1');
    assert.equal(readOptionRecordedValue(option || {}), 'A');
    assert.deepEqual(readSelectedValuesFromControl(comp), ['A', 'B']);
});

test('resolveRecordTargetBinding unique match returns binding', async () => {
    const snapshot = makeSnapshot();
    setRecordTargetSnapshotResolverForTest(async () => snapshot);
    const binding = await resolveRecordTargetBinding({
        event: { tabName: 'tab-a', ts: 1, type: 'click', selector: '#a' },
        snapshotCache: new Map(),
        cacheKey: 'k',
    });
    assert.equal(binding?.targetNodeId, 'n1');
    assert.equal(binding?.componentKind, 'checkbox_group');
    setRecordTargetSnapshotResolverForTest(null);
});

test('resolveRecordTargetBinding ambiguous selector returns undefined', async () => {
    const snapshot = makeSnapshot();
    snapshot.locatorIndex.n2 = snapshot.locatorIndex.n1;
    snapshot.nodeIndex.n2 = node('n2');
    setRecordTargetSnapshotResolverForTest(async () => snapshot);
    const binding = await resolveRecordTargetBinding({
        event: { tabName: 'tab-a', ts: 1, type: 'click', selector: '#a' },
        snapshotCache: new Map(),
        cacheKey: 'k',
    });
    assert.equal(binding, undefined);
    setRecordTargetSnapshotResolverForTest(null);
});
