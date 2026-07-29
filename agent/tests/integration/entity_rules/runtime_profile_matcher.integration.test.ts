import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    buildTableSnapshot,
    executeEntityRules,
    type RawCapturedNode,
    PageSnapshotSessionStore,
    type RawPageCapture,
} from '../../../src/snapshot';
import type { EntityRuleConfig } from '../../../src/config';
import {importWorkflowEntityRules, type Workflow, type WorkflowEntityRules} from '../../../src/workflow';
import {queryPageSessionBusinessEntity, resolvePageSessionBusinessTarget} from '../../../src/runner/session/entity_view';
import { createEntityRulesRuntime, createWorkspaceEntityRulesProvider } from '../../../src/snapshot/rules/runtime';

const config: EntityRuleConfig = {
    enabled: false,
    rootDir: '.rpa/entity_rules',
    selection: 'disabled',
    profiles: [],
    strict: true,
};

const active = () => ({ hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true });

const node = (
    captureId: string,
    tag: string,
    parentCaptureId: string | undefined,
    childCaptureIds: string[],
    attributes: Record<string, string> = {},
    ownText?: string,
): RawCapturedNode => ({
    captureId,
    scopeId: 'main',
    parentCaptureId,
    childCaptureIds,
    tag,
    attributes,
    ownText,
    activity: active(),
});

const capture = (pageEpoch: string, nodes: RawCapturedNode[]): RawPageCapture => {
    const completeness = { dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete' } as const;
    return {
        identity: { pageEpoch, captureRevision: 1 },
        metadata: { schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-29T00:00:00.000Z' },
        completeness,
        scopes: [{ id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness }],
        nodes,
        accessibility: [],
        runtimeState: {},
        diagnostics: [],
    };
};

const buildBase = (raw: RawPageCapture) => {
    const observation = buildPageObservation(raw);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const control = buildControlSnapshot({ observation, relations, locators });
    return { observation, relations, locators, controls: control.controls, control };
};

const formSnapshot = () => {
    const base = buildBase(capture('entity-rules-form', [
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['form']),
        node('form', 'form', 'body', ['label', 'input', 'submit'], { id: 'OrderForm', 'aria-label': 'Order form' }),
        node('label', 'label', 'form', [], { for: 'Buyer' }, 'Buyer'),
        node('input', 'input', 'form', [], { id: 'Buyer', type: 'text' }),
        node('submit', 'button', 'form', [], { class: 'ant-btn', type: 'submit' }, 'Save order'),
    ]));
    return buildFormSnapshot(base);
};

const tableSnapshot = () => {
    const base = buildBase(capture('entity-rules-table', [
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['card']),
        node('card', 'section', 'body', ['table', 'pager'], { class: 'panel' }),
        node('table', 'table', 'card', ['thead', 'tbody'], { id: 'Orders' }),
        node('thead', 'thead', 'table', ['head-row']),
        node('head-row', 'tr', 'thead', ['head-name', 'head-action']),
        node('head-name', 'th', 'head-row', [], {}, 'Name'),
        node('head-action', 'th', 'head-row', [], {}, 'Actions'),
        node('tbody', 'tbody', 'table', ['row-a', 'row-b']),
        node('row-a', 'tr', 'tbody', ['cell-name-a', 'cell-action-a']),
        node('cell-name-a', 'td', 'row-a', [], {}, 'Alice'),
        node('cell-action-a', 'td', 'row-a', ['edit-a']),
        node('edit-a', 'button', 'cell-action-a', [], { class: 'edit-button' }, 'Edit'),
        node('row-b', 'tr', 'tbody', ['cell-name-b', 'cell-action-b']),
        node('cell-name-b', 'td', 'row-b', [], {}, 'Bob'),
        node('cell-action-b', 'td', 'row-b', ['edit-b']),
        node('edit-b', 'button', 'cell-action-b', [], { class: 'edit-button' }, 'Edit'),
        node('pager', 'nav', 'card', ['next'], { class: 'ant-pagination', 'aria-label': 'pagination' }),
        node('next', 'button', 'pager', [], { class: 'ant-pagination-next' }, 'Next'),
    ]));
    return buildTableSnapshot(base);
};

const workflowWithProfiles = (...profiles: WorkflowEntityRules[]): Workflow => {
    const byName = new Map(profiles.map((profile) => [profile.name, profile]));
    return {
        name: 'runtime-profile-matcher',
        save: (artifact) => artifact,
        get: (name, dummy) => dummy.kind === 'entity_rules' ? byName.get(name) ?? null : null,
        list: (dummy) => dummy.kind === 'entity_rules'
            ? profiles.map((profile, index) => ({
                  kind: 'entity_rules' as const,
                  name: profile.name,
                  title: profile.name,
                  createdAt: index + 1,
                  updatedAt: index + 1,
                  summary: 'entity_rules',
                  enabled: true,
              }))
            : [],
        delete: () => false,
    };
};

const profile = (
    name: string,
    rules: WorkflowEntityRules['match']['rules'],
    bindings: WorkflowEntityRules['annotation']['bindings'],
): WorkflowEntityRules => ({
    kind: 'entity_rules',
    name,
    match: { version: 2, rules },
    annotation: { version: 2, bindings },
});

const explicit = (profiles: string[]) => ({
    selection: 'explicit' as const,
    profiles,
    strict: true,
});

test('runtime executes a selected form profile and keeps annotations attached to canonical bindings', () => {
    const rules = profile('order-form', [
        { ruleId: 'form-root', source: 'region', expect: 'unique', match: { kind: 'form', idEquals: 'OrderForm' } },
        { ruleId: 'submit', source: 'node', expect: 'unique', within: 'form-root', match: { classContains: 'ant-btn', textContains: 'Save order' } },
    ], [
        { ruleId: 'form-root', businessTag: 'order-form' },
        { ruleId: 'submit', actionIntent: 'submit' },
    ]);
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(rules));
    const snapshot = formSnapshot();

    const result = createEntityRulesRuntime().execute({
        control: explicit(['order-form']),
        config,
        provider,
        snapshots: { form: snapshot },
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.ok, true);
    assert.equal(result.profiles['order-form'].domain, 'form');
    assert.equal(result.profiles['order-form'].bindings['form-root'].matchedComponentIds.length, 1);
    assert.deepEqual(
        result.profiles['order-form'].bindings.submit.matchedNodeIds,
        [snapshot.observation.captureIdToNodeId.submit],
    );
    assert.equal(result.profiles['order-form'].bindings.submit.annotation?.actionIntent, 'submit');
    const formId = result.profiles['order-form'].bindings['form-root'].matchedComponentIds[0];
    const submitNodeId = snapshot.observation.captureIdToNodeId.submit;
    assert.equal(result.profiles['order-form'].semanticBindings.forms[formId]?.annotation.businessTag, 'order-form');
    assert.equal(
        result.profiles['order-form'].semanticBindings.nodes[submitNodeId]
            ?.some((binding) => binding.annotation.actionIntent === 'submit'),
        true,
    );
    assert.equal(
        result.profiles['order-form'].semanticSuggestions.items
            .some((suggestion) => suggestion.kind === 'action-intent' && suggestion.source === 'inferred'),
        true,
    );
    assert.equal(Object.isFrozen(rules.annotation.bindings[1]), false);
});

test('runtime executes table profiles through TableComponent and typed pagination ownership', () => {
    const rules = profile('orders', [
        { ruleId: 'table-root', source: 'region', expect: 'unique', match: {
            kind: 'table',
            idEquals: 'Orders',
            keyHint: { headerContainsAll: ['Name', 'Actions'], primaryKeyCandidatesContains: ['Name'] },
        } },
        {
            ruleId: 'next-page',
            source: 'node',
            expect: 'unique',
            match: { relation: 'pagination', classContains: 'ant-pagination-next' },
        },
    ], [
        { ruleId: 'table-root', businessTag: 'orders' },
        { ruleId: 'next-page', actionIntent: 'next-page' },
    ]);
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(rules));
    const snapshot = tableSnapshot();

    const result = executeEntityRules({
        control: explicit(['orders']),
        config,
        provider,
        snapshots: { table: snapshot },
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.ok, true);
    assert.equal(result.profiles.orders.domain, 'table');
    assert.equal(result.profiles.orders.bindings['table-root'].matchedComponentIds.length, 1);
    assert.deepEqual(
        result.profiles.orders.bindings['next-page'].matchedNodeIds,
        [snapshot.observation.captureIdToNodeId.next],
    );
    assert.equal(result.profiles.orders.bindings['next-page'].annotation?.actionIntent, 'next-page');
    const tableId = result.profiles.orders.bindings['table-root'].matchedComponentIds[0];
    assert.equal(result.profiles.orders.semanticBindings.tables[tableId]?.annotation.businessTag, 'orders');
});


test('runtime invalidates inferred annotations that claim protected business semantics', () => {
    const rules = profile('unsafe-inferred', [
        { ruleId: 'form-root', source: 'region', expect: 'unique', match: { kind: 'form', idEquals: 'OrderForm' } },
    ], [
        { ruleId: 'form-root', origin: 'inferred', fieldKey: 'order' },
    ]);
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(rules));
    const result = executeEntityRules({
        control: explicit(['unsafe-inferred']),
        config,
        provider,
        snapshots: {form: formSnapshot()},
    });

    assert.equal(result.status, 'invalid');
    assert.equal(result.ok, false);
    assert.equal(result.profiles['unsafe-inferred'].semanticBindings.byId['unsafe-inferred:form-root'].status, 'invalidated');
    assert.equal(
        result.diagnostics.some((diagnostic) => diagnostic.code === 'semantic-binding.inferred.protected-key'),
        true,
    );
});

test('runtime rejects mixed-domain and unsupported profile conditions instead of silently ignoring them', () => {
    const mixed = profile('mixed', [
        { ruleId: 'form-root', source: 'region', expect: 'unique', match: { kind: 'form' } },
        { ruleId: 'table-root', source: 'region', expect: 'unique', match: { kind: 'table' } },
    ], []);
    const unsupported = profile('unsupported', [
        { ruleId: 'form-root', source: 'region', expect: 'unique', match: { kind: 'form', unknownCondition: 'x' } },
    ], []);
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(mixed, unsupported));

    const result = executeEntityRules({
        control: explicit(['mixed', 'unsupported']),
        config,
        provider,
        snapshots: { form: formSnapshot(), table: tableSnapshot() },
    });

    assert.equal(result.status, 'invalid');
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === 'query-plan.domain.mixed'), true);
    assert.equal(result.diagnostics.some((item) => item.code === 'query-plan.match.unsupported'), true);
});


test('workspace runtime captures one real page and executes selected form and table profiles', async () => {
    const formRules = profile('live-form', [
        { ruleId: 'form-root', source: 'region', expect: 'unique', match: { kind: 'form', idEquals: 'LiveForm' } },
        { ruleId: 'submit', source: 'node', expect: 'unique', within: 'form-root', match: { idEquals: 'LiveSubmit' } },
    ], [{ ruleId: 'submit', actionIntent: 'submit' }]);
    const tableRules = profile('live-table', [
        { ruleId: 'table-root', source: 'region', expect: 'unique', match: { kind: 'table', idEquals: 'LiveTable' } },
    ], [{ ruleId: 'table-root', businessTag: 'live-table' }]);
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(formRules, tableRules));
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <form id="LiveForm" aria-label="Live form">
            <label for="LiveName">Name</label>
            <input id="LiveName" />
            <button id="LiveSubmit" type="submit">Save</button>
          </form>
          <table id="LiveTable">
            <thead><tr><th>Name</th></tr></thead>
            <tbody><tr><td>Alice</td></tr><tr><td>Bob</td></tr></tbody>
          </table>
        `);
        const result = await createEntityRulesRuntime().executePage(page, {
            control: explicit(['live-form', 'live-table']),
            config,
            provider,
        });

        assert.equal(result.status, 'ready');
        assert.equal(result.ok, true);
        assert.equal(result.profiles['live-form'].bindings.submit.ok, true);
        assert.equal(result.profiles['live-table'].bindings['table-root'].ok, true);
    } finally {
        await browser.close();
    }
});

test('disabled workspace runtime returns without touching the browser page', async () => {
    const untouchedPage = new Proxy({}, {
        get: () => {throw new Error('disabled entity_rules touched the page');},
    }) as unknown as Page;
    const result = await createEntityRulesRuntime().executePage(untouchedPage, {
        control: { selection: 'disabled' },
        config,
        provider: null,
    });

    assert.equal(result.status, 'disabled');
    assert.equal(result.ok, true);
    assert.deepEqual(result.selectedProfiles, []);
});


test('auto selection filters profiles by preserved page URL applicability', () => {
    const orders = {
        ...profile('orders-url', [
            {ruleId: 'orders-root', source: 'region', expect: 'unique', match: {kind: 'table'}},
        ], [{ruleId: 'orders-root', businessTag: 'orders'}]),
        page: {kind: 'table' as const, urlPattern: '/orders(?:\\?|$)'},
    };
    const users = {
        ...profile('users-url', [
            {ruleId: 'users-root', source: 'region', expect: 'unique', match: {kind: 'table'}},
        ], [{ruleId: 'users-root', businessTag: 'users'}]),
        page: {kind: 'table' as const, urlPattern: '/users(?:\\?|$)'},
    };
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(orders, users));
    const table = tableSnapshot();
    const result = executeEntityRules({
        control: {selection: 'auto', strict: true},
        config,
        provider,
        pageUrl: 'https://example.test/orders?page=1',
        snapshots: {table},
    });
    assert.deepEqual(result.selectedProfiles, ['orders-url']);
    assert.deepEqual(Object.keys(result.profiles), ['orders-url']);
});

test('generic dialog profiles execute against canonical observation nodes', () => {
    const base = buildBase(capture('entity-rules-dialog', [
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['dialog']),
        node('dialog', 'div', 'body', ['confirm'], {role: 'dialog', 'aria-label': 'Confirm order'}),
        node('confirm', 'button', 'dialog', [], {id: 'ConfirmOrder'}, 'Confirm'),
    ]));
    const rules: WorkflowEntityRules = {
        ...profile('confirm-dialog', [
            {
                ruleId: 'dialog-root',
                source: 'node',
                expect: 'unique',
                match: {kind: 'dialog', roleEquals: 'dialog', nameContains: 'Confirm order'},
            },
            {
                ruleId: 'confirm-action',
                source: 'node',
                expect: 'unique',
                within: 'dialog-root',
                match: {idEquals: 'ConfirmOrder'},
            },
        ], [
            {ruleId: 'dialog-root', businessTag: 'order.confirm', entityKind: 'dialog'},
            {ruleId: 'confirm-action', actionIntent: 'confirm'},
        ]),
        page: {kind: 'dialog', urlPattern: '/orders'},
    };
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(rules));
    const result = executeEntityRules({
        control: explicit(['confirm-dialog']),
        config,
        provider,
        pageUrl: 'https://example.test/orders',
        snapshots: {control: base.control},
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.ok, true);
    assert.equal(result.profiles['confirm-dialog'].domain, 'node');
    assert.deepEqual(
        result.profiles['confirm-dialog'].bindings['dialog-root'].matchedNodeIds,
        [base.observation.captureIdToNodeId.dialog],
    );
    assert.equal(
        result.profiles['confirm-dialog'].semanticBindings.nodes[base.observation.captureIdToNodeId.dialog]?.[0]
            ?.annotation.businessTag,
        'order.confirm',
    );
});


test('legacy form fields and actions remain executable after V2 import', async () => {
    const imported = importWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-form-runtime',
        match: {
            version: 1,
            page: {kind: 'form', urlPattern: '/orders'},
            entities: [
                {ruleId: 'form-root', source: 'region', expect: 'unique', match: {kind: 'form', idEquals: 'OrderForm'}},
                {ruleId: 'buyer-control', source: 'node', expect: 'unique', within: 'form-root', match: {idEquals: 'Buyer'}},
                {ruleId: 'submit-control', source: 'node', expect: 'unique', within: 'form-root', match: {classContains: 'ant-btn'}},
            ],
        },
        annotation: {
            version: 1,
            page: {kind: 'form'},
            annotations: [{
                ruleId: 'form-root',
                businessTag: 'order.form.legacy',
                businessName: 'Legacy order form',
                fields: [{fieldKey: 'buyer', name: 'Buyer', kind: 'input', controlRuleId: 'buyer-control'}],
                actions: [{actionIntent: 'submit', text: 'Save order', nodeRuleId: 'submit-control'}],
            }],
        },
    });
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(imported));
    const form = formSnapshot();
    const control = {
        observation: form.observation,
        relations: form.relations,
        locators: form.locators,
        controls: form.controls,
    };
    const table = buildTableSnapshot(control);
    const entityRules = executeEntityRules({
        control: explicit([imported.name]),
        config,
        provider,
        pageUrl: 'https://example.test/orders',
        snapshots: {control, form, table},
    });
    assert.equal(entityRules.ok, true, JSON.stringify(entityRules.diagnostics));
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: 'https://example.test/orders',
        capture: async () => ({control, form, table, entityRules}),
    });
    const fields = queryPageSessionBusinessEntity(entry, 'order.form.legacy', 'form.fields');
    assert.equal(fields.ok, true);
    if (fields.ok) {
        assert.equal((fields.data.value as Array<{fieldKey: string}>)[0]?.fieldKey, 'buyer');
    }
    const buyer = resolvePageSessionBusinessTarget(entry, 'order.form.legacy', {
        kind: 'form.field',
        fieldKey: 'buyer',
    });
    assert.equal(buyer.ok, true);
    if (buyer.ok) {assert.equal(buyer.data.nodeId, form.observation.captureIdToNodeId.input);}
    const submit = resolvePageSessionBusinessTarget(entry, 'order.form.legacy', {
        kind: 'form.action',
        actionIntent: 'submit',
    });
    assert.equal(submit.ok, true);
    if (submit.ok) {assert.equal(submit.data.nodeId, form.observation.captureIdToNodeId.submit);}
});


test('all V1 generic entity kinds execute through the canonical node domain', () => {
    const base = buildBase(capture('entity-rules-generic-kinds', [
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['dialog', 'list', 'panel', 'toolbar', 'kv']),
        node('dialog', 'dialog', 'body', [], {'aria-label': 'Confirm'}),
        node('list', 'ul', 'body', [], {role: 'list', 'aria-label': 'Tasks'}),
        node('panel', 'section', 'body', [], {role: 'region', 'aria-label': 'Summary'}),
        node('toolbar', 'div', 'body', [], {role: 'toolbar', 'aria-label': 'Actions'}),
        node('kv', 'dl', 'body', [], {id: 'Details'}),
    ]));
    const kinds = [
        ['dialog', 'dialog', 'Confirm'],
        ['list', 'list', 'Tasks'],
        ['panel', 'region', 'Summary'],
        ['toolbar', 'toolbar', 'Actions'],
        ['kv', undefined, undefined],
    ] as const;
    for (const [kind, roleEquals, nameContains] of kinds) {
        const match: Record<string, unknown> = {kind};
        if (roleEquals) {match.roleEquals = roleEquals;}
        if (nameContains) {match.nameContains = nameContains;}
        if (kind === 'kv') {match.idEquals = 'Details';}
        const rules: WorkflowEntityRules = {
            kind: 'entity_rules',
            name: `generic-${kind}`,
            page: {kind, urlPattern: '/generic'},
            match: {
                version: 2,
                rules: [{ruleId: `${kind}-root`, source: 'node', expect: 'unique', match}],
            },
            annotation: {
                version: 2,
                bindings: [{ruleId: `${kind}-root`, businessTag: `generic.${kind}`, entityKind: kind}],
            },
        };
        const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(rules));
        const result = executeEntityRules({
            control: explicit([rules.name]),
            config,
            provider,
            pageUrl: 'https://example.test/generic',
            snapshots: {control: base.control},
        });
        assert.equal(result.ok, true, `${kind}: ${JSON.stringify(result.diagnostics)}`);
        assert.equal(result.profiles[rules.name].domain, 'node');
        assert.deepEqual(
            result.profiles[rules.name].bindings[`${kind}-root`].matchedNodeIds,
            [base.observation.captureIdToNodeId[kind]],
        );
    }
});

test('legacy table metadata, row actions and explicit pagination remain executable after V2 import', async () => {
    const base = buildBase(capture('entity-rules-legacy-table', [
        node('html', 'html', undefined, ['body']),
        node('body', 'body', 'html', ['table', 'next']),
        node('table', 'table', 'body', ['thead', 'tbody'], {id: 'LegacyOrders'}),
        node('thead', 'thead', 'table', ['head-row']),
        node('head-row', 'tr', 'thead', ['head-order', 'head-action']),
        node('head-order', 'th', 'head-row', [], {}, '订单编号'),
        node('head-action', 'th', 'head-row', [], {}, '操作'),
        node('tbody', 'tbody', 'table', ['row']),
        node('row', 'tr', 'tbody', ['order-cell', 'action-cell']),
        node('order-cell', 'td', 'row', [], {}, 'A-1'),
        node('action-cell', 'td', 'row', ['approve']),
        node('approve', 'button', 'action-cell', [], {id: 'ApproveA1'}, '审核'),
        node('next', 'button', 'body', [], {id: 'NextLegacy'}, '下一页'),
    ]));
    const form = buildFormSnapshot(base);
    const table = buildTableSnapshot(base);
    const imported = importWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-table-runtime',
        match: {
            version: 1,
            page: {kind: 'table', urlPattern: '/orders'},
            entities: [
                {ruleId: 'table-root', source: 'region', expect: 'unique', match: {kind: 'table', idEquals: 'LegacyOrders'}},
                {ruleId: 'approve-action', source: 'node', expect: 'unique', within: 'table-root', match: {idEquals: 'ApproveA1'}},
                {ruleId: 'next-action', source: 'node', expect: 'unique', match: {idEquals: 'NextLegacy'}},
            ],
        },
        annotation: {
            version: 1,
            page: {kind: 'table'},
            annotations: [{
                ruleId: 'table-root',
                businessTag: 'order.table.legacy',
                businessName: 'Legacy orders',
                primaryKey: {fieldKey: 'orderNo', columns: ['订单编号']},
                columns: [
                    {fieldKey: 'orderNo', name: '订单编号', kind: 'text'},
                    {
                        fieldKey: 'operation',
                        name: '操作',
                        kind: 'action_column',
                        actions: [{actionIntent: 'approve', text: '审核'}],
                    },
                ],
                pagination: {
                    nextAction: {actionIntent: 'next_page', nodeRuleId: 'next-action'},
                },
            }],
        },
    });
    const provider = createWorkspaceEntityRulesProvider(workflowWithProfiles(imported));
    const entityRules = executeEntityRules({
        control: explicit([imported.name]),
        config,
        provider,
        pageUrl: 'https://example.test/orders',
        snapshots: {control: base.control, form, table},
    });
    assert.equal(entityRules.ok, true, JSON.stringify(entityRules.diagnostics));
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: 'https://example.test/orders',
        capture: async () => ({control: base.control, form, table, entityRules}),
    });

    const primaryKey = queryPageSessionBusinessEntity(entry, 'order.table.legacy', 'table.primaryKey');
    assert.equal(primaryKey.ok, true);
    if (primaryKey.ok) {
        assert.deepEqual(primaryKey.data.value, {fieldKey: 'orderNo', columns: ['订单编号']});
    }
    const row = resolvePageSessionBusinessTarget(entry, 'order.table.legacy', {
        kind: 'table.row',
        primaryKey: {fieldKey: 'orderNo', value: 'A-1'},
    });
    assert.equal(row.ok, true);
    if (row.ok) {assert.equal(row.data.nodeId, base.observation.captureIdToNodeId.row);}
    const approve = resolvePageSessionBusinessTarget(entry, 'order.table.legacy', {
        kind: 'table.row_action',
        primaryKey: {fieldKey: 'orderNo', value: 'A-1'},
        actionIntent: 'approve',
    });
    assert.equal(approve.ok, true);
    if (approve.ok) {assert.equal(approve.data.nodeId, base.observation.captureIdToNodeId.approve);}
    const hasNext = queryPageSessionBusinessEntity(entry, 'order.table.legacy', 'table.hasNextPage');
    assert.equal(hasNext.ok, true);
    if (hasNext.ok) {assert.equal(hasNext.data.value, true);}
    const next = queryPageSessionBusinessEntity(entry, 'order.table.legacy', 'table.nextPageTarget');
    assert.equal(next.ok, true);
    if (next.ok) {assert.equal(next.data.nodeId, base.observation.captureIdToNodeId.next);}
});
