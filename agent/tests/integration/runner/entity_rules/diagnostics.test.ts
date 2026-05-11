import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getRunnerConfig } from '../../../src/config';
import { RunnerPluginHost } from '../../../src/runner/hotreload/plugin_host';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import { executeBrowserEntity } from '../../../src/runner/steps/executors/entity';
import { executeBrowserQuery } from '../../../src/runner/steps/executors/query';
import { applyBusinessEntityRules } from '../../../src/runner/steps/executors/snapshot/entity_rules/apply';
import { buildFinalEntityViewFromSnapshot } from '../../../src/runner/steps/executors/snapshot/core/overlay';
import { buildSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/build_snapshot';
import { buildExternalIndexes } from '../../../src/runner/steps/executors/snapshot/indexes/external_indexes';
import type {
    EntityIndex,
    EntityRuleDiagnostic,
    FinalEntityView,
    SnapshotResult,
    UnifiedNode,
} from '../../../src/runner/steps/executors/snapshot/core/types';
import type { NormalizedEntityRuleBundle } from '../../../src/runner/steps/executors/snapshot/entity_rules/types';
import type { Step } from '../../../src/runner/steps/types';

type FixtureOptions = {
    missingFieldControl?: boolean;
    missingFormAction?: boolean;
    unresolvedTableHeader?: boolean;
    missingRowActionButton?: boolean;
    duplicateMissingFieldControl?: boolean;
};

const createDeps = (snapshot: SnapshotResult, finalEntityView: FinalEntityView): RunStepsDeps => {
    const workspaceName = 'ws-diagnostics';
    const tabName = 'tab-diagnostics';
    const tabName = 'tab-token-diagnostics';
    const url = 'https://example.test/entity-diagnostics';
    const binding = {
        workspaceName,
        tabName,
        tabName,
        page: { url: () => url },
        traceCtx: {
            cache: {
                snapshotSessionStore: {
                    version: 1,
                    entries: {
                        [`${workspaceName}:${tabName}`]: {
                            pageIdentity: { workspaceName, tabName, tabName, url },
                            baseSnapshot: snapshot,
                            finalSnapshot: snapshot,
                            finalEntityView,
                            overlays: { renamedNodes: {}, addedEntities: [], deletedEntities: [] },
                            diffBaselines: {},
                            dirty: false,
                            lastRefreshAt: Date.now(),
                            version: 1,
                        },
                    },
                },
            },
        },
    };

    return {
        runtime: {
            ensureActivePage: async () => binding,
        } as any,
        config: getRunnerConfig(),
        pluginHost: new RunnerPluginHost(path.resolve(process.cwd(), 'src/runner/plugin_entry.ts')),
    };
};

const createFixture = (options: FixtureOptions = {}): { snapshot: SnapshotResult; finalEntityView: FinalEntityView } => {
    const buyerLabel: UnifiedNode = { id: 'buyer_label', role: 'text', name: '采购人', children: [] };
    const buyerInput: UnifiedNode = { id: 'buyer_input', role: 'textbox', name: '采购人输入', children: [] };
    const submitButton: UnifiedNode = { id: 'submit_button', role: 'button', name: '提交', children: [] };
    const form: UnifiedNode = { id: 'form_main', role: 'form', name: '订单表单', children: [buyerLabel, buyerInput, submitButton] };

    const headerOrderNo: UnifiedNode = { id: 'header_order_no', role: 'columnheader', name: '订单编号', children: [] };
    const headerAction: UnifiedNode = { id: 'header_action', role: 'columnheader', name: '操作', children: [] };
    const headerRow: UnifiedNode = { id: 'header_row', role: 'row', children: [headerOrderNo, headerAction] };
    const orderCell: UnifiedNode = { id: 'cell_order_1', role: 'cell', name: 'ORD-2026-001', children: [] };
    const editButton: UnifiedNode = { id: 'edit_button_1', role: 'button', name: '编辑', children: [] };
    const actionCell: UnifiedNode = {
        id: 'cell_action_1',
        role: 'cell',
        children: options.missingRowActionButton ? [] : [editButton],
    };
    const row: UnifiedNode = { id: 'row_1', role: 'row', children: [orderCell, actionCell] };
    const table: UnifiedNode = { id: 'table_main', role: 'table', name: '订单列表', children: [headerRow, row] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [form, table] };

    const entityIndex: EntityIndex = {
        entities: {
            ent_form: { id: 'ent_form', type: 'region', kind: 'form', nodeId: 'form_main', name: '订单表单' },
            ent_table: { id: 'ent_table', type: 'region', kind: 'table', nodeId: 'table_main', name: '订单列表' },
        },
        byNodeId: {
            form_main: [{ type: 'region', entityId: 'ent_form', role: 'container' }],
            table_main: [{ type: 'region', entityId: 'ent_table', role: 'container' }],
            buyer_input: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
            buyer_label: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
            submit_button: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
            edit_button_1: [{ type: 'region', entityId: 'ent_table', role: 'descendant' }],
        },
    };

    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    const bundle = createBundle(options);
    const overlay = applyBusinessEntityRules({
        root,
        entityIndex,
        bundle,
    });
    const snapshot = buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex: {
            buyer_input: { origin: { primaryDomId: 'dom-buyer' } },
            submit_button: { origin: { primaryDomId: 'dom-submit' } },
            edit_button_1: { origin: { primaryDomId: 'dom-edit' } },
        },
        bboxIndex,
        attrIndex,
        contentStore,
        ruleEntityOverlay: overlay,
    });
    const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
        renamedNodes: {},
        addedEntities: [],
        deletedEntities: [],
    });

    return { snapshot, finalEntityView };
};

const createBundle = (options: FixtureOptions): NormalizedEntityRuleBundle => ({
    id: 'test-profile',
    page: {
        kind: 'panel',
    },
    matchRules: [
        {
            ruleId: 'form_main_rule',
            source: 'region',
            expect: 'unique',
            order: 0,
            match: {
                kind: 'form',
                nameContains: '订单表单',
            },
        },
        {
            ruleId: 'buyer_control_rule',
            source: 'node',
            expect: 'unique',
            order: 1,
            within: 'form_main_rule',
            match: options.missingFieldControl
                ? { textContains: '不存在的控件' }
                : { nameContains: '采购人输入' },
        },
        {
            ruleId: 'buyer_label_rule',
            source: 'node',
            expect: 'unique',
            order: 2,
            within: 'form_main_rule',
            match: { nameContains: '采购人' },
        },
        {
            ruleId: 'submit_action_rule',
            source: 'node',
            expect: 'unique',
            order: 3,
            within: 'form_main_rule',
            match: options.missingFormAction
                ? { textContains: '不存在的提交' }
                : { nameContains: '提交' },
        },
        {
            ruleId: 'table_main_rule',
            source: 'region',
            expect: 'unique',
            order: 4,
            match: {
                kind: 'table',
                nameContains: '订单列表',
            },
        },
    ],
    annotationByRuleId: {
        form_main_rule: {
            ruleId: 'form_main_rule',
            businessTag: 'order.form.main',
            fields: [
                {
                    fieldKey: 'buyer',
                    name: '采购人',
                    kind: 'input',
                    controlRuleId: 'buyer_control_rule',
                    labelRuleId: 'buyer_label_rule',
                },
                ...(options.duplicateMissingFieldControl
                    ? [
                        {
                            fieldKey: 'buyer',
                            name: '采购人',
                            kind: 'input' as const,
                            controlRuleId: 'buyer_control_rule',
                            labelRuleId: 'buyer_label_rule',
                        },
                    ]
                    : []),
            ],
            actions: [
                {
                    actionIntent: 'submit',
                    text: '提交',
                    nodeRuleId: 'submit_action_rule',
                },
            ],
        },
        table_main_rule: {
            ruleId: 'table_main_rule',
            businessTag: 'order.table.main',
            primaryKey: {
                fieldKey: 'orderNo',
                columns: ['订单编号'],
                source: 'annotation',
            },
            columns: [
                {
                    fieldKey: 'orderNo',
                    name: '订单编号',
                    kind: 'text',
                    source: 'annotation',
                },
                {
                    fieldKey: 'operation',
                    name: options.unresolvedTableHeader ? '操作列未命中' : '操作',
                    kind: 'action_column',
                    source: 'annotation',
                    actions: [
                        {
                            actionIntent: 'edit',
                            text: '编辑',
                        },
                    ],
                },
            ],
        },
    },
});

const findDiagnostic = (diagnostics: EntityRuleDiagnostic[] | undefined, code: EntityRuleDiagnostic['code']) =>
    (diagnostics || []).find((item) => item.code === code);

test('field control rule unresolved is exposed on finalEntityView diagnostics', () => {
    const { finalEntityView } = createFixture({ missingFieldControl: true });
    const diagnostic = findDiagnostic(finalEntityView.diagnostics, 'FIELD_CONTROL_UNRESOLVED');
    assert.ok(diagnostic);
    assert.equal(diagnostic.level, 'warning');
    assert.equal(diagnostic.businessTag, 'order.form.main');
    assert.equal(diagnostic.fieldKey, 'buyer');
});

test('form action unresolved is exposed on finalEntityView diagnostics', () => {
    const { finalEntityView } = createFixture({ missingFormAction: true });
    const diagnostic = findDiagnostic(finalEntityView.diagnostics, 'FORM_ACTION_UNRESOLVED');
    assert.ok(diagnostic);
    assert.equal(diagnostic.level, 'warning');
    assert.equal(diagnostic.businessTag, 'order.form.main');
    assert.equal(diagnostic.actionIntent, 'submit');
});

test('table column header unresolved is exposed on finalEntityView diagnostics', () => {
    const { finalEntityView } = createFixture({ unresolvedTableHeader: true });
    const diagnostic = findDiagnostic(finalEntityView.diagnostics, 'TABLE_COLUMN_HEADER_UNRESOLVED');
    assert.ok(diagnostic);
    assert.equal(diagnostic.level, 'warning');
    assert.equal(diagnostic.businessTag, 'order.table.main');
});

test('browser.query row action missing primary key returns TABLE_ROW_NOT_FOUND diagnostic details', async () => {
    const { snapshot, finalEntityView } = createFixture();
    const deps = createDeps(snapshot, finalEntityView);
    const step: Step<'browser.query'> = {
        id: 'resolve-missing-row-action',
        name: 'browser.query',
        args: {
            op: 'entity.target',
            businessTag: 'order.table.main',
            target: {
                kind: 'table.row_action',
                primaryKey: {
                    fieldKey: 'orderNo',
                    value: 'ORD-404',
                },
                actionIntent: 'edit',
            },
        },
    };

    const result = await executeBrowserQuery(step, deps, 'ws-diagnostics');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_NOT_FOUND');
    assert.equal((result.error?.details as { diagnostic?: { code?: string } })?.diagnostic?.code, 'TABLE_ROW_NOT_FOUND');
});

test('browser.query row action missing button returns TABLE_ROW_ACTION_NOT_FOUND diagnostic details', async () => {
    const { snapshot, finalEntityView } = createFixture({ missingRowActionButton: true });
    const deps = createDeps(snapshot, finalEntityView);
    const step: Step<'browser.query'> = {
        id: 'resolve-missing-button',
        name: 'browser.query',
        args: {
            op: 'entity.target',
            businessTag: 'order.table.main',
            target: {
                kind: 'table.row_action',
                primaryKey: {
                    fieldKey: 'orderNo',
                    value: 'ORD-2026-001',
                },
                actionIntent: 'edit',
            },
        },
    };

    const result = await executeBrowserQuery(step, deps, 'ws-diagnostics');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_UNRESOLVED_TARGET');
    assert.equal((result.error?.details as { diagnostic?: { code?: string } })?.diagnostic?.code, 'TABLE_ROW_ACTION_NOT_FOUND');
});

test('browser.entity list returns diagnostics summary', async () => {
    const { snapshot, finalEntityView } = createFixture({
        missingFieldControl: true,
        missingFormAction: true,
        unresolvedTableHeader: true,
    });
    const deps = createDeps(snapshot, finalEntityView);
    const step: Step<'browser.entity'> = {
        id: 'entity-list',
        name: 'browser.entity',
        args: { op: 'list' },
    };

    const result = await executeBrowserEntity(step, deps, 'ws-diagnostics');
    assert.equal(result.ok, true);
    const diagnostics = (result.data as { diagnostics: { total: number; byLevel: { warning: number } } }).diagnostics;
    assert.equal(diagnostics.total > 0, true);
    assert.equal(diagnostics.byLevel.warning > 0, true);
});

test('browser.entity get returns entity related diagnostics', async () => {
    const { snapshot, finalEntityView } = createFixture({
        missingFieldControl: true,
        missingFormAction: true,
    });
    const deps = createDeps(snapshot, finalEntityView);
    const step: Step<'browser.entity'> = {
        id: 'entity-get',
        name: 'browser.entity',
        args: { op: 'get', nodeId: 'form_main' },
    };

    const result = await executeBrowserEntity(step, deps, 'ws-diagnostics');
    assert.equal(result.ok, true);
    const diagnostics = (result.data as { diagnostics: EntityRuleDiagnostic[] }).diagnostics;
    assert.equal(diagnostics.some((item) => item.code === 'FIELD_CONTROL_UNRESOLVED'), true);
    assert.equal(diagnostics.some((item) => item.code === 'FORM_ACTION_UNRESOLVED'), true);
});

test('entity rule diagnostics are deduped', () => {
    const { finalEntityView } = createFixture({
        missingFieldControl: true,
        duplicateMissingFieldControl: true,
    });
    const matched = (finalEntityView.diagnostics || []).filter((item) => item.code === 'FIELD_CONTROL_UNRESOLVED');
    assert.equal(matched.length, 1);
});
