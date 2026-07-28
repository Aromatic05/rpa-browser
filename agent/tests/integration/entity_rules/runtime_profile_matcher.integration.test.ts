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
    type RawPageCapture,
} from '../../../src/snapshot';
import type { EntityRuleConfig } from '../../../src/config';
import type { Workflow, WorkflowEntityRules } from '../../../src/workflow';
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
    const controls = buildControlSnapshot({ observation, relations, locators }).controls;
    return { observation, relations, locators, controls };
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
