import test from 'node:test';
import assert from 'node:assert/strict';
import {
    annotationLabelTarget,
    deriveAnnotationBoxes,
} from '../layout/annotation_boxes.js';
import type {
    CanvasAnnotationDraft,
    CanvasDraft,
    CanvasEntityDraft,
    CheckResultByAnnotation,
    VisualTargetRef,
} from '../types.js';

const makeAnnotation = (id: string, businessKey: string, type: CanvasAnnotationDraft['type'] = 'field'): CanvasAnnotationDraft => ({
    id,
    type,
    businessKey,
    target: {},
    origin: 'manual',
    disposition: 'active',
});

const makeEntity = (id: string, withEntityBox = true): CanvasEntityDraft => ({
    id,
    source: 'region',
    kind: 'form',
    name: `Entity ${id}`,
    businessTag: `tag_${id}`,
    target: {},
    annotations: [makeAnnotation('a1', 'name'), makeAnnotation('a2', 'submit', 'action')],
    columns: [],
    origin: 'manual',
});

const makeDraft = (): CanvasDraft => ({
    version: 1,
    profileName: 'p',
    page: {kind: 'form'},
    entities: [makeEntity('e1'), makeEntity('e2')],
    preserved: {},
});

const makeBindings = (withEntityBox = true): VisualTargetRef[] => {
    const bindings: VisualTargetRef[] = [];
    if (withEntityBox) {
        bindings.push({
            entityId: 'e1',
            nodeId: 'n_entity',
            role: 'entity',
            bbox: {x: 0, y: 0, width: 400, height: 300},
        });
    }
    bindings.push({
        entityId: 'e1',
        nodeId: 'n_a1',
        role: 'field',
        fieldKey: 'name',
        canvasAnnotationId: 'a1',
        bbox: {x: 10, y: 10, width: 100, height: 30},
    });
    bindings.push({
        entityId: 'e1',
        nodeId: 'n_a2',
        role: 'action',
        actionIntent: 'submit',
        canvasAnnotationId: 'a2',
        bbox: {x: 10, y: 50, width: 60, height: 30},
    });
    return bindings;
};

test('deriveAnnotationBoxes returns empty when draft is null', () => {
    assert.deepEqual(deriveAnnotationBoxes(null, [], null, null), []);
});

test('deriveAnnotationBoxes collects entity and annotation boxes for current entity', () => {
    const boxes = deriveAnnotationBoxes(makeDraft(), makeBindings(), 'e1', null);
    const ids = boxes.map((b) => b.annotationId);
    assert.ok(ids.includes('entity:e1'));
    assert.ok(ids.includes('a1'));
    assert.ok(ids.includes('a2'));
});

test('deriveAnnotationBoxes includes all entities when currentEntityId is null', () => {
    const boxes = deriveAnnotationBoxes(makeDraft(), [], null, null);
    const entityIds = new Set(boxes.map((b) => b.entityId));
    assert.ok(entityIds.has('e1'));
    assert.ok(entityIds.has('e2'));
});

test('deriveAnnotationBoxes projects columns, column actions and pagination as canvas items', () => {
    const draft = makeDraft();
    const entity = draft.entities[0];
    entity.kind = 'table';
    entity.columns = [{
        id: 'col-status', fieldKey: 'status', name: '状态', origin: 'inferred', disposition: 'active',
        actions: [{id: 'row-edit', actionIntent: 'edit', text: '编辑', target: {}, origin: 'inferred', disposition: 'active'}],
    }];
    entity.pagination = {actionIntent: 'next', pageTarget: {relation: 'pagination'}};
    const bindings: VisualTargetRef[] = [
        {entityId: 'e1', nodeId: 'header-status', role: 'column', fieldKey: 'status', bbox: {x: 0, y: 0, width: 80, height: 20}},
        {entityId: 'e1', nodeId: 'edit-1', role: 'action', actionIntent: 'edit', matchedNodeBoxes: [{x: 0, y: 30, width: 40, height: 20}, {x: 0, y: 60, width: 40, height: 20}]},
        {entityId: 'e1', nodeId: 'next', role: 'pagination', actionIntent: 'next', bbox: {x: 0, y: 100, width: 60, height: 20}},
    ];
    const boxes = deriveAnnotationBoxes(draft, bindings, 'e1', null);
    assert.deepEqual(boxes.map((box) => box.annotationId), ['a1', 'a2', 'col-status', 'row-edit', 'pagination:e1']);
    assert.equal(boxes.find((box) => box.annotationId === 'col-status')?.kind, 'column');
    assert.equal(boxes.find((box) => box.annotationId === 'row-edit')?.boxes.length, 2);
    assert.equal(boxes.find((box) => box.annotationId === 'pagination:e1')?.kind, 'pagination');
});

test('deriveAnnotationBoxes prefers matchedNodeBoxes for multi-row matches', () => {
    const bindings: VisualTargetRef[] = [{
        entityId: 'e1',
        nodeId: 'n1',
        role: 'action',
        canvasAnnotationId: 'a2',
        matchedNodeBoxes: [
            {x: 0, y: 0, width: 50, height: 20},
            {x: 0, y: 30, width: 50, height: 20},
            {x: 0, y: 60, width: 50, height: 20},
        ],
    }];
    const boxes = deriveAnnotationBoxes(makeDraft(), bindings, 'e1', null);
    const a2 = boxes.find((b) => b.annotationId === 'a2');
    assert.equal(a2?.boxes.length, 3);
    assert.equal(a2?.matchCount, 3);
});

test('deriveAnnotationBoxes uses check result matchCount when present', () => {
    const results: CheckResultByAnnotation[] = [{
        canvasAnnotationId: 'a1',
        status: 'multiple',
        matchCount: 5,
        expected: 'one_or_more',
        message: '',
        nodeIds: [],
    }];
    const boxes = deriveAnnotationBoxes(makeDraft(), makeBindings(), 'e1', results);
    const a1 = boxes.find((b) => b.annotationId === 'a1');
    assert.equal(a1?.matchCount, 5);
});

test('deriveAnnotationBoxes maps entity box only when binding present', () => {
    const boxes = deriveAnnotationBoxes(makeDraft(), makeBindings(false), 'e1', null);
    const entityBox = boxes.find((b) => b.annotationId === 'entity:e1');
    assert.equal(entityBox, undefined);
});

test('annotationLabelTarget averages centers across multiple boxes', () => {
    const target = annotationLabelTarget({
        annotationId: 'a',
        entityId: 'e',
        kind: 'action',
        boxes: [
            {x: 0, y: 0, width: 10, height: 10},
            {x: 100, y: 200, width: 10, height: 10},
        ],
        origin: 'manual',
        disposition: 'active',
        matchCount: 2,
        labelName: 'lbl',
        businessKey: 'k',
    });
    assert.deepEqual(target?.targetCenter, {x: 55, y: 105});
});

test('annotationLabelTarget returns null when boxes list is empty', () => {
    assert.equal(annotationLabelTarget({
        annotationId: 'a',
        entityId: 'e',
        kind: 'action',
        boxes: [],
        origin: 'manual',
        disposition: 'active',
        matchCount: 0,
        labelName: 'lbl',
        businessKey: 'k',
    }), null);
});

test('deriveAnnotationBoxes falls back to fieldKey/actionIntent matching when canvasAnnotationId missing', () => {
    const bindings: VisualTargetRef[] = [{
        entityId: 'e1',
        nodeId: 'n1',
        role: 'field',
        fieldKey: 'name',
        bbox: {x: 5, y: 5, width: 80, height: 30},
    }];
    const boxes = deriveAnnotationBoxes(makeDraft(), bindings, 'e1', null);
    const a1 = boxes.find((b) => b.annotationId === 'a1');
    assert.deepEqual(a1?.boxes, [{x: 5, y: 5, width: 80, height: 30}]);
});

test('deriveAnnotationBoxes produces exact geometry from bbox and matchedNodeBoxes', () => {
    const bindings: VisualTargetRef[] = [
        {
            entityId: 'e1',
            nodeId: 'n_ent',
            role: 'entity',
            bbox: {x: 5, y: 15, width: 200, height: 100},
        },
        {
            entityId: 'e1',
            nodeId: 'n_act',
            role: 'action',
            actionIntent: 'submit',
            canvasAnnotationId: 'a2',
            matchedNodeBoxes: [
                {x: 0, y: 0, width: 60, height: 25},
                {x: 0, y: 35, width: 60, height: 25},
            ],
        },
    ];
    const boxes = deriveAnnotationBoxes(makeDraft(), bindings, 'e1', null);
    const entityBox = boxes.find((b) => b.annotationId === 'entity:e1');
    assert.ok(entityBox, 'entity box should exist');
    assert.deepEqual(entityBox!.boxes, [{x: 5, y: 15, width: 200, height: 100}]);
    const actionBox = boxes.find((b) => b.annotationId === 'a2');
    assert.ok(actionBox, 'action box should exist');
    assert.equal(actionBox!.boxes.length, 2);
    assert.deepEqual(actionBox!.boxes[0], {x: 0, y: 0, width: 60, height: 25});
    assert.deepEqual(actionBox!.boxes[1], {x: 0, y: 35, width: 60, height: 25});
});
