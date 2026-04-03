import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseDomAndA11y } from '../executors/snapshot/fusion';
import { buildSpatialLayers, isNoiseLayer } from '../executors/snapshot/spatial';
import { detectRegions } from '../executors/snapshot/regions';
import { processRegion } from '../executors/snapshot/process_region';
import type { UnifiedNode } from '../executors/snapshot/types';

type RawFixture = {
    domTree: unknown;
    a11yTree: unknown;
};

const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/snapshot');
const ENTITY_TYPES = new Set([
    'form',
    'field_group',
    'table',
    'row',
    'card',
    'dialog',
    'list_item',
    'section',
]);

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const replaceRegion = (layer: UnifiedNode, target: UnifiedNode, next: UnifiedNode) => {
    const index = layer.children.findIndex((child) => child === target || child.id === target.id);
    if (index >= 0) {
        layer.children[index] = next;
        return;
    }
    for (const child of layer.children) {
        replaceRegion(child, target, next);
    }
};

const runStage23Pipeline = (raw: RawFixture): UnifiedNode => {
    const graph = fuseDomAndA11y(raw.domTree, raw.a11yTree);
    const layered = buildSpatialLayers(graph);
    const root: UnifiedNode = { id: 'virtual-root', role: 'root', children: [] };

    const [mainBody, ...overlays] = layered.root.children;
    if (mainBody) {
        root.children.push(mainBody);
    } else {
        root.children.push(layered.root);
    }

    for (const overlay of overlays) {
        if (isNoiseLayer(overlay)) continue;
        root.children.push(overlay);
    }

    for (const layer of root.children) {
        const regions = detectRegions(layer);
        for (const region of regions) {
            const processed = processRegion(region);
            if (!processed) continue;
            replaceRegion(layer, region, processed);
        }
    }

    return root;
};

test('snapshot stage2/3 acceptance on fixture dataset', () => {
    const fixtureFiles = fs
        .readdirSync(FIXTURE_DIR)
        .filter((name) => name.endsWith('.raw.json'))
        .sort();

    assert.ok(fixtureFiles.length >= 2, 'expected multiple raw fixtures for acceptance');

    let globalRowIndexCount = 0;
    let globalColumnIndexCount = 0;
    let globalColumnIdCount = 0;

    for (const file of fixtureFiles) {
        const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) as RawFixture;
        const root = runStage23Pipeline(raw);

        let nodeCount = 0;
        let entityCount = 0;
        let entityTypeCount = 0;
        let actionIntentCount = 0;
        let actionTargetCount = 0;
        let strongSemanticCount = 0;
        let rowIndexCount = 0;
        let columnIndexCount = 0;
        let columnIdCount = 0;

        walk(root, (node) => {
            nodeCount += 1;
            const attrs = node.attrs || {};
            if (attrs.entityId) entityCount += 1;
            if (attrs.entityType && ENTITY_TYPES.has(attrs.entityType)) entityTypeCount += 1;
            if (attrs.actionIntent) actionIntentCount += 1;
            if (attrs.actionTargetId) actionTargetCount += 1;
            if (attrs.strongSemantic === 'true') strongSemanticCount += 1;
            if (attrs.rowIndex) rowIndexCount += 1;
            if (attrs.columnIndex) columnIndexCount += 1;
            if (attrs.columnId) columnIdCount += 1;
        });

        assert.ok(nodeCount > 0, `${file}: expected nodes after stage2/3 pipeline`);
        assert.ok(entityCount > 0, `${file}: expected entity tagging from stage2`);
        assert.ok(entityTypeCount > 0, `${file}: expected entityType in supported set`);
        assert.ok(actionIntentCount > 0, `${file}: expected action intent attribution from stage3`);
        assert.ok(actionTargetCount > 0, `${file}: expected action target attribution from stage3`);
        assert.ok(strongSemanticCount > 0, `${file}: expected strong semantic markers`);

        globalRowIndexCount += rowIndexCount;
        globalColumnIndexCount += columnIndexCount;
        globalColumnIdCount += columnIdCount;
    }

    assert.ok(globalRowIndexCount > 0, 'expected row index annotation on table/list structures');
    assert.ok(globalColumnIndexCount > 0, 'expected column index annotation on table cells');
    assert.ok(globalColumnIdCount > 0, 'expected column id annotation on table cells');
});
