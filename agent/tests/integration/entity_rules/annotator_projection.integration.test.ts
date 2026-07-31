import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PageSnapshotSessionStore,
    buildAnnotatorProjection,
    resolveAnnotatorPoint,
} from '../../../src/snapshot';
import {createV2BusinessPage} from '../../helpers/v2_business_page';

test('AnnotatorProjection separates selection scope, host and structural root with agent geometry', async () => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const fixture = createV2BusinessPage({withGeometry: true, rowCount: 2});
    const entry = await store.ensureFresh({
        pageKey,
        pageUrl: 'https://example.test/orders',
        capture: async () => fixture.capture,
    });
    const form = Object.values(entry.capture.form.forms.forms)[0];
    const confirmation = store.confirmSelection(pageKey, fixture.nodeIds.panel);
    assert.equal(confirmation.ok, true);

    const projection = buildAnnotatorProjection(entry, store.readSelection(pageKey));
    assert.equal(projection.schemaVersion, 1);
    assert.equal(projection.selection.status, 'resolved');
    assert.equal(projection.components.length, 2);
    const formProjection = projection.components.find((component) => component.domain === 'form');
    assert.ok(formProjection);
    assert.equal(formProjection.structuralRootNodeId, form.location.structuralRootNodeId);
    assert.equal(formProjection.selectionScopeNodeId, undefined);

    const selectionTarget = projection.targets.find((target) => target.kind === 'selection-scope');
    assert.ok(selectionTarget);
    assert.deepEqual(selectionTarget.nodeIds, [fixture.nodeIds.panel]);
    assert.ok(selectionTarget.geometry.length > 0);

    const rootTarget = projection.targets.find((target) =>
        target.kind === 'structural-root' && target.componentId === form.id);
    assert.ok(rootTarget);
    assert.notEqual(rootTarget.nodeIds[0], selectionTarget.nodeIds[0]);
    assert.ok(projection.targets.some((target) => target.kind === 'field'));
    assert.ok(projection.targets.some((target) => target.kind === 'action'));
    assert.ok(projection.targets.some((target) => target.kind === 'row'));
    assert.ok(projection.targets.some((target) => target.kind === 'column'));
    assert.ok(projection.targets.some((target) => target.kind === 'semantic-binding'));
    const tableComponent = Object.values(entry.capture.table.tables.tables)[0];
    const tableAction = projection.targets.find((target) =>
        target.kind === 'action'
        && target.domain === 'table'
        && target.componentId === tableComponent.id
        && target.label === '审核');
    assert.ok(tableAction, 'table control slot must project as a typed action target');
    assert.equal(tableAction.memberId, tableComponent.controlSlots[0].id);
    assert.ok(tableAction.geometry.length > 0);
});

test('annotator point picking resolves the deepest canonical node without DOM selectors', async () => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const fixture = createV2BusinessPage({withGeometry: true});
    const entry = await store.ensureFresh({
        pageKey,
        pageUrl: 'https://example.test/orders',
        capture: async () => fixture.capture,
    });
    const approveNodeId = fixture.nodeIds.approve;
    const rect = entry.capture.control.observation.geometry[approveNodeId][0].rect;
    const result = resolveAnnotatorPoint(entry, {x: rect.x + 1, y: rect.y + 1});
    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') {
        assert.equal(result.nodeId, approveNodeId);
        assert.ok(result.anchor.backendNodeId);
    }
});

test('annotator point picking reports not_found outside captured geometry', async () => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const fixture = createV2BusinessPage({withGeometry: true});
    const entry = await store.ensureFresh({
        pageKey,
        pageUrl: 'https://example.test/orders',
        capture: async () => fixture.capture,
    });
    assert.deepEqual(resolveAnnotatorPoint(entry, {x: -1000, y: -1000}), {status: 'not_found'});
});
