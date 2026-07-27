import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addAnnotation,
    deleteAnnotation,
    deleteVisualItem,
    ignoreVisualItem,
    replaceAnnotationTarget,
    replaceVisualItemSelection,
    setAnnotationDisposition,
    updateAnnotation,
    updateColumn,
    updateColumnAction,
    updateEntity,
    updatePagination,
} from '../state/draft_ops.js';
import type {CanvasAnnotationDraft, CanvasDraft, CanvasEntityDraft} from '../types.js';

const makeAnnotation = (id: string, businessKey: string): CanvasAnnotationDraft => ({
    id,
    type: 'field',
    businessKey,
    target: {classContains: 'row'},
    origin: 'manual',
    disposition: 'active',
});

const makeEntity = (id: string): CanvasEntityDraft => ({
    id,
    source: 'region',
    kind: 'form',
    name: '表单',
    businessTag: 'form_tag',
    target: {},
    annotations: [makeAnnotation('a1', 'name'), makeAnnotation('a2', 'submit')],
    columns: [],
    origin: 'manual',
});

const makeDraft = (): CanvasDraft => ({
    version: 1,
    profileName: 'p',
    page: {kind: 'form'},
    entities: [makeEntity('e1')],
    preserved: {},
});

test('updateAnnotation patches fields without mutating original draft', () => {
    const original = makeDraft();
    const next = updateAnnotation(original, 'e1', 'a1', {name: '姓名', businessKey: 'ren'});
    assert.notEqual(next, original);
    assert.notEqual(next.entities[0].annotations[0], original.entities[0].annotations[0]);
    assert.equal(next.entities[0].annotations[0].name, '姓名');
    assert.equal(next.entities[0].annotations[0].businessKey, 'ren');
    assert.equal(original.entities[0].annotations[0].name, undefined);
});

test('updateAnnotation deeply clones the target object', () => {
    const original = makeDraft();
    const next = updateAnnotation(original, 'e1', 'a1', {
        target: {classContains: 'new-class'},
    });
    assert.notEqual(next.entities[0].annotations[0].target, original.entities[0].annotations[0].target);
    assert.equal(next.entities[0].annotations[0].target.classContains, 'new-class');
});

test('editing an inferred annotation confirms it while preserving manual origin', () => {
    const original = makeDraft();
    original.entities[0].annotations[0].origin = 'inferred';
    const inferred = updateAnnotation(original, 'e1', 'a1', {name: '姓名'});
    assert.equal(inferred.entities[0].annotations[0].origin, 'confirmed');
    const manual = updateAnnotation(makeDraft(), 'e1', 'a1', {name: '姓名'});
    assert.equal(manual.entities[0].annotations[0].origin, 'manual');
});

test('entity, column, action and pagination edits confirm their visual item', () => {
    const original = makeDraft();
    const entity = original.entities[0];
    entity.origin = 'inferred';
    entity.columns = [{id: 'col', fieldKey: 'status', origin: 'inferred', disposition: 'active', actions: [{id: 'edit', actionIntent: 'edit', target: {}, origin: 'inferred', disposition: 'active'}]}];
    entity.pagination = {actionIntent: 'next', pageTarget: {relation: 'pagination'}};
    const named = updateEntity(original, 'e1', {name: '订单'});
    const column = updateColumn(named, 'e1', 'col', {fieldKey: 'state'});
    const action = updateColumnAction(column, 'e1', 'edit', {actionIntent: 'modify'});
    const pagination = updatePagination(action, 'e1', {actionIntent: 'more'});
    assert.equal(pagination.entities[0].origin, 'confirmed');
    assert.equal(pagination.entities[0].columns[0].origin, 'confirmed');
    assert.equal(pagination.entities[0].columns[0].actions[0].origin, 'confirmed');
    assert.equal(pagination.entities[0].pagination?.actionIntent, 'more');
});

test('deleteAnnotation removes the annotation by id', () => {
    const original = makeDraft();
    const next = deleteAnnotation(original, 'e1', 'a1');
    assert.equal(next.entities[0].annotations.length, 1);
    assert.equal(next.entities[0].annotations[0].id, 'a2');
});

test('setAnnotationDisposition toggles ignored', () => {
    const original = makeDraft();
    const next = setAnnotationDisposition(original, 'e1', 'a1', 'ignored');
    assert.equal(next.entities[0].annotations[0].disposition, 'ignored');
    assert.equal(original.entities[0].annotations[0].disposition, 'active');
});

test('addAnnotation appends a new annotation', () => {
    const original = makeDraft();
    const next = addAnnotation(original, 'e1', makeAnnotation('a3', 'cancel'));
    assert.equal(next.entities[0].annotations.length, 3);
    assert.equal(next.entities[0].annotations[2].id, 'a3');
});

test('replaceAnnotationTarget overwrites target with deep clone', () => {
    const original = makeDraft();
    const next = replaceAnnotationTarget(original, 'e1', 'a1', {ariaContains: 'email'});
    assert.notEqual(next.entities[0].annotations[0].target, original.entities[0].annotations[0].target);
    assert.deepEqual(next.entities[0].annotations[0].target, {ariaContains: 'email'});
});

test('updateAnnotation returns same-shape draft when entity is missing', () => {
    const original = makeDraft();
    const next = updateAnnotation(original, 'missing', 'a1', {name: 'x'});
    assert.deepEqual(next.entities, original.entities);
});

test('updateAnnotation returns same-shape draft when annotation is missing', () => {
    const original = makeDraft();
    const next = updateAnnotation(original, 'e1', 'missing', {name: 'x'});
    assert.deepEqual(next.entities[0].annotations, original.entities[0].annotations);
});

test('replaceVisualItemSelection updates entity, column action and pagination targets', () => {
    const original = makeDraft();
    original.entities[0].columns = [{
        id: 'col', fieldKey: 'actions', origin: 'inferred', disposition: 'active',
        actions: [{id: 'edit', actionIntent: 'edit', text: '编辑', target: {}, origin: 'inferred', disposition: 'active'}],
    }];
    original.entities[0].pagination = {actionIntent: 'next', pageTarget: {classContains: 'old'}};
    const entity = replaceVisualItemSelection(original, 'e1', 'entity:e1', {target: {roleEquals: 'form'}});
    const action = replaceVisualItemSelection(entity, 'e1', 'edit', {target: {textContains: '修改'}, name: '修改'});
    const pagination = replaceVisualItemSelection(action, 'e1', 'e1_pgpage', {target: {classContains: 'next'}});
    assert.deepEqual(pagination.entities[0].target, {roleEquals: 'form'});
    assert.deepEqual(pagination.entities[0].columns[0].actions[0].target, {textContains: '修改'});
    assert.equal(pagination.entities[0].columns[0].actions[0].text, '修改');
    assert.deepEqual(pagination.entities[0].pagination?.pageTarget, {classContains: 'next'});
});

test('deleteVisualItem and ignoreVisualItem operate on columns, actions and pagination', () => {
    const original = makeDraft();
    original.entities[0].columns = [{
        id: 'col', fieldKey: 'actions', origin: 'inferred', disposition: 'active',
        actions: [{id: 'edit', actionIntent: 'edit', target: {}, origin: 'inferred', disposition: 'active'}],
    }];
    original.entities[0].pagination = {actionIntent: 'next', pageTarget: {classContains: 'next'}};
    const ignoredColumn = ignoreVisualItem(original, 'e1', 'col');
    assert.equal(ignoredColumn.entities[0].columns[0].disposition, 'ignored');
    const ignoredAction = ignoreVisualItem(original, 'e1', 'edit');
    assert.equal(ignoredAction.entities[0].columns[0].actions[0].disposition, 'ignored');
    const withoutAction = deleteVisualItem(original, 'e1', 'edit');
    assert.equal(withoutAction.entities[0].columns[0].actions.length, 0);
    const withoutPagination = deleteVisualItem(original, 'e1', 'e1_pgpage');
    assert.equal(withoutPagination.entities[0].pagination, undefined);
    const withoutColumn = deleteVisualItem(original, 'e1', 'col');
    assert.equal(withoutColumn.entities[0].columns.length, 0);
});
