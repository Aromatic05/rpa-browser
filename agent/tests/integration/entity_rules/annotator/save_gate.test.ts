import test from 'node:test';
import assert from 'node:assert/strict';
import {
    evaluateSaveGate,
    detectOpaqueMergeConflicts,
} from '../../../../src/entity_rules/annotator/save_gate';
import { compileCanvasDraft } from '../../../../src/entity_rules/annotator/compile';
import type {
    CanvasAnnotationDraft,
    CanvasDraft,
    CanvasEntityDraft,
    PersistentTargetDraft,
} from '../../../../src/entity_rules/annotator/types';
import type { CheckResultByAnnotation } from '../../../../src/entity_rules/annotator/runtime_types';
import type { EntityRuleExpect } from '../../../../src/runner/steps/executors/snapshot/entity_rules/types';

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
    target: target({ nameContains: 'form' }),
    annotations: [],
    columns: [],
    origin: 'inferred',
    ...partial,
});

const validDraft = (overrides?: Partial<CanvasDraft>): CanvasDraft => ({
    version: 1,
    profileName: 'gate-profile',
    page: { kind: 'form' },
    entities: [
        entity('e0', 'form.main', {
            origin: 'confirmed',
            target: target({ nameContains: 'form' }),
        }),
    ],
    preserved: {
        matchRaw: { version: 1, page: { kind: 'form' }, entities: [] },
        annotationRaw: { version: 1, page: { kind: 'form' }, annotations: [] },
        preservedByCanvasId: {},
        ruleIdToCanvasId: {},
        locatorRules: [],
        ruleRefs: [],
    },
    ...overrides,
});

const checkResult = (
    canvasId: string,
    matchCount: number,
    expect: EntityRuleExpect = 'unique',
): CheckResultByAnnotation => ({
    canvasAnnotationId: canvasId,
    status: matchCount === 0 ? 'missing' : expect === 'unique' && matchCount > 1 ? 'multiple' : 'unique',
    matchCount,
    expected: expect,
    message: '',
    nodeIds: [],
});

const okCompile = (draft: CanvasDraft) => compileCanvasDraft(draft);

test('evaluateSaveGate allows a clean draft: confirmed entity resolves uniquely, no stale/revision', () => {
    const draft = validDraft();
    const compile = okCompile(draft);
    assert.equal(compile.ok, true);
    const gate = evaluateSaveGate(
        draft,
        [checkResult('entity:e0', 1)],
        false,
        false,
        compile,
    );
    assert.deepEqual(gate, { ok: true });
});

test('evaluateSaveGate blocks schema_invalid when draft fails to compile (validation error)', () => {
    const draft = validDraft({
        entities: [
            entity('e0', 'form.main', {
                origin: 'inferred',
                target: target({}),
                name: '',
            }),
        ],
    });
    const compile = compileCanvasDraft(draft);
    assert.equal(compile.ok, false);
    const gate = evaluateSaveGate(draft, [], false, false, compile);
    assert.equal(gate.ok, false);
    if (!gate.ok) {
        assert.equal(gate.code, 'schema_invalid');
    }
});

test('evaluateSaveGate blocks revision_conflict', () => {
    const draft = validDraft();
    const gate = evaluateSaveGate(
        draft,
        [checkResult('entity:e0', 1)],
        false,
        true,
        okCompile(draft),
    );
    assert.equal(gate.ok, false);
    if (!gate.ok) {
        assert.equal(gate.code, 'revision_conflict');
    }
});

test('evaluateSaveGate blocks page_stale when stale flag is set', () => {
    const draft = validDraft();
    const gate = evaluateSaveGate(
        draft,
        [checkResult('entity:e0', 1)],
        true,
        false,
        okCompile(draft),
    );
    assert.equal(gate.ok, false);
    if (!gate.ok) {
        assert.equal(gate.code, 'page_stale');
    }
});

test('evaluateSaveGate blocks primary_entity_unresolved when entity root matchCount is 0', () => {
    const draft = validDraft();
    const gate = evaluateSaveGate(
        draft,
        [checkResult('entity:e0', 0)],
        false,
        false,
        okCompile(draft),
    );
    assert.equal(gate.ok, false);
    if (!gate.ok) {
        assert.equal(gate.code, 'primary_entity_unresolved');
    }
});

test('evaluateSaveGate blocks confirmed_unique_zero for confirmed annotation expect unique with 0 matches', () => {
    const draft = validDraft({
        entities: [
            entity('e0', 'form.main', {
                origin: 'confirmed',
                annotations: [
                    annotation('e0_f0', 'buyer', {
                        origin: 'confirmed',
                        expect: 'unique',
                        target: target({ classContains: 'buyer-class' }),
                    }),
                ],
            }),
        ],
    });
    const gate = evaluateSaveGate(
        draft,
        [checkResult('entity:e0', 1), checkResult('e0_f0', 0, 'unique')],
        false,
        false,
        okCompile(draft),
    );
    assert.equal(gate.ok, false);
    if (!gate.ok) {
        assert.equal(gate.code, 'confirmed_unique_zero');
    }
});

test('evaluateSaveGate blocks confirmed_unique_multiple for confirmed annotation expect unique with >1 matches', () => {
    const draft = validDraft({
        entities: [
            entity('e0', 'form.main', {
                origin: 'confirmed',
                annotations: [
                    annotation('e0_f0', 'buyer', {
                        origin: 'confirmed',
                        expect: 'unique',
                        target: target({ classContains: 'buyer-class' }),
                    }),
                ],
            }),
        ],
    });
    const gate = evaluateSaveGate(
        draft,
        [checkResult('entity:e0', 1), checkResult('e0_f0', 3, 'unique')],
        false,
        false,
        okCompile(draft),
    );
    assert.equal(gate.ok, false);
    if (!gate.ok) {
        assert.equal(gate.code, 'confirmed_unique_multiple');
    }
});

test('evaluateSaveGate blocks reference_missing for confirmed one_or_more annotation with 0 matches', () => {
    const draft = validDraft({
        entities: [
            entity('e0', 'form.main', {
                origin: 'confirmed',
                annotations: [
                    annotation('e0_act0', 'submit', {
                        type: 'action',
                        origin: 'confirmed',
                        expect: 'one_or_more',
                        target: target({ textContains: '提交' }),
                    }),
                ],
            }),
        ],
    });
    const gate = evaluateSaveGate(
        draft,
        [checkResult('entity:e0', 1), checkResult('e0_act0', 0, 'one_or_more')],
        false,
        false,
        okCompile(draft),
    );
    assert.equal(gate.ok, false);
    if (!gate.ok) {
        assert.equal(gate.code, 'reference_missing');
    }
});

test('evaluateSaveGate allows inferred annotation with 0 matches (unconfirmed inferred is not blocked)', () => {
    const draft = validDraft({
        entities: [
            entity('e0', 'form.main', {
                origin: 'confirmed',
                annotations: [
                    annotation('e0_f0', 'buyer', {
                        origin: 'inferred',
                        expect: 'unique',
                        target: target({ classContains: 'missing-class' }),
                    }),
                ],
            }),
        ],
    });
    const gate = evaluateSaveGate(
        draft,
        [checkResult('entity:e0', 1), checkResult('e0_f0', 0, 'unique')],
        false,
        false,
        okCompile(draft),
    );
    assert.deepEqual(gate, { ok: true });
});

test('evaluateSaveGate allows one_or_more annotation with multiple matches (legal multi-hit)', () => {
    const draft = validDraft({
        entities: [
            entity('e0', 'form.main', {
                origin: 'confirmed',
                annotations: [
                    annotation('e0_act0', 'submit', {
                        type: 'action',
                        origin: 'inferred',
                        expect: 'one_or_more',
                        target: target({ classContains: 'btn' }),
                    }),
                ],
            }),
        ],
    });
    const gate = evaluateSaveGate(
        draft,
        [checkResult('entity:e0', 1), checkResult('e0_act0', 5, 'one_or_more')],
        false,
        false,
        okCompile(draft),
    );
    assert.deepEqual(gate, { ok: true });
});

test('evaluateSaveGate blocks opaque_unmergeable when preserved ref owner no longer exists on canvas', () => {
    const draft = validDraft({
        entities: [
            entity('e0', 'form.main', {
                origin: 'confirmed',
                target: target({ nameContains: 'form' }),
            }),
        ],
        preserved: {
            matchRaw: { version: 1, page: { kind: 'form' }, entities: [] },
            annotationRaw: { version: 1, page: { kind: 'form' }, annotations: [] },
            preservedByCanvasId: {},
            ruleIdToCanvasId: {},
            locatorRules: [],
            ruleRefs: [
                {
                    canvasAnnotationId: 'e0_deleted_field',
                    refPath: ['controlRuleId'],
                    preservedKey: 'loc_missing',
                },
            ],
        },
    });
    const opaque = detectOpaqueMergeConflicts(draft);
    assert.ok(opaque.length > 0, 'dangling preserved ref should be detected');
    const gate = evaluateSaveGate(draft, [], false, false, okCompile(draft));
    assert.equal(gate.ok, false);
    if (!gate.ok) {
        assert.equal(gate.code, 'opaque_unmergeable');
    }
});
