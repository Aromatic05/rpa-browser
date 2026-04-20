import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSemanticSnapshotFromRaw } from '../../../src/runner/steps/executors/snapshot/pipeline/snapshot';
import type { EntityIndex, GroupEntity, SnapshotResult, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

type RawFixture = {
    domTree: unknown;
    a11yTree: unknown;
};

type GroupMetric = {
    rawFile: string;
    containerId: string;
    kind: GroupEntity['kind'];
    keySlot: number;
    itemCount: number;
    coverage: number;
    uniqueness: number;
    score: number;
};

type KeySlotLabel = {
    rawFile: string;
    expectedKeySlot: number;
    containerId?: string;
    kind?: GroupEntity['kind'];
};

const DATASET_DIR = path.resolve(process.cwd(), 'tests/fixtures/snapshot/web_docs');
const LABEL_FILE = path.join(DATASET_DIR, '_keyslot.labels.json');
const ENABLE_DATASET_TEST = process.env.SNAPSHOT_KEYSLOT_DATASET === '1';
const HAS_DATASET = fs.existsSync(DATASET_DIR);
const SHOULD_RUN = ENABLE_DATASET_TEST && HAS_DATASET;

const MAX_FILES = Math.max(1, parseInt(process.env.SNAPSHOT_KEYSLOT_MAX_FILES || '24', 10) || 24);

test('keySlot dataset smoke metrics should stay above baseline', { skip: !SHOULD_RUN }, () => {
    const rawFiles = listRawFiles(DATASET_DIR).slice(0, MAX_FILES);
    assert.ok(rawFiles.length > 0, 'expected web_docs dataset files');

    const metrics: GroupMetric[] = [];
    for (const file of rawFiles) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawFixture;
        const snapshot = generateSemanticSnapshotFromRaw(raw);
        metrics.push(...collectGroupMetrics(snapshot, path.basename(file)));
    }

    const candidates = metrics.filter((item) => item.itemCount >= 2);
    assert.ok(candidates.length >= 20, `expected enough group candidates, got ${candidates.length}`);

    const avgCoverage = avg(candidates.map((item) => item.coverage));
    const avgUniqueness = avg(candidates.map((item) => item.uniqueness));
    const strongCount = candidates.filter((item) => item.score >= 0.65).length;

    assert.ok(avgCoverage >= 0.3, `coverage too low: ${avgCoverage.toFixed(3)}`);
    assert.ok(avgUniqueness >= 0.35, `uniqueness too low: ${avgUniqueness.toFixed(3)}`);
    assert.ok(strongCount >= 8, `strong group too few: ${strongCount}`);
});

test('keySlot labels should meet accuracy threshold when labels exist', { skip: !SHOULD_RUN || !fs.existsSync(LABEL_FILE) }, () => {
    const labels = JSON.parse(fs.readFileSync(LABEL_FILE, 'utf8')) as KeySlotLabel[];
    assert.ok(labels.length > 0, 'expected label entries');

    const rawFileSet = new Set(labels.map((item) => item.rawFile));
    const metricsByFile = new Map<string, GroupMetric[]>();
    for (const rawFile of rawFileSet) {
        const fullPath = path.join(DATASET_DIR, rawFile);
        if (!fs.existsSync(fullPath)) continue;
        const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as RawFixture;
        const snapshot = generateSemanticSnapshotFromRaw(raw);
        metricsByFile.set(rawFile, collectGroupMetrics(snapshot, rawFile));
    }

    let matched = 0;
    let correct = 0;
    for (const label of labels) {
        const candidates = metricsByFile.get(label.rawFile) || [];
        const hit = pickLabelTarget(candidates, label);
        if (!hit) continue;
        matched += 1;
        if (hit.keySlot === label.expectedKeySlot) {
            correct += 1;
        }
    }

    assert.ok(matched >= 10, `matched labeled samples too few: ${matched}`);
    const accuracy = matched > 0 ? correct / matched : 0;
    assert.ok(accuracy >= 0.75, `labeled keySlot accuracy too low: ${accuracy.toFixed(3)}`);
});

const pickLabelTarget = (metrics: GroupMetric[], label: KeySlotLabel): GroupMetric | undefined => {
    const filtered = metrics.filter((item) => {
        if (label.containerId && item.containerId !== label.containerId) return false;
        if (label.kind && item.kind !== label.kind) return false;
        return true;
    });
    if (filtered.length === 0) return undefined;
    return filtered.sort((a, b) => b.itemCount - a.itemCount)[0];
};

const collectGroupMetrics = (snapshot: SnapshotResult, rawFile: string): GroupMetric[] => {
    const groups = Object.values(snapshot.entityIndex.entities).filter(
        (entity): entity is GroupEntity => entity.type === 'group',
    );
    if (groups.length === 0) return [];

    const slotMap = buildGroupSlotMap(snapshot.entityIndex);
    const metrics: GroupMetric[] = [];
    for (const group of groups) {
        const keyValues: string[] = [];
        for (const itemId of group.itemIds) {
            keyValues.push(readKeyValue(snapshot, slotMap, group.id, itemId, group.keySlot) || '');
        }
        const nonEmpty = keyValues.filter((item) => item.trim().length > 0);
        const coverage = group.itemIds.length > 0 ? nonEmpty.length / group.itemIds.length : 0;
        const uniqueSet = new Set(nonEmpty.map((item) => item.toLowerCase()));
        const uniqueness = nonEmpty.length > 0 ? uniqueSet.size / nonEmpty.length : 0;
        const score = 0.6 * uniqueness + 0.4 * coverage;

        metrics.push({
            rawFile,
            containerId: group.containerId,
            kind: group.kind,
            keySlot: group.keySlot,
            itemCount: group.itemIds.length,
            coverage,
            uniqueness,
            score,
        });
    }
    return metrics;
};

const buildGroupSlotMap = (entityIndex: EntityIndex): Map<string, Map<string, Map<number, string[]>>> => {
    const map = new Map<string, Map<string, Map<number, string[]>>>();
    for (const [nodeId, refs] of Object.entries(entityIndex.byNodeId || {})) {
        if (!refs || refs.length === 0) continue;
        for (const ref of refs) {
            if (ref.type !== 'group') continue;
            if (ref.slotIndex === undefined || !ref.itemId) continue;

            const byItem = map.get(ref.entityId) || new Map<string, Map<number, string[]>>();
            const bySlot = byItem.get(ref.itemId) || new Map<number, string[]>();
            const nodes = bySlot.get(ref.slotIndex) || [];
            nodes.push(nodeId);
            bySlot.set(ref.slotIndex, nodes);
            byItem.set(ref.itemId, bySlot);
            map.set(ref.entityId, byItem);
        }
    }
    return map;
};

const readKeyValue = (
    snapshot: SnapshotResult,
    slotMap: Map<string, Map<string, Map<number, string[]>>>,
    groupId: string,
    itemId: string,
    slotIndex: number,
): string | undefined => {
    const nodeIds = slotMap.get(groupId)?.get(itemId)?.get(slotIndex) || [];
    for (const nodeId of nodeIds) {
        const text = readNodeText(snapshot, nodeId);
        if (text) return text;
    }
    const itemNode = snapshot.nodeIndex[itemId];
    if (!itemNode) return undefined;
    return firstReadableText(snapshot, itemNode, 2);
};

const readNodeText = (snapshot: SnapshotResult, nodeId: string): string | undefined => {
    const node = snapshot.nodeIndex[nodeId];
    if (!node) return undefined;
    const attrs = snapshot.attrIndex[nodeId] || {};

    const candidates = [
        node.name,
        resolveContent(snapshot, node),
        attrs['aria-label'],
        attrs.title,
        attrs.placeholder,
        attrs.value,
    ];
    for (const value of candidates) {
        const text = normalizeText(value);
        if (!text) continue;
        if (text.length > 96) continue;
        return text;
    }
    return undefined;
};

const firstReadableText = (snapshot: SnapshotResult, node: UnifiedNode, depthLimit: number): string | undefined => {
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        const own = readNodeText(snapshot, current.node.id);
        if (own) return own;
        if (current.depth >= depthLimit) continue;
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return undefined;
};

const resolveContent = (snapshot: SnapshotResult, node: UnifiedNode): string | undefined => {
    if (!node.content) return undefined;
    if (typeof node.content === 'string') return node.content;
    if (node.content.ref) {
        return snapshot.contentStore[node.content.ref];
    }
    return undefined;
};

const listRawFiles = (dir: string): string[] => {
    const files = fs.readdirSync(dir);
    return files
        .filter((name) => name.endsWith('.raw.json'))
        .map((name) => path.join(dir, name))
        .sort();
};

const normalizeText = (value: string | undefined): string | undefined => {
    const text = (value || '').replace(/\s+/g, ' ').trim();
    return text ? text : undefined;
};

const avg = (values: number[]): number => {
    if (values.length === 0) return 0;
    return values.reduce((sum, item) => sum + item, 0) / values.length;
};
