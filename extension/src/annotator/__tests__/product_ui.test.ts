import test from 'node:test';
import assert from 'node:assert/strict';
import {
    annotationVisualState,
    deriveCanvasPresentation,
    checkIssueMessage,
    deriveProductStage,
    groupAnnotationBoxes,
    summarizeEntityDraft,
    candidateDisplayName,
} from '../state/product_ui.js';
import type {AnnotationBox} from '../layout/annotation_boxes.js';
import type {CanvasEntityDraft, PickCandidate} from '../types.js';

const entity = (): CanvasEntityDraft => ({
    id: 'e0',
    source: 'node',
    kind: 'table',
    name: '订单查询列表',
    businessTag: 'orders.main',
    target: {classContains: 'orders-module'},
    annotations: [
        {id: 'f1', type: 'field', name: '订单编号', businessKey: 'orderNo', target: {idEquals: 'orderNo'}, origin: 'inferred', disposition: 'active'},
        {id: 'a1', type: 'action', name: '查询', businessKey: 'search', target: {idEquals: 'search'}, origin: 'inferred', disposition: 'active'},
    ],
    columns: [
        {id: 'c1', fieldKey: 'orderNo', name: '订单编号', actions: [], origin: 'inferred', disposition: 'active'},
        {id: 'c2', fieldKey: 'actions', name: '操作', actions: [
            {id: 'edit', actionIntent: 'edit', text: '编辑', target: {textContains: '编辑'}, origin: 'inferred', disposition: 'active'},
        ], origin: 'inferred', disposition: 'active'},
    ],
    pagination: {actionIntent: 'nextPage', pageTarget: {idEquals: 'nextPage'}},
    origin: 'manual',
});

const box = (kind: AnnotationBox['kind'], id: string): AnnotationBox => ({
    annotationId: id,
    entityId: 'e0',
    kind,
    boxes: [],
    origin: 'inferred',
    disposition: 'active',
    matchCount: 1,
    labelName: id,
    businessKey: id,
});

test('deriveProductStage enforces scope -> recognize -> review -> edit', () => {
    assert.equal(deriveProductStage({hasDraft: false, hasObjects: false, hasArtifact: false, reviewPending: false}), 'scope');
    assert.equal(deriveProductStage({hasDraft: true, hasObjects: false, hasArtifact: false, reviewPending: false}), 'recognize');
    assert.equal(deriveProductStage({hasDraft: true, hasObjects: true, hasArtifact: false, reviewPending: true}), 'review');
    assert.equal(deriveProductStage({hasDraft: true, hasObjects: true, hasArtifact: false, reviewPending: false}), 'edit');
    assert.equal(deriveProductStage({hasDraft: true, hasObjects: true, hasArtifact: true, reviewPending: true}), 'edit');
});

test('deriveCanvasPresentation keeps the confirmed entity focused throughout review and editing', () => {
    assert.deepEqual(deriveCanvasPresentation('scope', false, false), {
        dimOutsideEntity: false,
        showEntity: false,
        showObjects: false,
        showLabels: false,
        showEditor: false,
    });
    assert.deepEqual(deriveCanvasPresentation('recognize', false, true), {
        dimOutsideEntity: true,
        showEntity: true,
        showObjects: false,
        showLabels: false,
        showEditor: false,
    });
    assert.deepEqual(deriveCanvasPresentation('review', false, true), {
        dimOutsideEntity: true,
        showEntity: true,
        showObjects: true,
        showLabels: true,
        showEditor: true,
    });
    assert.deepEqual(deriveCanvasPresentation('edit', false, true), {
        dimOutsideEntity: true,
        showEntity: true,
        showObjects: true,
        showLabels: true,
        showEditor: true,
    });
    assert.deepEqual(deriveCanvasPresentation('edit', true, true), {
        dimOutsideEntity: true,
        showEntity: true,
        showObjects: false,
        showLabels: false,
        showEditor: false,
    });
});

test('annotationVisualState maps inferred, confirmed and broken objects to canvas states', () => {
    const inferred = box('field', 'field');
    assert.deepEqual(annotationVisualState(inferred, null), {
        status: 'inferred',
        dashed: true,
        color: '#16a34a',
    });
    assert.deepEqual(annotationVisualState({...inferred, origin: 'confirmed'}, null), {
        status: 'confirmed',
        dashed: false,
        color: '#16a34a',
    });
    assert.deepEqual(annotationVisualState(inferred, {
        canvasAnnotationId: 'field',
        status: 'missing',
        matchCount: 0,
        expected: 'unique',
        message: 'missing',
        nodeIds: [],
    }), {
        status: 'error',
        dashed: false,
        color: '#dc2626',
    });
});

test('summarizeEntityDraft reports user-facing object counts', () => {
    assert.deepEqual(summarizeEntityDraft(entity()), {
        fields: 1,
        queryActions: 1,
        columns: 2,
        rowActions: 1,
        pagination: 1,
        total: 6,
    });
});

test('groupAnnotationBoxes hides entity frame and groups business objects', () => {
    const grouped = groupAnnotationBoxes([
        box('entity', 'entity:e0'),
        box('field', 'field'),
        box('action', 'action'),
        box('column', 'column'),
        box('pagination', 'pagination'),
    ]);
    assert.deepEqual(grouped.fields.map((item) => item.annotationId), ['field']);
    assert.deepEqual(grouped.actions.map((item) => item.annotationId), ['action']);
    assert.deepEqual(grouped.columns.map((item) => item.annotationId), ['column']);
    assert.deepEqual(grouped.pagination.map((item) => item.annotationId), ['pagination']);
});

test('candidateDisplayName never exposes region/group/fragile vocabulary', () => {
    const candidate: PickCandidate = {
        level: 'region',
        nodeId: 'orders',
        role: 'region',
        text: '订单查询列表',
        score: 100,
        stabilityHint: 'fragile',
    };
    assert.equal(candidateDisplayName(candidate, 'entity'), '订单查询列表');
    assert.equal(candidateDisplayName({...candidate, text: ''}, 'entity'), '业务区域');
    assert.equal(candidateDisplayName({...candidate, level: 'field', text: ''}, 'annotation'), '字段');
});

test('checkIssueMessage explains blocking results without technical vocabulary', () => {
    assert.equal(
        checkIssueMessage(true, null, null),
        '页面内容已经变化。请重新识别后再保存。',
    );
    assert.equal(
        checkIssueMessage(false, {
            canvasAnnotationId: 'field-1',
            status: 'missing',
            matchCount: 0,
            expected: 'unique',
            message: 'missing',
            nodeIds: [],
        }, '订单编号'),
        '“订单编号”未能在页面中找到，请重新选择它的位置。',
    );
    assert.equal(
        checkIssueMessage(false, {
            canvasAnnotationId: 'field-1',
            status: 'multiple',
            matchCount: 2,
            expected: 'unique',
            message: 'multiple',
            nodeIds: [],
        }, '查询按钮'),
        '“查询按钮”匹配到多个对象，请缩小选择范围。',
    );
});
