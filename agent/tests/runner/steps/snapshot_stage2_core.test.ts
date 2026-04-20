import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseDomAndA11y } from '../../../src/runner/steps/executors/snapshot/stages/fusion';
import { buildSpatialLayers } from '../../../src/runner/steps/executors/snapshot/stages/spatial';
import { detectRegions } from '../../../src/runner/steps/executors/snapshot/stages/regions';
import { processRegion } from '../../../src/runner/steps/executors/snapshot/pipeline/process_region';
import type { NodeGraph, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

type RawFixture = {
    domTree: unknown;
    a11yTree: unknown;
};

const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/snapshot');
const SUPPORTED_ENTITY_TYPES = new Set([
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

test('buildSpatialLayers should keep main body first and lift overlays', () => {
    const graph: NodeGraph = {
        root: {
            id: 'root',
            role: 'document',
            children: [
                {
                    id: 'main',
                    role: 'main',
                    children: [],
                    attrs: { class: 'content' },
                },
                {
                    id: 'dialog-overlay',
                    role: 'dialog',
                    children: [],
                },
                {
                    id: 'fixed-overlay',
                    role: 'generic',
                    attrs: { position: 'fixed', zIndex: '80' },
                    children: [],
                },
            ],
        },
    };

    const layered = buildSpatialLayers(graph);
    assert.equal(layered.root.children.length, 3);
    assert.equal(layered.root.children[0]?.id, 'main');
    assert.equal(layered.root.children[1]?.id, 'dialog-overlay');
    assert.equal(layered.root.children[2]?.id, 'fixed-overlay');
});

test('detectBusinessEntities should tag entityId/entityType on fixture dataset', () => {
    const fixtureFiles = fs
        .readdirSync(FIXTURE_DIR)
        .filter((name) => name.endsWith('.raw.json'))
        .sort();

    assert.ok(fixtureFiles.length >= 2, 'expected multiple raw fixtures for stage2 validation');

    for (const file of fixtureFiles) {
        const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) as RawFixture;
        const graph = fuseDomAndA11y(raw.domTree, raw.a11yTree);
        const layered = buildSpatialLayers(graph);
        const root: UnifiedNode = { id: 'virtual-root', role: 'root', children: [...layered.root.children] };

        for (const layer of root.children) {
            const regions = detectRegions(layer);
            for (const region of regions) {
                const processed = processRegion(region);
                if (!processed) continue;
                replaceRegion(layer, region, processed);
            }
        }

        let entityCount = 0;
        let allowedTypeCount = 0;
        let entityIdCount = 0;
        walk(root, (node) => {
            const attrs = node.attrs || {};
            if (!attrs.entityType) return;
            entityCount += 1;
            if (SUPPORTED_ENTITY_TYPES.has(attrs.entityType)) {
                allowedTypeCount += 1;
            }
            if (attrs.entityId) {
                entityIdCount += 1;
            }
        });

        assert.ok(entityCount > 0, `${file}: expected entity tagging from detectBusinessEntities`);
        assert.equal(
            allowedTypeCount,
            entityCount,
            `${file}: entityType should stay in stage2 supported set`,
        );
        assert.equal(entityIdCount, entityCount, `${file}: every entityType node should have entityId`);
    }
});
