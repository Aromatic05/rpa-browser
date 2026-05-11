import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/build_snapshot';
import { buildExternalIndexes } from '../../../src/runner/steps/executors/snapshot/indexes/external_indexes';
import { buildTableStructureModel } from '../../../src/runner/steps/executors/snapshot/core/table_model';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

test('table model should not count header row as data row', () => {
    const header1: UnifiedNode = { id: 'h1', role: 'columnheader', name: '订单编号', children: [] };
    const header2: UnifiedNode = { id: 'h2', role: 'columnheader', name: '采购人', children: [] };
    const headerRow: UnifiedNode = { id: 'header_row', role: 'row', children: [header1, header2] };

    const cell11: UnifiedNode = { id: 'c11', role: 'cell', name: 'SO-001', children: [] };
    const cell12: UnifiedNode = { id: 'c12', role: 'cell', name: 'Alice', children: [] };
    const row1: UnifiedNode = { id: 'row_1', role: 'row', children: [cell11, cell12] };

    const cell21: UnifiedNode = { id: 'c21', role: 'cell', name: 'SO-002', children: [] };
    const cell22: UnifiedNode = { id: 'c22', role: 'cell', name: 'Bob', children: [] };
    const row2: UnifiedNode = { id: 'row_2', role: 'row', children: [cell21, cell22] };

    const table: UnifiedNode = { id: 'table_1', role: 'table', children: [headerRow, row1, row2] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [table] };
    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    const snapshot = buildSnapshot({
        root,
        nodeIndex,
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {},
        bboxIndex,
        attrIndex,
        contentStore,
    });

    const model = buildTableStructureModel(snapshot, 'table_1');
    assert.equal(model?.rows.length, 2);
    assert.deepEqual(model?.rows.map((row) => row.nodeId), ['row_1', 'row_2']);
    assert.equal((model?.primaryKeyCandidates.length || 0) > 0, true);
});
