import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEntityRuleArtifact } from '../profile_fixture';
import {
    importEntityRulesToCanvasDraft,
    compileCanvasDraft,
    validateCanvasDraft,
    detectPreservedConflicts,
} from '../../../../src/entity_rules/annotator/index';
import type { CanvasDraft } from '../../../../src/entity_rules/annotator/types';
import { validateEntityRules } from '../../../../src/runner/steps/executors/snapshot/entity_rules/validate';
import type { WorkflowEntityRules } from '../../../../src/workflow/entity_rules';
import type {
    EntityAnnotationRule,
    EntityAnnotationSet,
    EntityMatchRule,
    EntityRuleSet,
} from '../../../../src/runner/steps/executors/snapshot/entity_rules/types';

const findEntityByBusinessTag = (draft: CanvasDraft, businessTag: string) => {
    const entity = draft.entities.find((e) => e.businessTag === businessTag);
    assert.ok(entity, `entity with businessTag ${businessTag} not found`);
    return entity;
};

const findAnnotationRule = (artifact: WorkflowEntityRules, ruleId: string): EntityAnnotationRule | undefined => {
    const set = artifact.annotation as EntityAnnotationSet;
    return set.annotations.find((a) => a.ruleId === ruleId);
};

type NormalizedColumn = {
    fieldKey: string;
    name?: string;
    kind?: string;
    actions?: { actionIntent: string; text?: string }[];
};
type NormalizedEntity = {
    businessTag?: string;
    businessName?: string;
    primaryKey?: { fieldKey: string; columns?: string[] };
    columns?: NormalizedColumn[];
    fields?: { fieldKey: string; name?: string }[];
    actions?: { actionIntent: string; text?: string }[];
    pagination?: { nextAction?: { actionIntent: string } };
};

const normalizeAnnotation = (artifact: WorkflowEntityRules): NormalizedEntity[] => {
    const set = artifact.annotation as EntityAnnotationSet;
    return set.annotations
        .map((ann): NormalizedEntity => {
            const columns: NormalizedColumn[] | undefined = ann.columns
                ? ann.columns
                      .map((c): NormalizedColumn => {
                          const col: NormalizedColumn = { fieldKey: c.fieldKey };
                          if (c.name) {col.name = c.name;}
                          if (c.kind) {col.kind = c.kind;}
                          if (c.actions) {
                              col.actions = c.actions
                                  .map((a) => ({ actionIntent: a.actionIntent, ...(a.text ? { text: a.text } : {}) }))
                                  .sort((x, y) => x.actionIntent.localeCompare(y.actionIntent));
                          }
                          return col;
                      })
                      .sort((a, b) => a.fieldKey.localeCompare(b.fieldKey))
                : undefined;
            const fields = ann.fields
                ? ann.fields
                      .map((f) => ({ fieldKey: f.fieldKey, ...(f.name ? { name: f.name } : {}) }))
                      .sort((a, b) => a.fieldKey.localeCompare(b.fieldKey))
                : undefined;
            const actions = ann.actions
                ? ann.actions
                      .map((a) => ({ actionIntent: a.actionIntent, ...(a.text ? { text: a.text } : {}) }))
                      .sort((a, b) => a.actionIntent.localeCompare(b.actionIntent))
                : undefined;
            return {
                businessTag: ann.businessTag,
                businessName: ann.businessName,
                primaryKey: ann.primaryKey
                    ? { fieldKey: ann.primaryKey.fieldKey, ...(ann.primaryKey.columns ? { columns: [...ann.primaryKey.columns] } : {}) }
                    : undefined,
                columns,
                fields,
                actions,
                pagination: ann.pagination
                    ? { nextAction: ann.pagination.nextAction ? { actionIntent: ann.pagination.nextAction.actionIntent } : undefined }
                    : undefined,
            };
        })
        .sort((a, b) => (a.businessTag || '').localeCompare(b.businessTag || ''));
};

type WithinTreeNode = {
    source: string;
    withinDepth: number;
    childCount: number;
};

const normalizeWithinStructure = (artifact: WorkflowEntityRules): WithinTreeNode[] => {
    const set = artifact.match as EntityRuleSet;
    const byId = new Map<string, EntityMatchRule>();
    for (const e of set.entities) {
        byId.set(e.ruleId, e);
    }
    const childrenByParent = new Map<string, number>();
    for (const e of set.entities) {
        if (e.within) {
            childrenByParent.set(e.within, (childrenByParent.get(e.within) || 0) + 1);
        }
    }
    const depthCache = new Map<string, number>();
    const depthOf = (ruleId: string): number => {
        if (depthCache.has(ruleId)) {return depthCache.get(ruleId)!;}
        const rule = byId.get(ruleId);
        if (!rule || !rule.within) {
            depthCache.set(ruleId, 0);
            return 0;
        }
        const d = depthOf(rule.within) + 1;
        depthCache.set(ruleId, d);
        return d;
    };
    return set.entities
        .map((e): WithinTreeNode => ({
            source: e.source,
            withinDepth: depthOf(e.ruleId),
            childCount: childrenByParent.get(e.ruleId) || 0,
        }))
        .sort((a, b) => a.source.localeCompare(b.source) || a.withinDepth - b.withinDepth || a.childCount - b.childCount);
};

const assertSemanticEquivalent = (original: WorkflowEntityRules, compiled: WorkflowEntityRules): void => {
    assert.deepEqual(normalizeAnnotation(original), normalizeAnnotation(compiled));
    assert.deepEqual(normalizeWithinStructure(original), normalizeWithinStructure(compiled));
};

const compileExpectOk = (draft: CanvasDraft) => {
    const result = compileCanvasDraft(draft);
    if (!result.ok) {
        assert.fail(`expected compile to succeed but got errors:\n${result.errors.join('\n')}`);
    }
    return result;
};

test('1. oa-ant-orders imports to CanvasDraft with table entity, columns, and pagination', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-orders');
    const draft = importEntityRulesToCanvasDraft(artifact);

    assert.equal(draft.version, 1);
    assert.equal(draft.profileName, 'oa-ant-orders');
    assert.equal(draft.page.kind, 'table');
    assert.equal(draft.entities.length, 1);

    const entity = draft.entities[0];
    assert.equal(entity.kind, 'table');
    assert.equal(entity.source, 'region');
    assert.equal(entity.businessTag, 'order.list.main');
    assert.equal(entity.name, '订单主列表');
    assert.equal(entity.origin, 'confirmed');
    assert.ok(entity.columns.length >= 5, 'should have at least 5 columns');
    assert.ok(entity.pagination, 'should have pagination');
    assert.equal(entity.pagination!.actionIntent, 'nextPage');

    const orderNoCol = entity.columns.find((c) => c.fieldKey === 'orderNo');
    assert.ok(orderNoCol);
    assert.equal(orderNoCol!.name, '订单编号');
    assert.equal(orderNoCol!.origin, 'confirmed');

    const actionsCol = entity.columns.find((c) => c.fieldKey === 'actions');
    assert.ok(actionsCol);
    assert.equal(actionsCol!.kind, 'action_column');
    assert.ok(actionsCol!.actions.length >= 2);
    assert.equal(actionsCol!.actions[0].origin, 'confirmed');
});

test('2. import→compile round-trip passes validateEntityRules and is semantically equivalent', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-orders');
    const draft = importEntityRulesToCanvasDraft(artifact);
    const result = compileExpectOk(draft);

    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);

    assertSemanticEquivalent(artifact, result.artifact);
});

test('3. renaming a column name compiles correctly while preserving everything else', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-orders');
    const draft = importEntityRulesToCanvasDraft(artifact);

    const entity = draft.entities[0];
    const buyerCol = entity.columns.find((c) => c.fieldKey === 'buyer');
    assert.ok(buyerCol);
    assert.equal(buyerCol!.name, '采购人');
    buyerCol!.name = '购买人';

    const result = compileExpectOk(draft);

    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);

    const compiledAnn = result.artifact.annotation as EntityAnnotationSet;
    const tableAnn = compiledAnn.annotations[0];
    const compiledBuyer = tableAnn.columns!.find((c) => c.fieldKey === 'buyer');
    assert.ok(compiledBuyer);
    assert.equal(compiledBuyer!.name, '购买人');

    const orderNoCol = tableAnn.columns!.find((c) => c.fieldKey === 'orderNo');
    assert.ok(orderNoCol);
    assert.equal(orderNoCol!.name, '订单编号');

    assert.equal(tableAnn.primaryKey?.fieldKey, 'orderNo');
    assert.equal(tableAnn.pagination?.nextAction?.actionIntent, 'nextPage');

    const actionsCol = tableAnn.columns!.find((c) => c.fieldKey === 'actions');
    assert.ok(actionsCol);
    assert.equal(actionsCol!.actions!.length, 2);
});

test('4. oa-ant-order-form (legacy) imports to a CanvasDraft', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-order-form');
    const draft = importEntityRulesToCanvasDraft(artifact);

    assert.equal(draft.page.kind, 'form');
    assert.equal(draft.entities.length, 1);

    const entity = draft.entities[0];
    assert.equal(entity.kind, 'form');
    assert.equal(entity.businessTag, 'order.form.main');
    assert.equal(entity.name, '订单主表单');

    const fieldAnnotations = entity.annotations.filter((a) => a.type === 'field');
    assert.ok(fieldAnnotations.length >= 4, 'form should have at least 4 field annotations from legacy columns');

    const orderNoField = fieldAnnotations.find((a) => a.businessKey === 'orderNo');
    assert.ok(orderNoField);
    assert.equal(orderNoField!.name, '订单编号');

    const actionAnnotations = entity.annotations.filter((a) => a.type === 'action');
    assert.ok(actionAnnotations.length >= 1, 'should have at least 1 action annotation');
    const submitAction = actionAnnotations.find((a) => a.businessKey === 'submit');
    assert.ok(submitAction);
});

test('5. legacy form recompiles to fields/actions (NOT columns, NOT legacy fieldKey/actionIntent)', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-order-form');
    const draft = importEntityRulesToCanvasDraft(artifact);
    const result = compileExpectOk(draft);

    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);

    const compiledAnn = result.artifact.annotation as EntityAnnotationSet;
    assert.equal(compiledAnn.annotations.length, 1, 'should have exactly 1 annotation rule');

    const formAnn = compiledAnn.annotations[0];
    assert.equal(formAnn.businessTag, 'order.form.main');
    assert.ok(formAnn.fields, 'must have fields array');
    assert.ok(formAnn.fields!.length >= 4);
    assert.equal(formAnn.columns, undefined, 'must NOT have legacy columns on form');
    assert.equal(formAnn.fieldKey, undefined, 'must NOT have legacy top-level fieldKey');
    assert.equal(formAnn.actionIntent, undefined, 'must NOT have legacy top-level actionIntent');

    const fieldKeys = formAnn.fields!.map((f) => f.fieldKey);
    assert.ok(fieldKeys.includes('orderNo'));
    assert.ok(fieldKeys.includes('buyer'));
    assert.ok(fieldKeys.includes('amount'));
    assert.ok(fieldKeys.includes('dept'));

    assert.ok(formAnn.actions, 'must have actions array');
    assert.equal(formAnn.actions!.length, 1);
    assert.equal(formAnn.actions![0].actionIntent, 'submit');
    assert.ok(formAnn.actions![0].nodeRuleId, 'submit action should have nodeRuleId');
});

test('6. opaque fields (field.kind, optionSource) survive import→compile round-trip', async () => {
    const opaqueArtifact: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'opaque-test',
        match: {
            version: 1,
            page: { kind: 'form' },
            entities: [
                { ruleId: 'form_main', source: 'region', expect: 'unique', match: { kind: 'form' } },
            ],
        },
        annotation: {
            version: 1,
            page: { kind: 'form' },
            annotations: [
                {
                    ruleId: 'form_main',
                    businessTag: 'form.main',
                    businessName: 'Test Form',
                    fields: [
                        { fieldKey: 'username', name: 'Username', kind: 'input' },
                        { fieldKey: 'role', name: 'Role', kind: 'select', optionSource: { kind: 'inline' } },
                    ],
                },
            ],
        },
    };

    const validatedOriginal = validateEntityRules(opaqueArtifact.name, opaqueArtifact.match, opaqueArtifact.annotation);
    assert.equal(validatedOriginal.ok, true, 'crafted artifact must be valid before import');

    const draft = importEntityRulesToCanvasDraft(opaqueArtifact);
    const result = compileExpectOk(draft);

    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);

    const compiledAnn = result.artifact.annotation as EntityAnnotationSet;
    const formAnn = compiledAnn.annotations[0];
    assert.ok(formAnn.fields);

    const usernameField = formAnn.fields!.find((f) => f.fieldKey === 'username');
    assert.ok(usernameField);
    assert.equal(usernameField!.kind, 'input', 'field.kind must survive round-trip');

    const roleField = formAnn.fields!.find((f) => f.fieldKey === 'role');
    assert.ok(roleField);
    assert.equal(roleField!.kind, 'select', 'field.kind must survive round-trip');
    assert.ok(roleField!.optionSource, 'optionSource must survive round-trip');
    assert.equal(roleField!.optionSource!.kind, 'inline');
});

test('7. multi-entity artifact imports and compiles with validateEntityRules passing', async () => {
    const multiArtifact: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'multi-entity',
        match: {
            version: 1,
            page: { kind: 'table' },
            entities: [
                { ruleId: 'orders_table', source: 'region', expect: 'unique', match: { kind: 'table' } },
                { ruleId: 'orders_edit', source: 'node', expect: 'one_or_more', within: 'orders_table', match: { classContains: 'btn', textContains: 'Edit' } },
                { ruleId: 'summary_panel', source: 'region', expect: 'unique', match: { kind: 'panel' } },
            ],
        },
        annotation: {
            version: 1,
            page: { kind: 'table' },
            annotations: [
                {
                    ruleId: 'orders_table',
                    businessTag: 'orders.table',
                    businessName: 'Orders',
                    columns: [{ fieldKey: 'id', name: 'ID' }],
                },
                {
                    ruleId: 'orders_edit',
                    actionIntent: 'edit',
                },
                {
                    ruleId: 'summary_panel',
                    businessTag: 'summary.panel',
                    businessName: 'Summary',
                },
            ],
        },
    };

    const validatedOriginal = validateEntityRules(multiArtifact.name, multiArtifact.match, multiArtifact.annotation);
    assert.equal(validatedOriginal.ok, true);

    const draft = importEntityRulesToCanvasDraft(multiArtifact);
    assert.ok(draft.entities.length >= 2, 'should have at least 2 entities');
    const tags = draft.entities.map((e) => e.businessTag).sort();
    assert.ok(tags.includes('orders.table'));
    assert.ok(tags.includes('summary.panel'));

    const result = compileExpectOk(draft);

    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);
});

test('8a. duplicate businessTag across entities is detected', () => {
    const draft: CanvasDraft = {
        version: 1,
        profileName: 'conflict-test',
        page: { kind: 'table' },
        entities: [
            {
                id: 'e0',
                source: 'region',
                kind: 'table',
                name: 'Entity A',
                businessTag: 'dup.tag',
                target: { kind: 'table' },
                annotations: [],
                columns: [],
                origin: 'manual',
            },
            {
                id: 'e1',
                source: 'region',
                kind: 'table',
                name: 'Entity B',
                businessTag: 'dup.tag',
                target: { kind: 'table' },
                annotations: [],
                columns: [],
                origin: 'manual',
            },
        ],
        preserved: { matchRaw: {}, annotationRaw: {}, preservedByCanvasId: {}, ruleIdToCanvasId: {}, locatorRules: [], ruleRefs: [] },
    };

    const validation = validateCanvasDraft(draft);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.includes('duplicate businessTag')));

    const result = compileCanvasDraft(draft);
    assert.equal(result.ok, false);
});

test('8b. duplicate column fieldKey within an entity is detected', () => {
    const draft: CanvasDraft = {
        version: 1,
        profileName: 'conflict-test',
        page: { kind: 'table' },
        entities: [
            {
                id: 'e0',
                source: 'region',
                kind: 'table',
                name: 'Entity A',
                businessTag: 'unique.tag',
                target: { kind: 'table' },
                annotations: [],
                columns: [
                    { id: 'c0', fieldKey: 'dup', name: 'A', actions: [], origin: 'manual', disposition: 'active' },
                    { id: 'c1', fieldKey: 'dup', name: 'B', actions: [], origin: 'manual', disposition: 'active' },
                ],
                origin: 'manual',
            },
        ],
        preserved: { matchRaw: {}, annotationRaw: {}, preservedByCanvasId: {}, ruleIdToCanvasId: {}, locatorRules: [], ruleRefs: [] },
    };

    const validation = validateCanvasDraft(draft);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.includes('duplicate column fieldKey')));
});

test('8c. duplicate actionIntent within an entity is detected', () => {
    const draft: CanvasDraft = {
        version: 1,
        profileName: 'conflict-test',
        page: { kind: 'table' },
        entities: [
            {
                id: 'e0',
                source: 'region',
                kind: 'table',
                name: 'Entity A',
                businessTag: 'unique.tag',
                target: { kind: 'table' },
                annotations: [
                    { id: 'a0', type: 'action', businessKey: 'edit', target: { classContains: 'btn' }, origin: 'manual', disposition: 'active' },
                    { id: 'a1', type: 'action', businessKey: 'edit', target: { classContains: 'btn2' }, origin: 'manual', disposition: 'active' },
                ],
                columns: [],
                origin: 'manual',
            },
        ],
        preserved: { matchRaw: {}, annotationRaw: {}, preservedByCanvasId: {}, ruleIdToCanvasId: {}, locatorRules: [], ruleRefs: [] },
    };

    const validation = validateCanvasDraft(draft);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.includes('duplicate annotation actionIntent')));
});

test('9a. entity with empty target fails compile', () => {
    const draft: CanvasDraft = {
        version: 1,
        profileName: 'empty-target',
        page: { kind: 'table' },
        entities: [
            {
                id: 'e0',
                source: 'region',
                kind: 'table',
                name: 'Entity A',
                businessTag: 'some.tag',
                target: {},
                annotations: [],
                columns: [],
                origin: 'manual',
            },
        ],
        preserved: { matchRaw: {}, annotationRaw: {}, preservedByCanvasId: {}, ruleIdToCanvasId: {}, locatorRules: [], ruleRefs: [] },
    };

    const result = compileCanvasDraft(draft);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('target')));
});

test('9b. missing target after import (clearing entity target) fails compile', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-orders');
    const draft = importEntityRulesToCanvasDraft(artifact);
    draft.entities[0].target = {};
    const result = compileCanvasDraft(draft);
    assert.equal(result.ok, false);
});

test('10a. oa-ant-orders compile passes validateEntityRules', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-orders');
    const draft = importEntityRulesToCanvasDraft(artifact);
    const result = compileExpectOk(draft);
    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);
});

test('10b. oa-ant-order-form compile passes validateEntityRules', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-order-form');
    const draft = importEntityRulesToCanvasDraft(artifact);
    const result = compileExpectOk(draft);
    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);
});

test('10c. oa-element-users compile passes validateEntityRules', async () => {
    const artifact = await loadEntityRuleArtifact('oa-element-users');
    const draft = importEntityRulesToCanvasDraft(artifact);
    const result = compileExpectOk(draft);
    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);
});

test('10d. oa-element-user-form compile passes validateEntityRules', async () => {
    const artifact = await loadEntityRuleArtifact('oa-element-user-form');
    const draft = importEntityRulesToCanvasDraft(artifact);
    const result = compileExpectOk(draft);
    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);
});

test('10e. opaque artifact compile passes validateEntityRules', () => {
    const opaqueArtifact: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'opaque-test',
        match: {
            version: 1,
            page: { kind: 'form' },
            entities: [{ ruleId: 'form_main', source: 'region', expect: 'unique', match: { kind: 'form' } }],
        },
        annotation: {
            version: 1,
            page: { kind: 'form' },
            annotations: [
                {
                    ruleId: 'form_main',
                    businessTag: 'form.main',
                    businessName: 'Test Form',
                    fields: [
                        { fieldKey: 'username', name: 'Username', kind: 'input' },
                        { fieldKey: 'role', name: 'Role', kind: 'select', optionSource: { kind: 'inline' } },
                    ],
                },
            ],
        },
    };
    const draft = importEntityRulesToCanvasDraft(opaqueArtifact);
    const result = compileExpectOk(draft);
    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);
});

test('10f. multi-entity artifact compile passes validateEntityRules', () => {
    const multiArtifact: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'multi-entity',
        match: {
            version: 1,
            page: { kind: 'table' },
            entities: [
                { ruleId: 'orders_table', source: 'region', expect: 'unique', match: { kind: 'table' } },
                { ruleId: 'orders_edit', source: 'node', expect: 'one_or_more', within: 'orders_table', match: { classContains: 'btn', textContains: 'Edit' } },
                { ruleId: 'summary_panel', source: 'region', expect: 'unique', match: { kind: 'panel' } },
            ],
        },
        annotation: {
            version: 1,
            page: { kind: 'table' },
            annotations: [
                { ruleId: 'orders_table', businessTag: 'orders.table', businessName: 'Orders', columns: [{ fieldKey: 'id', name: 'ID' }] },
                { ruleId: 'orders_edit', actionIntent: 'edit' },
                { ruleId: 'summary_panel', businessTag: 'summary.panel', businessName: 'Summary' },
            ],
        },
    };
    const draft = importEntityRulesToCanvasDraft(multiArtifact);
    const result = compileExpectOk(draft);
    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);
});

test('detectPreservedConflicts returns empty for unedited round-trip drafts', async () => {
    const artifact = await loadEntityRuleArtifact('oa-ant-orders');
    const draft = importEntityRulesToCanvasDraft(artifact);
    const conflicts = detectPreservedConflicts(draft);
    assert.deepEqual(conflicts, []);
});

test('BUG1: oa-element-users edit action match rule preserves expect=one_or_more', async () => {
    const artifact = await loadEntityRuleArtifact('oa-element-users');
    const draft = importEntityRulesToCanvasDraft(artifact);

    const entity = draft.entities[0];
    const editAnnotation = entity.annotations.find((a) => a.type === 'action' && a.businessKey === 'edit');
    assert.ok(editAnnotation, 'edit action annotation should exist');
    assert.equal(editAnnotation!.expect, 'one_or_more', 'imported action annotation must carry expect');

    const result = compileExpectOk(draft);
    const matchSet = result.artifact.match as EntityRuleSet;
    const editMatchRule = matchSet.entities.find((e) => e.match?.textContains === '编辑');
    assert.ok(editMatchRule, 'compiled match rule for edit action should exist');
    assert.equal(editMatchRule!.expect, 'one_or_more', 'compiled edit action match rule must be one_or_more');

    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);
});

test('BUG2: field controlRuleId/labelRuleId locator rules are preserved and rewritten on compile', () => {
    const formArtifact: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'form-with-locators',
        match: {
            version: 1,
            page: { kind: 'form' },
            entities: [
                { ruleId: 'form_main', source: 'region', expect: 'unique', match: { kind: 'form' } },
                { ruleId: 'ctrl_node', source: 'node', expect: 'unique', within: 'form_main', match: { classContains: 'input-control' } },
                { ruleId: 'label_node', source: 'node', expect: 'unique', within: 'form_main', match: { classContains: 'input-label' } },
            ],
        },
        annotation: {
            version: 1,
            page: { kind: 'form' },
            annotations: [
                {
                    ruleId: 'form_main',
                    businessTag: 'form.main',
                    businessName: 'Form',
                    fields: [
                        { fieldKey: 'username', name: 'Username', controlRuleId: 'ctrl_node', labelRuleId: 'label_node' },
                    ],
                },
            ],
        },
    };

    const validatedOriginal = validateEntityRules(formArtifact.name, formArtifact.match, formArtifact.annotation);
    assert.equal(validatedOriginal.ok, true);

    const draft = importEntityRulesToCanvasDraft(formArtifact);
    assert.ok(draft.preserved.locatorRules.length === 2, 'two locator rules should be captured');
    assert.ok(draft.preserved.ruleRefs.length === 2, 'two rule refs should be captured');

    const result = compileExpectOk(draft);
    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);

    const matchSet = result.artifact.match as EntityRuleSet;
    const matchRuleIds = new Set(matchSet.entities.map((e) => e.ruleId));
    assert.ok(matchRuleIds.has('loc_ctrl_node'), 'compiled match must contain loc_ctrl_node');
    assert.ok(matchRuleIds.has('loc_label_node'), 'compiled match must contain loc_label_node');

    const ctrlRule = matchSet.entities.find((e) => e.ruleId === 'loc_ctrl_node');
    assert.ok(ctrlRule?.within, 'locator rule should have within pointing to entity');
    assert.equal(ctrlRule!.within, 'entity_0', 'locator within must be rewritten to compiled entity ruleId');

    const compiledAnn = result.artifact.annotation as EntityAnnotationSet;
    const formAnn = compiledAnn.annotations[0];
    assert.ok(formAnn.fields);
    const usernameField = formAnn.fields!.find((f) => f.fieldKey === 'username');
    assert.ok(usernameField);
    assert.equal(usernameField!.controlRuleId, 'loc_ctrl_node');
    assert.equal(usernameField!.labelRuleId, 'loc_label_node');
    assert.ok(matchRuleIds.has(usernameField!.controlRuleId!), 'controlRuleId must reference an existing match rule');
    assert.ok(matchRuleIds.has(usernameField!.labelRuleId!), 'labelRuleId must reference an existing match rule');
});

test('BUG2: pagination.nextAction.disabledRuleId locator rule is preserved and rewritten on compile', () => {
    const tableArtifact: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'table-with-disabled-ref',
        match: {
            version: 1,
            page: { kind: 'table' },
            entities: [
                { ruleId: 'tbl_main', source: 'region', expect: 'unique', match: { kind: 'table' } },
                { ruleId: 'pg_item', source: 'node', expect: 'unique', match: { relation: 'pagination', classContains: 'pager' } },
                { ruleId: 'pg_page', source: 'node', expect: 'unique', within: 'pg_item', match: { classContains: 'next-btn' } },
                { ruleId: 'disabled_node', source: 'node', expect: 'unique', within: 'tbl_main', match: { classContains: 'disabled-flag' } },
            ],
        },
        annotation: {
            version: 1,
            page: { kind: 'table' },
            annotations: [
                {
                    ruleId: 'tbl_main',
                    businessTag: 'tbl.main',
                    businessName: 'Table',
                    pagination: {
                        nextAction: {
                            actionIntent: 'nextPage',
                            nodeRuleId: 'pg_page',
                            disabledRuleId: 'disabled_node',
                        },
                    },
                },
            ],
        },
    };

    const validatedOriginal = validateEntityRules(tableArtifact.name, tableArtifact.match, tableArtifact.annotation);
    assert.equal(validatedOriginal.ok, true);

    const draft = importEntityRulesToCanvasDraft(tableArtifact);
    assert.ok(draft.preserved.locatorRules.length === 1, 'disabled_node locator rule should be captured');
    assert.ok(draft.preserved.ruleRefs.length === 1, 'disabled rule ref should be captured');

    const result = compileExpectOk(draft);
    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);

    const matchSet = result.artifact.match as EntityRuleSet;
    const matchRuleIds = new Set(matchSet.entities.map((e) => e.ruleId));
    assert.ok(matchRuleIds.has('loc_disabled_node'), 'compiled match must contain loc_disabled_node');

    const compiledAnn = result.artifact.annotation as EntityAnnotationSet;
    const tableAnn = compiledAnn.annotations[0];
    assert.ok(tableAnn.pagination?.nextAction?.disabledRuleId);
    assert.equal(tableAnn.pagination!.nextAction!.disabledRuleId, 'loc_disabled_node');
    assert.ok(
        matchRuleIds.has(tableAnn.pagination!.nextAction!.disabledRuleId!),
        'disabledRuleId must reference an existing match rule',
    );
});

test('BUG3: field.optionSource.optionRuleId round-trips without blocking', () => {
    const optionArtifact: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'form-with-option-ref',
        match: {
            version: 1,
            page: { kind: 'form' },
            entities: [
                { ruleId: 'form_main', source: 'region', expect: 'unique', match: { kind: 'form' } },
                { ruleId: 'option_node', source: 'node', expect: 'unique', within: 'form_main', match: { classContains: 'option-list' } },
            ],
        },
        annotation: {
            version: 1,
            page: { kind: 'form' },
            annotations: [
                {
                    ruleId: 'form_main',
                    businessTag: 'form.main',
                    businessName: 'Form',
                    fields: [
                        { fieldKey: 'role', name: 'Role', optionSource: { kind: 'popup', optionRuleId: 'option_node' } },
                    ],
                },
            ],
        },
    };

    const validatedOriginal = validateEntityRules(optionArtifact.name, optionArtifact.match, optionArtifact.annotation);
    assert.equal(validatedOriginal.ok, true);

    const draft = importEntityRulesToCanvasDraft(optionArtifact);
    const result = compileExpectOk(draft);
    const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
    assert.equal(validated.ok, true);

    const matchSet = result.artifact.match as EntityRuleSet;
    const matchRuleIds = new Set(matchSet.entities.map((e) => e.ruleId));
    assert.ok(matchRuleIds.has('loc_option_node'), 'compiled match must contain loc_option_node');

    const compiledAnn = result.artifact.annotation as EntityAnnotationSet;
    const formAnn = compiledAnn.annotations[0];
    const roleField = formAnn.fields!.find((f) => f.fieldKey === 'role');
    assert.ok(roleField?.optionSource);
    assert.equal(roleField!.optionSource!.kind, 'popup');
    assert.equal(roleField!.optionSource!.optionRuleId, 'loc_option_node');
    assert.ok(matchRuleIds.has(roleField!.optionSource!.optionRuleId!), 'optionRuleId must reference an existing match rule');
});

test('all 4 profile fixtures round-trip import→compile→validate with ok===true', async () => {
    const profiles = ['oa-ant-orders', 'oa-ant-order-form', 'oa-element-users', 'oa-element-user-form'];
    for (const profile of profiles) {
        const artifact = await loadEntityRuleArtifact(profile);
        const draft = importEntityRulesToCanvasDraft(artifact);
        const result = compileCanvasDraft(draft);
        assert.equal(result.ok, true, `${profile} should compile without blocking`);
        const validated = validateEntityRules(result.artifact.name, result.artifact.match, result.artifact.annotation);
        assert.equal(validated.ok, true, `${profile} should pass validateEntityRules`);
    }
});
