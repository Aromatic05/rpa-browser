import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PageSnapshotSessionStore,
    buildSnapshotProjection,
    diffSnapshotProjection,
    type PageSnapshotSessionEntry,
} from '../../../src/snapshot';
import {createV2BusinessPage} from '../../helpers/v2_business_page';

const createEntry = async (options: {rowCount?: number; withGeometry?: boolean} = {}): Promise<PageSnapshotSessionEntry> => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const {capture} = createV2BusinessPage(options);
    return await store.ensureFresh({
        pageKey,
        pageUrl: 'https://example.test/orders',
        capture: async () => capture,
    });
};

const collectNodeIds = (roots: readonly {nodeId: string; children: readonly any[]}[]): string[] => {
    const result: string[] = [];
    const visit = (node: {nodeId: string; children: readonly any[]}) => {
        result.push(node.nodeId);
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    return result;
};

test('SnapshotProjection scopes canonical nodes by contain depth and AND filters', async () => {
    const entry = await createEntry();
    const observation = entry.capture.control.observation;
    const tableNodeId = observation.captureIdToNodeId['orders-table'];
    const rowNodeId = observation.captureIdToNodeId['row-1'];
    const approveNodeId = observation.captureIdToNodeId.approve;

    const depthZero = buildSnapshotProjection(entry, {contain: tableNodeId, depth: 0});
    assert.equal(depthZero.ok, true);
    if (!depthZero.ok) {return;}
    assert.deepEqual(collectNodeIds(depthZero.projection.roots), [tableNodeId]);

    const rows = buildSnapshotProjection(entry, {
        contain: tableNodeId,
        depth: -1,
        filter: {role: 'tr', text: 'SO-001'},
    });
    assert.equal(rows.ok, true);
    if (!rows.ok) {return;}
    const rowIds = collectNodeIds(rows.projection.roots);
    assert.equal(rowIds.includes(rowNodeId), true);
    assert.equal(rowIds.includes(approveNodeId), false);

    const interactive = buildSnapshotProjection(entry, {filter: {interactive: true, text: '审核'}});
    assert.equal(interactive.ok, true);
    if (!interactive.ok) {return;}
    assert.equal(collectNodeIds(interactive.projection.roots).includes(approveNodeId), true);
    assert.equal(interactive.projection.meta.filterSignature, '{"interactive":true,"text":"审核"}');
});

test('SnapshotProjection preserves form and table schema with explicit collection reports', async () => {
    const entry = await createEntry();
    const built = buildSnapshotProjection(entry, {});
    assert.equal(built.ok, true);
    if (!built.ok) {return;}

    assert.equal(built.projection.schemaVersion, 2);
    assert.equal(built.projection.components.forms.length, 1);
    assert.equal(built.projection.components.forms[0].fields.length, 1);
    assert.equal(built.projection.components.forms[0].actions.length, 1);
    assert.equal(built.projection.components.tables.length, 1);
    assert.deepEqual(built.projection.components.tables[0].columns.map((column) => column.name), ['订单编号', '操作']);
    assert.equal(built.projection.components.tables[0].rows.length, 1);
    assert.equal(built.projection.components.tables[0].rowCollection.omitted, 0);
    assert.equal(built.projection.collections.some((item) => item.kind === 'nodes'), true);
});

test('SemanticDiff reports canonical node and component state changes and falls back across epochs', async () => {
    const entry = await createEntry();
    const first = buildSnapshotProjection(entry, {});
    assert.equal(first.ok, true);
    if (!first.ok) {return;}

    const changed = structuredClone(first.projection);
    const submit = changed.components.forms[0].actions[0];
    submit.structuralRole = 'button';
    const submitNodeId = submit.nodeId;
    const updateNode = (nodes: any[]): boolean => {
        for (const node of nodes) {
            if (node.nodeId === submitNodeId) {
                node.text = '已提交';
                return true;
            }
            if (updateNode(node.children)) {return true;}
        }
        return false;
    };
    assert.equal(updateNode(changed.roots), true);
    changed.meta.snapshotId = `${changed.meta.pageEpoch}:2:full`;
    changed.meta.captureRevision = 2;

    const diff = diffSnapshotProjection(changed, first.projection);
    assert.equal(diff.mode, 'diff');
    assert.equal(diff.projection.meta.changedNodeCount, 1);
    assert.equal(diff.projection.meta.changedComponentIds.length, 1);
    assert.equal(collectNodeIds(diff.projection.roots).includes(submitNodeId), true);

    const navigation = structuredClone(changed);
    navigation.meta.pageEpoch = 'other-epoch';
    const fallback = diffSnapshotProjection(navigation, first.projection);
    assert.equal(fallback.mode, 'full');
    assert.equal(fallback.projection.meta.diffSkipped, 'navigation');
});

test('SnapshotProjection rejects unknown contain ids', async () => {
    const entry = await createEntry();
    const result = buildSnapshotProjection(entry, {contain: 'missing-node'});
    assert.equal(result.ok, false);
    if (result.ok) {return;}
    assert.equal(result.error.code, 'ERR_NOT_FOUND');
});


test('overview mode uses FeatureCover and reports omitted rows explicitly', async () => {
    const entry = await createEntry({rowCount: 3});
    const built = buildSnapshotProjection(entry, {mode: 'overview'});
    assert.equal(built.ok, true);
    if (!built.ok) {return;}

    assert.equal(built.projection.meta.viewMode, 'overview');
    const table = built.projection.components.tables[0];
    assert.equal(table.rows.length, 1);
    assert.deepEqual(table.rows.map((row) => row.id), entry.capture.table.tables.tables[table.id].featureCover.representativeRowIds);
    assert.equal(table.rowCollection.total, 3);
    assert.equal(table.rowCollection.included, 1);
    assert.equal(table.rowCollection.omitted, 2);
    assert.equal(table.rowCollection.policy, 'feature-cover');
});

test('interaction mode retains every executable control and omits unrelated detail', async () => {
    const entry = await createEntry();
    const built = buildSnapshotProjection(entry, {mode: 'interaction'});
    assert.equal(built.ok, true);
    if (!built.ok) {return;}

    assert.equal(built.projection.meta.viewMode, 'interaction');
    const projectedNodeIds = new Set(collectNodeIds(built.projection.roots));
    const executableRoots = Object.values(entry.capture.control.controls.controls)
        .filter((control) => control.capabilities.length > 0)
        .map((control) => control.rootNodeId);
    assert.ok(executableRoots.length > 0);
    for (const nodeId of executableRoots) {
        assert.equal(projectedNodeIds.has(nodeId), true, `missing executable control root ${nodeId}`);
    }
    assert.equal(projectedNodeIds.has(entry.capture.control.observation.captureIdToNodeId.panel), false);
    assert.equal(built.projection.components.tables[0].rowCollection.policy, 'interaction-context');
});

test('annotation mode exposes binding targets and component geometry', async () => {
    const entry = await createEntry({withGeometry: true});
    const built = buildSnapshotProjection(entry, {mode: 'annotation'});
    assert.equal(built.ok, true);
    if (!built.ok) {return;}

    assert.equal(built.projection.meta.viewMode, 'annotation');
    const projectedNodeIds = new Set(collectNodeIds(built.projection.roots));
    const semanticTargetNodeIds = Object.values(entry.semanticBindingsByProfile)
        .flatMap((bindings) => Object.values(bindings.byId))
        .flatMap((binding) => binding.target.nodeIds);
    for (const nodeId of semanticTargetNodeIds) {
        assert.equal(projectedNodeIds.has(nodeId), true, `missing semantic target ${nodeId}`);
    }
    assert.ok(built.projection.components.forms[0].geometry.length > 0);
    assert.ok(built.projection.components.tables[0].geometry.length > 0);
    assert.equal(built.projection.components.tables[0].rowCollection.policy, 'annotation-targets');
});

test('debug mode exposes scope completeness evidence and node geometry', async () => {
    const entry = await createEntry({withGeometry: true});
    const built = buildSnapshotProjection(entry, {mode: 'debug'});
    assert.equal(built.ok, true);
    if (!built.ok) {return;}

    assert.equal(built.projection.meta.viewMode, 'debug');
    assert.deepEqual(built.projection.debug?.completeness, entry.capture.control.observation.completeness);
    assert.equal(built.projection.debug?.scopes.length, 1);
    assert.ok((built.projection.debug?.componentEvidence.forms.length ?? 0) > 0);
    const nodes = built.projection.roots.flatMap((root) => [root, ...root.children]);
    assert.equal(nodes.some((node) => (node.geometry?.length ?? 0) > 0), true);
});
