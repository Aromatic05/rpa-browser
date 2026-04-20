import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseDomAndA11y } from '../../../src/runner/steps/executors/snapshot/stages/fusion';
import { buildSpatialLayers, isNoiseLayer } from '../../../src/runner/steps/executors/snapshot/stages/spatial';
import { detectRegions } from '../../../src/runner/steps/executors/snapshot/stages/regions';
import { processRegion } from '../../../src/runner/steps/executors/snapshot/pipeline/process_region';
import { generateSemanticSnapshotFromRaw } from '../../../src/runner/steps/executors/snapshot/pipeline/snapshot';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

type RawFixture = {
    domTree: unknown;
    a11yTree: unknown;
};

const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/snapshot');
const HAS_FIXTURE_DIR = fs.existsSync(FIXTURE_DIR);
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

const findById = (root: UnifiedNode, id: string): UnifiedNode | undefined => {
    let matched: UnifiedNode | undefined;
    walk(root, (node) => {
        if (!matched && node.id === id) {
            matched = node;
        }
    });
    return matched;
};

test('snapshot stage2/3 acceptance on fixture dataset', { skip: !HAS_FIXTURE_DIR }, () => {
    const fixtureFiles = fs
        .readdirSync(FIXTURE_DIR)
        .filter((name) => name.endsWith('.raw.json'))
        .sort();

    assert.ok(fixtureFiles.length >= 2, 'expected multiple raw fixtures for acceptance');

    let globalRowIndexCount = 0;
    let globalColumnIndexCount = 0;
    let globalColumnIdCount = 0;
    let globalHeaderSectionCount = 0;

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
        let headerSectionCount = 0;

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
            if (attrs.tableSection === 'header') headerSectionCount += 1;
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
        globalHeaderSectionCount += headerSectionCount;
    }

    assert.ok(globalRowIndexCount > 0, 'expected row index annotation on table/list structures');
    assert.ok(globalColumnIndexCount > 0, 'expected column index annotation on table cells');
    assert.ok(globalColumnIdCount > 0, 'expected column id annotation on table cells');
    assert.ok(globalHeaderSectionCount > 0, 'expected explicit header section annotation');
});

test('shop.yingdao table cells should keep stable roles and avoid guessed names', { skip: !HAS_FIXTURE_DIR }, () => {
    const raw = JSON.parse(
        fs.readFileSync(path.join(FIXTURE_DIR, 'shop.yingdao.table-list.raw.json'), 'utf8'),
    ) as RawFixture;
    const snapshot = generateSemanticSnapshotFromRaw(raw);
    const root = snapshot.root;

    const expectedNodes: Array<{ id: string; role: string }> = [
        {
            id: 'root.0.1.1.0.1.1.0.0.0.1.0.0.0.2.0.0.0.0.0.0.2.2.1',
            role: 'cell',
        },
        {
            id: 'root.0.1.1.0.1.1.0.0.0.1.0.0.0.2.0.0.0.0.0.0.2.4.1',
            role: 'cell',
        },
        {
            id: 'root.0.1.1.0.1.1.0.0.0.1.0.0.0.2.0.0.0.0.0.0.1.0.1',
            role: 'columnheader',
        },
        {
            id: 'root.0.1.1.0.1.1.0.0.0.1.0.0.0.2.0.0.0.0.0.0.1.0.3',
            role: 'columnheader',
        },
    ];

    for (const expected of expectedNodes) {
        const node = findById(root, expected.id);
        assert.ok(node, `expected snapshot node: ${expected.id}`);
        assert.equal(node?.role, expected.role, `${expected.id}: role mismatch`);
        assert.equal(node?.name, undefined, `${expected.id}: name should stay empty without precise a11y match`);
        assert.equal(node?.content, undefined, `${expected.id}: content should stay empty without precise a11y match`);
    }

    let pollutedCellCount = 0;
    walk(root, (node) => {
        const tag = node.attrs?.tag;
        if (tag !== 'td' && tag !== 'th') return;
        if (!node.name || !node.content) return;
        if (node.name !== node.content) {
            pollutedCellCount += 1;
        }
    });

    assert.equal(pollutedCellCount, 0, 'expected td/th to avoid name-content pollution');
});
