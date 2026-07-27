import test from 'node:test';
import assert from 'node:assert/strict';
import { protectiveMerge } from '../../../../src/entity_rules/annotator/merge';
import type {
    CanvasAnnotationDraft,
    CanvasDraft,
    CanvasEntityDraft,
    PersistentTargetDraft,
} from '../../../../src/entity_rules/annotator/types';

const target = (overrides: PersistentTargetDraft): PersistentTargetDraft => ({ ...overrides });

const annotation = (
    id: string,
    businessKey: string,
    partial: Partial<CanvasAnnotationDraft>,
): CanvasAnnotationDraft => ({
    id,
    type: 'field',
    businessKey,
    target: {},
    expect: 'unique',
    origin: 'inferred',
    disposition: 'active',
    ...partial,
});

const entity = (
    id: string,
    businessTag: string,
    partial: Partial<CanvasEntityDraft>,
): CanvasEntityDraft => ({
    id,
    source: 'region',
    kind: 'form',
    name: businessTag,
    businessTag,
    target: {},
    annotations: [],
    columns: [],
    origin: 'inferred',
    ...partial,
});

const draftWith = (entities: CanvasEntityDraft[]): CanvasDraft => ({
    version: 1,
    profileName: 'merge-profile',
    page: { kind: 'form' },
    entities,
    preserved: {
        matchRaw: { version: 1, page: { kind: 'form' }, entities: [] },
        annotationRaw: { version: 1, page: { kind: 'form' }, annotations: [] },
        preservedByCanvasId: {},
        ruleIdToCanvasId: {},
        locatorRules: [],
        ruleRefs: [],
    },
});

test('protectiveMerge keeps confirmed entity verbatim: name, businessTag, target never overwritten', () => {
    const existing = draftWith([
        entity('e0', 'order.form', {
            origin: 'confirmed',
            name: '用户确认的表单',
            target: target({ nameContains: '原始名称' }),
            annotations: [
                annotation('e0_f0', 'buyer', {
                    origin: 'confirmed',
                    name: '采购人',
                    target: target({ classContains: 'original-class' }),
                }),
            ],
        }),
    ]);
    const fresh = [
        entity('fresh0', 'order.form', {
            name: '页面新表单名',
            target: target({ nameContains: '新名称' }),
            annotations: [
                annotation('fresh0_f0', 'buyer', {
                    name: '采购人-改',
                    target: target({ classContains: 'new-class' }),
                }),
            ],
        }),
    ];
    const { draft, stats } = protectiveMerge(existing, fresh, { kind: 'form' });
    const merged = draft.entities[0];
    assert.equal(merged.id, 'e0');
    assert.equal(merged.origin, 'confirmed');
    assert.equal(merged.name, '用户确认的表单');
    assert.equal(merged.businessTag, 'order.form');
    assert.equal(merged.target.nameContains, '原始名称');
    const ann = merged.annotations[0];
    assert.equal(ann.origin, 'confirmed');
    assert.equal(ann.name, '采购人');
    assert.equal(ann.target.classContains, 'original-class');
    assert.equal(stats.refreshedCount, 0, 'confirmed items are not refreshed');
    assert.ok(stats.invalidatedCount === 0, 'confirmed-with-fresh-match is not invalidated');
});

test('protectiveMerge refreshes inferred entity target but preserves user-edited name and businessKey', () => {
    const existing = draftWith([
        entity('e0', 'order.form', {
            origin: 'inferred',
            name: '用户改名',
            target: target({ nameContains: '旧条件' }),
            annotations: [
                annotation('e0_f0', 'buyer', {
                    name: '采购人改名',
                    target: target({ classContains: 'old-class' }),
                }),
            ],
        }),
    ]);
    const fresh = [
        entity('fresh0', 'order.form', {
            name: '推测名',
            target: target({ nameContains: '新条件' }),
            annotations: [
                annotation('fresh0_f0', 'buyer', {
                    name: '采购人',
                    target: target({ classContains: 'new-class' }),
                }),
            ],
        }),
    ];
    const { draft, stats } = protectiveMerge(existing, fresh, { kind: 'form' });
    const merged = draft.entities[0];
    assert.equal(merged.origin, 'inferred');
    assert.equal(merged.name, '用户改名', 'inferred name preserved');
    assert.equal(merged.businessTag, 'order.form');
    assert.equal(merged.target.nameContains, '新条件', 'inferred target refreshed');
    const ann = merged.annotations[0];
    assert.equal(ann.name, '采购人改名', 'inferred annotation name preserved');
    assert.equal(ann.target.classContains, 'new-class', 'inferred annotation target refreshed');
    assert.ok(stats.refreshedCount >= 2, 'entity and annotation counted as refreshed');
});

test('protectiveMerge respects ignored: ignored annotation is not re-added as inferred', () => {
    const existing = draftWith([
        entity('e0', 'order.form', {
            origin: 'inferred',
            annotations: [
                annotation('e0_f0', 'buyer', {
                    disposition: 'ignored',
                    target: target({ classContains: 'ignored-class' }),
                }),
            ],
        }),
    ]);
    const fresh = [
        entity('fresh0', 'order.form', {
            annotations: [
                annotation('fresh0_f0', 'buyer', {
                    target: target({ classContains: 'rediscovered-class' }),
                }),
            ],
        }),
    ];
    const { draft } = protectiveMerge(existing, fresh, { kind: 'form' });
    const annotations = draft.entities[0].annotations;
    const ignored = annotations.find((a) => a.businessKey === 'buyer');
    assert.ok(ignored, 'ignored annotation kept');
    assert.equal(ignored?.disposition, 'ignored');
    assert.equal(ignored?.target.classContains, 'ignored-class', 'ignored target untouched');
    const duplicates = annotations.filter((a) => a.businessKey === 'buyer');
    assert.equal(duplicates.length, 1, 'no duplicate inferred annotation added for ignored key');
});

test('protectiveMerge adds genuinely new snapshot entity as inferred', () => {
    const existing = draftWith([
        entity('e0', 'order.form', { origin: 'confirmed' }),
    ]);
    const fresh = [
        entity('fresh_new', 'order.detail', {
            name: '订单详情',
            target: target({ nameContains: '订单详情' }),
            annotations: [
                annotation('fresh_new_f0', 'amount', {
                    target: target({ classContains: 'amount-class' }),
                }),
            ],
        }),
    ];
    const { draft, stats } = protectiveMerge(existing, fresh, { kind: 'form' });
    const newEntity = draft.entities.find((e) => e.businessTag === 'order.detail');
    assert.ok(newEntity, 'new entity added');
    assert.equal(newEntity?.origin, 'inferred');
    assert.notEqual(newEntity?.id, 'e0', 'new entity gets a fresh id');
    assert.notEqual(newEntity?.id, 'fresh_new', 'new entity id is allocated, not the fresh literal');
    assert.equal(newEntity?.annotations[0].origin, 'inferred');
    assert.ok(stats.newCount >= 2, 'new entity plus its annotation counted');
});

test('protectiveMerge retains invalidated confirmed item when fresh snapshot no longer detects it', () => {
    const existing = draftWith([
        entity('e0', 'order.gone', {
            origin: 'confirmed',
            name: '已消失的实体',
            target: target({ nameContains: 'gone' }),
            annotations: [
                annotation('e0_f0', 'goneField', {
                    origin: 'confirmed',
                    target: target({ classContains: 'gone-class' }),
                }),
            ],
        }),
    ]);
    const { draft, stats } = protectiveMerge(existing, [], { kind: 'form' });
    const retained = draft.entities.find((e) => e.businessTag === 'order.gone');
    assert.ok(retained, 'invalidated confirmed entity retained');
    assert.equal(retained?.origin, 'confirmed');
    assert.equal(retained?.name, '已消失的实体');
    assert.equal(retained?.target.nameContains, 'gone');
    assert.equal(retained?.annotations.length, 1);
    assert.equal(retained?.annotations[0].target.classContains, 'gone-class');
    assert.ok(stats.invalidatedCount >= 2, 'entity plus annotation counted as invalidated');
});

test('protectiveMerge without existing draft returns a fresh draft seeded from fresh entities', () => {
    const fresh = [
        entity('fresh0', 'order.form', {
            annotations: [
                annotation('fresh0_f0', 'buyer', { target: target({ classContains: 'x' }) }),
            ],
        }),
    ];
    const { draft, stats } = protectiveMerge(undefined, fresh, { kind: 'form' });
    assert.equal(draft.entities.length, 1);
    assert.equal(draft.entities[0].origin, 'inferred');
    assert.ok(draft.preserved.preservedByCanvasId);
    assert.ok(stats.newCount >= 2);
});
