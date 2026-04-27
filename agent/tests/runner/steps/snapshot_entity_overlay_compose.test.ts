import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/build_snapshot';
import { buildExternalIndexes } from '../../../src/runner/steps/executors/snapshot/indexes/external_indexes';
import { applySnapshotOverlay, buildFinalEntityViewFromSnapshot } from '../../../src/runner/steps/executors/snapshot/core/overlay';
import type { EntityIndex, SnapshotOverlays, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

const createBaseSnapshot = () => {
    const table: UnifiedNode = { id: 'table_1', role: 'table', name: 'Auto Table', children: [] };
    const panel: UnifiedNode = { id: 'panel_1', role: 'region', name: 'Panel', children: [] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [table, panel] };

    const entityIndex: EntityIndex = {
        entities: {
            ent_table: {
                id: 'ent_table',
                type: 'region',
                kind: 'table',
                nodeId: 'table_1',
                name: 'Auto Table',
                businessTag: 'auto.table',
            },
            ent_panel: {
                id: 'ent_panel',
                type: 'region',
                kind: 'panel',
                nodeId: 'panel_1',
                name: 'Panel',
            },
        },
        byNodeId: {
            table_1: [{ type: 'region', entityId: 'ent_table', role: 'container' }],
            panel_1: [{ type: 'region', entityId: 'ent_panel', role: 'container' }],
        },
    };
    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);

    return buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex: {},
        bboxIndex,
        attrIndex,
        contentStore,
        ruleEntityOverlay: {
            byRuleId: {},
            byEntityId: {
                ent_table: {
                    businessTag: 'rule.table.main',
                    businessName: 'Rule Table Main',
                    primaryKey: { fieldKey: 'orderNo', columns: ['订单编号'], source: 'annotation' },
                    columns: [{ fieldKey: 'orderNo', name: '订单编号', source: 'annotation' }],
                },
            },
            nodeHintsByNodeId: {},
        },
    });
};

test('final entity composition keeps priority manual > rule > auto', () => {
    const base = createBaseSnapshot();
    const overlays: SnapshotOverlays = {
        renamedNodes: {
            table_1: 'Manual Table Name',
        },
        addedEntities: [
            {
                nodeId: 'panel_1',
                kind: 'dialog',
                name: 'Manual Dialog',
                businessTag: 'manual.dialog',
            },
        ],
        deletedEntities: [],
    };

    const snapshot = applySnapshotOverlay(base, overlays);
    const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, overlays);
    const table = finalEntityView.byNodeId.table_1?.find((item) => item.kind === 'table');

    assert.equal(table?.name, 'Manual Table Name');
    assert.equal(table?.businessTag, 'rule.table.main');
    assert.equal(table?.primaryKey?.fieldKey, 'orderNo');
    assert.equal(finalEntityView.bindingIndex.columnsByEntity[table?.id || '']?.orderNo?.fieldKey, 'orderNo');
});

test('manual delete removes auto/rule entity and manual add remains in finalEntityView', () => {
    const base = createBaseSnapshot();
    const overlays: SnapshotOverlays = {
        renamedNodes: {},
        addedEntities: [
            {
                nodeId: 'panel_1',
                kind: 'dialog',
                name: 'Manual Dialog',
                businessTag: 'manual.dialog',
            },
        ],
        deletedEntities: [
            {
                nodeId: 'table_1',
            },
        ],
    };

    const snapshot = applySnapshotOverlay(base, overlays);
    const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, overlays);
    assert.equal((finalEntityView.byNodeId.table_1 || []).length, 0);
    assert.equal((finalEntityView.byNodeId.panel_1 || []).some((entity) => entity.kind === 'dialog'), true);
});
