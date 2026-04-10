import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSemanticSnapshotFromRaw } from '../executors/snapshot/pipeline/snapshot';
import type { GroupEntity, UnifiedNode } from '../executors/snapshot/core/types';

type RawFixture = {
    domTree: unknown;
    a11yTree: unknown;
};

const FIXTURE_FILE = path.resolve(
    process.cwd(),
    'tests/fixtures/snapshot/web_docs/002_element-plus_en_us_component_form_w1366_seed.raw.json',
);

const hasFixture = fs.existsSync(FIXTURE_FILE);

test('snapshot structure detection should avoid shell and code-like entities on element-plus form page', { skip: !hasFixture }, () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')) as RawFixture;
    const snapshot = generateSemanticSnapshotFromRaw({
        domTree: raw.domTree,
        a11yTree: raw.a11yTree,
    });

    const entities = Object.values(snapshot.entityIndex.entities);
    const disallowedRoles = new Set(['root', 'main', 'body']);
    const disallowedTags = new Set(['main', 'body', 'html']);
    const codeRoles = new Set(['code']);
    const codeTags = new Set(['code', 'pre']);

    for (const entity of entities) {
        if (entity.type === 'region') {
            const node = snapshot.nodeIndex[entity.nodeId];
            assert.ok(node, `region node missing: ${entity.nodeId}`);
            const role = (node?.role || '').trim().toLowerCase();
            const tag = (snapshot.attrIndex[entity.nodeId]?.tag || '').trim().toLowerCase();
            assert.equal(disallowedRoles.has(role), false, `region should not use shell node: ${entity.nodeId}`);
            assert.equal(disallowedTags.has(tag), false, `region should not use shell tag: ${entity.nodeId}`);
            assert.equal(codeRoles.has(role), false, `region should not use code role: ${entity.nodeId}`);
            assert.equal(codeTags.has(tag), false, `region should not use code tag: ${entity.nodeId}`);
            continue;
        }

        const container = snapshot.nodeIndex[entity.containerId];
        assert.ok(container, `group container missing: ${entity.containerId}`);
        const role = (container?.role || '').trim().toLowerCase();
        const tag = (snapshot.attrIndex[entity.containerId]?.tag || '').trim().toLowerCase();
        assert.equal(disallowedRoles.has(role), false, `group should not use shell node: ${entity.containerId}`);
        assert.equal(disallowedTags.has(tag), false, `group should not use shell tag: ${entity.containerId}`);
        assert.equal(codeRoles.has(role), false, `group should not use code role: ${entity.containerId}`);
        assert.equal(codeTags.has(tag), false, `group should not use code tag: ${entity.containerId}`);
    }
});

test('snapshot structure detection should avoid ancestor-duplicated groups on element-plus form page', { skip: !hasFixture }, () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')) as RawFixture;
    const snapshot = generateSemanticSnapshotFromRaw({
        domTree: raw.domTree,
        a11yTree: raw.a11yTree,
    });

    const groups = Object.values(snapshot.entityIndex.entities).filter(
        (entity): entity is GroupEntity => entity.type === 'group',
    );

    const parentById = new Map<string, string | null>();
    walkTree(snapshot.root, null, parentById);

    for (const ancestor of groups) {
        for (const descendant of groups) {
            if (ancestor.id === descendant.id) continue;
            if (!isAncestorNode(ancestor.containerId, descendant.containerId, parentById)) continue;
            const coverage = wrappedItemCoverage(descendant.itemIds, ancestor.itemIds, parentById);
            assert.ok(
                coverage < 0.9,
                `redundant ancestor group detected: ancestor=${ancestor.id} descendant=${descendant.id} coverage=${coverage.toFixed(3)}`,
            );
        }
    }
});

const walkTree = (node: UnifiedNode, parentId: string | null, parentById: Map<string, string | null>) => {
    parentById.set(node.id, parentId);
    for (const child of node.children) {
        walkTree(child, node.id, parentById);
    }
};

const isAncestorNode = (ancestorId: string, nodeId: string, parentById: Map<string, string | null>): boolean => {
    let cursor = parentById.get(nodeId) || null;
    while (cursor) {
        if (cursor === ancestorId) return true;
        cursor = parentById.get(cursor) || null;
    }
    return false;
};

const wrappedItemCoverage = (
    descendantItemIds: string[],
    ancestorItemIds: string[],
    parentById: Map<string, string | null>,
): number => {
    if (descendantItemIds.length === 0 || ancestorItemIds.length === 0) return 0;
    const ancestorSet = new Set(ancestorItemIds);
    let covered = 0;
    for (const itemId of descendantItemIds) {
        if (isSelfOrAncestorInSet(itemId, ancestorSet, parentById)) {
            covered += 1;
        }
    }
    return covered / descendantItemIds.length;
};

const isSelfOrAncestorInSet = (
    nodeId: string,
    ancestorSet: Set<string>,
    parentById: Map<string, string | null>,
): boolean => {
    let cursor: string | null = nodeId;
    while (cursor) {
        if (ancestorSet.has(cursor)) return true;
        cursor = parentById.get(cursor) || null;
    }
    return false;
};
