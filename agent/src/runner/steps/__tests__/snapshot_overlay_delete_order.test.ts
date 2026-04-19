import test from 'node:test';
import assert from 'node:assert/strict';
import { applySnapshotOverlay } from '../executors/snapshot/core/overlay';
import type { SnapshotResult, SnapshotOverlays, UnifiedNode } from '../executors/snapshot/core/types';

const rootNode: UnifiedNode = {
    id: 'root',
    role: 'root',
    children: [
        {
            id: 'node_table',
            role: 'table',
            children: [],
            name: 'Orders',
        },
    ],
};

const baseSnapshot: SnapshotResult = {
    root: rootNode,
    nodeIndex: {
        root: rootNode,
        node_table: rootNode.children[0]!,
    },
    entityIndex: {
        entities: {
            ent_auto_table: {
                id: 'ent_auto_table',
                type: 'region',
                kind: 'table',
                nodeId: 'node_table',
                source: 'auto',
            },
        },
        byNodeId: {
            node_table: [
                {
                    type: 'region',
                    entityId: 'ent_auto_table',
                    role: 'container',
                },
            ],
        },
    },
    locatorIndex: {},
    bboxIndex: {},
    attrIndex: {},
    contentStore: {},
};

test('delete overlay should suppress both base and added entities on same node', () => {
    const overlays: SnapshotOverlays = {
        renamedNodes: {},
        addedEntities: [
            {
                nodeId: 'node_table',
                kind: 'panel',
                name: 'Manual Panel',
            },
        ],
        deletedEntities: [
            {
                nodeId: 'node_table',
            },
        ],
    };

    const finalSnapshot = applySnapshotOverlay(baseSnapshot, overlays);
    assert.equal(Object.keys(finalSnapshot.entityIndex.entities).length, 0);
    assert.equal(finalSnapshot.entityIndex.byNodeId.node_table, undefined);
});

