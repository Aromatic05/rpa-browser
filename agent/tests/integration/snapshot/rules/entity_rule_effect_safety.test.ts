import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
    buildEntityRuleExportIndex,
    entityRulesArtifactRevision,
    importWorkflowEntityRules,
    validateWorkflowEntityRules,
    type Workflow,
    type WorkflowEntityRules,
} from '../../../../src/automation/workflow';
import {
    createEntityRulesRuntime,
    createWorkspaceEntityRulesProvider,
} from '../../../../src/automation/snapshot/rules/runtime';
import {createDslEntityRulesResolver, linkDsl} from '../../../../src/automation/dsl/link';
import {parseDsl} from '../../../../src/program/dsl/parser';
import type {Action} from '../../../../src/interface/actions/action_protocol';

const ordersProfile = (): WorkflowEntityRules => ({
    kind: 'entity_rules',
    name: 'orders',
    page: {kind: 'table'},
    match: {
        version: 2,
        rules: [
            {ruleId: 'orders-root', source: 'region', expect: 'unique', match: {kind: 'table'}},
            {ruleId: 'order-no', source: 'node', expect: 'unique', within: 'orders-root', match: {nameEquals: 'orderNo'}},
            {ruleId: 'refresh', source: 'node', expect: 'one_or_more', within: 'orders-root', match: {nameEquals: 'refresh'}},
            {ruleId: 'submit', source: 'node', expect: 'one_or_more', within: 'orders-root', match: {nameEquals: 'submit'}},
            {ruleId: 'export', source: 'node', expect: 'one_or_more', within: 'orders-root', match: {nameEquals: 'export'}},
        ],
    },
    annotation: {
        version: 2,
        bindings: [
            {
                ruleId: 'orders-root',
                entityKey: 'orders',
                businessTag: 'orders.table',
                entityKind: 'table',
                displayName: 'Orders',
                primaryKey: {fieldKey: 'orderNo'},
                columns: [{
                    fieldKey: 'orderNo',
                    name: 'Order number',
                    actions: [{actionIntent: 'approve', effect: {reversibility: 'compensatable'}}],
                }],
            },
            {ruleId: 'order-no', fieldKey: 'orderNo', fieldName: 'Order number'},
            {ruleId: 'refresh', actionIntent: 'refresh', actionText: 'Refresh', effect: {reversibility: 'reversible'}},
            {ruleId: 'submit', actionIntent: 'submit', actionText: 'Submit', effect: {reversibility: 'irreversible'}},
            {ruleId: 'export', actionIntent: 'export', actionText: 'Export', effect: {reversibility: 'compensatable'}},
        ],
    },
});

const providerWorkflow = (profile: WorkflowEntityRules): Workflow => ({
    name: 'ws-1',
    save: (artifact) => artifact,
    get: (name) => name === profile.name ? profile : null,
    list: () => [{kind: 'entity_rules', name: profile.name, title: profile.name, createdAt: 0, updatedAt: 0, summary: ''}],
    delete: () => false,
});

test('exports carry independent member effect declarations per business member', () => {
    const result = buildEntityRuleExportIndex(validateWorkflowEntityRules(ordersProfile()));

    assert.deepEqual(result.diagnostics, []);
    const entity = result.index?.entities[0];
    assert.ok(entity);
    assert.deepEqual(entity.fields, [{fieldKey: 'orderNo', targetKind: 'table.filter'}]);
    assert.deepEqual(entity.actions, [
        {actionIntent: 'refresh', targetKind: 'table.module_action', effect: {reversibility: 'reversible'}},
        {actionIntent: 'submit', targetKind: 'table.module_action', effect: {reversibility: 'irreversible'}},
        {actionIntent: 'export', targetKind: 'table.module_action', effect: {reversibility: 'compensatable'}},
    ]);
    assert.deepEqual(entity.rowActions, [
        {actionIntent: 'approve', targetKind: 'table.row_action', effect: {reversibility: 'compensatable'}},
    ]);
    assert.deepEqual(entity.supportedQueries, ['table.currentRows', 'table.rowCount']);
    assert.equal(entity.members.find((member) => member.kind === 'query')?.kind, 'query');
});

test('irreversible, reversible and compensatable effects propagate through DSL link as EffectSemantics', () => {
    const provider = createWorkspaceEntityRulesProvider(providerWorkflow(ordersProfile()));
    const resolver = createDslEntityRulesResolver(provider);
    const linked = linkDsl(parseDsl(`
use entity_rules "orders" as order
click order.orders.refresh
click order.orders.submit
click order.orders.row(input.orderNo).approve
let rows = query order.orders.currentRows
`), resolver);

    assert.deepEqual(linked.diagnostics, []);
    assert.deepEqual((linked.program.body[0] as {effect?: unknown}).effect, {
        reversibility: 'reversible',
        source: {
            kind: 'entity_rules',
            profileName: 'orders',
            entityKey: 'orders',
            memberKind: 'action',
            member: 'refresh',
        },
    });
    assert.deepEqual((linked.program.body[1] as {effect?: unknown}).effect, {
        reversibility: 'irreversible',
        source: {
            kind: 'entity_rules',
            profileName: 'orders',
            entityKey: 'orders',
            memberKind: 'action',
            member: 'submit',
        },
    });
    assert.deepEqual((linked.program.body[2] as {effect?: unknown}).effect, {
        reversibility: 'compensatable',
        source: {
            kind: 'entity_rules',
            profileName: 'orders',
            entityKey: 'orders',
            memberKind: 'rowAction',
            member: 'approve',
        },
    });
    assert.equal((linked.program.body[3] as {expr?: {effect?: unknown}}).expr?.effect, undefined);
});

test('legacy V1 imports keep missing member effects conservative unknown through export and link', () => {
    const imported = importWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-orders',
        match: {
            version: 1,
            page: {kind: 'table', urlPattern: '/orders'},
            entities: [
                {ruleId: 'orders', source: 'region', expect: 'unique', match: {kind: 'table'}},
                {ruleId: 'submit', source: 'node', expect: 'unique', within: 'orders', match: {nameEquals: 'Submit'}},
            ],
        },
        annotation: {
            version: 1,
            page: {kind: 'table'},
            annotations: [
                {ruleId: 'orders', businessTag: 'orders.table', entityKey: 'orders'},
                {ruleId: 'submit', actionIntent: 'submit', actionText: 'Submit'},
            ],
        },
    });

    const exportIndex = buildEntityRuleExportIndex(imported);
    assert.deepEqual(exportIndex.diagnostics, []);
    assert.equal(exportIndex.index?.entities[0]?.actions[0].effect, undefined);

    const provider = createWorkspaceEntityRulesProvider(providerWorkflow(imported));
    const resolver = createDslEntityRulesResolver(provider);
    const linked = linkDsl(parseDsl('use entity_rules "legacy-orders" as order\nclick order.orders.submit\n'), resolver);
    assert.deepEqual(linked.diagnostics, []);
    assert.equal((linked.program.body[0] as {effect?: unknown}).effect, undefined);
});

test('invalid effect reversibility is rejected with an explicit diagnostic', () => {
    const invalid = ordersProfile();
    invalid.annotation.bindings[2].effect = {reversibility: 'probably-safe'};
    assert.throws(
        () => validateWorkflowEntityRules(invalid),
        /effect\.reversibility/,
    );
});

test('entity_rules.save persists member effects and get returns them without loss, preserving CAS', async () => {
    const saved: Array<{artifact: WorkflowEntityRules; expectedRevision: string | null | undefined}> = [];
    const stored = new Map<string, WorkflowEntityRules>();
    const workflow: Workflow = {
        name: 'ws-1',
        save: (artifact, options) => {
            const value = artifact as WorkflowEntityRules;
            saved.push({artifact: value, expectedRevision: options?.expectedRevision});
            stored.set(value.name, value);
            return value;
        },
        get: (name) => stored.get(name) ?? null,
        list: () => [...stored.values()].map((artifact) => ({
            kind: 'entity_rules',
            name: artifact.name,
            title: artifact.name,
            createdAt: 0,
            updatedAt: 0,
            summary: '',
        })),
        delete: () => false,
    };
    const runtime = createEntityRulesRuntime();
    const invoke = async (type: string, payload: Record<string, unknown>) => await runtime.handle({
        action: action(type, payload),
        workspace: {name: 'ws-1', workflow} as never,
        workspaceRegistry: {} as never,
    });

    const profile = ordersProfile();
    const revision = entityRulesArtifactRevision(profile);
    const saveReply = await invoke('entity_rules.save', {
        profileName: profile.name,
        page: profile.page,
        match: profile.match,
        annotation: profile.annotation,
        expectedRevision: revision,
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].expectedRevision, revision);
    assert.deepEqual(saved[0].artifact.annotation.bindings[2].effect, {reversibility: 'reversible'});
    assert.deepEqual(saved[0].artifact.annotation.bindings[3].effect, {reversibility: 'irreversible'});
    assert.equal((saveReply.reply as {payload?: {artifactRevision?: unknown}}).payload?.artifactRevision, entityRulesArtifactRevision(saved[0].artifact));

    const getReply = await invoke('entity_rules.get', {profileName: profile.name});
    const view = (getReply.reply as {payload?: {view?: {entities?: Array<{actions?: Array<Record<string, unknown>>}>}}}).payload?.view;
    const actions = view?.entities?.[0]?.actions ?? [];
    assert.deepEqual(actions.find((item) => item.actionIntent === 'submit')?.effect, {reversibility: 'irreversible'});
    assert.deepEqual(actions.find((item) => item.actionIntent === 'refresh')?.effect, {reversibility: 'reversible'});
});

const action = (type: string, payload: Record<string, unknown>): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName: 'ws-1',
    payload,
});