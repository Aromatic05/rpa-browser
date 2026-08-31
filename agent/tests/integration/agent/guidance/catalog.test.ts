import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createLibraryHarness,
    DEMO_ONBOARDING,
    ENSURE_LOGIN_PROCEDURE,
    NESTED_CHECK_PROCEDURE,
    ORDERS_PAGE_PROFILE,
    RENEW_SESSION_RECOVERY,
    SUBMIT_REPORT_AUTOMATION,
} from '../../../helpers/library_harness';
import {createGuidanceCatalog} from '../../../../src/agent/guidance/catalog';
import type {CatalogEntry} from '../../../../src/agent/guidance/contracts';

const catalogId = {kind: 'automation', name: SUBMIT_REPORT_AUTOMATION} as const;

test('catalog exposes bounded entries with per-kind counts and never dumps bodies', async () => {
    const {library} = createLibraryHarness();
    const catalog = createGuidanceCatalog(library);
    const entries = await catalog.list();
    const kinds = [...new Set(entries.map((entry) => entry.kind))].sort();
    assert.deepEqual(kinds, ['automation', 'demonstration', 'page_knowledge', 'procedure', 'recovery']);

    for (const entry of entries) {
        for (const forbidden of ['source', 'body', 'bodyDsl', 'steps', 'content']) {
            assert.equal(Object.hasOwn(entry, forbidden), false, `${entry.kind}:${entry.name} leaked ${forbidden}`);
        }
        assert.equal(JSON.stringify(entry).includes('use entity_rules'), false);
        assert.equal(JSON.stringify(entry).includes('body.dsl'), false);
    }

    const automation = entries.find((entry) => entry.name === SUBMIT_REPORT_AUTOMATION) as CatalogEntry;
    assert.deepEqual(automation.counts, {kind: 'automation', references: 2});

    const nested = entries.find((entry) => entry.name === NESTED_CHECK_PROCEDURE) as CatalogEntry;
    assert.deepEqual(nested.counts, {kind: 'procedure', inputs: 1, outputs: 1});

    const recovery = entries.find((entry) => entry.name === RENEW_SESSION_RECOVERY) as CatalogEntry;
    assert.deepEqual(recovery.counts, {kind: 'recovery', triggerRules: 2, maxAttempts: 2});

    const demo = entries.find((entry) => entry.name === DEMO_ONBOARDING) as CatalogEntry;
    assert.deepEqual(demo.counts, {kind: 'demonstration', steps: 2});

    const page = entries.find((entry) => entry.name === ORDERS_PAGE_PROFILE) as CatalogEntry;
    assert.deepEqual(page.counts, {kind: 'page_knowledge', entities: 1, fields: 1, actions: 1});
    assert.deepEqual(page.applicability, {kind: 'table', urlPattern: '^https://example\\.test/orders'});
});

test('explicit loadBody returns only the selected asset body', async () => {
    const {library} = createLibraryHarness();
    const catalog = createGuidanceCatalog(library);

    const automation = await catalog.loadBody(catalogId);
    assert.equal(automation.status, 'loaded');
    if (automation.status === 'loaded') {
        assert.equal(automation.kind, 'automation');
        assert.equal(automation.name, SUBMIT_REPORT_AUTOMATION);
        assert.ok(automation.source.includes('use checkpoint'));
    }

    const procedure = await catalog.loadBody({kind: 'procedure', name: ENSURE_LOGIN_PROCEDURE});
    assert.equal(procedure.status, 'loaded');
    if (procedure.status === 'loaded') {
        assert.equal(procedure.kind, 'procedure');
        assert.equal(procedure.body.includes('use entity_rules'), true);
    }

    const demo = await catalog.loadBody({kind: 'demonstration', name: DEMO_ONBOARDING});
    assert.equal(demo.status, 'loaded');
    if (demo.status === 'loaded') {
        assert.equal(demo.kind, 'demonstration');
        assert.equal((demo.steps as unknown[]).length, 2);
    }

    const page = await catalog.loadBody({kind: 'page_knowledge', name: ORDERS_PAGE_PROFILE});
    assert.deepEqual(page, {status: 'unsupported', kind: 'page_knowledge', name: ORDERS_PAGE_PROFILE});

    const recovery = await catalog.loadBody({kind: 'recovery', name: RENEW_SESSION_RECOVERY});
    assert.deepEqual(recovery, {status: 'unsupported', kind: 'recovery', name: RENEW_SESSION_RECOVERY});

    const missing = await catalog.loadBody({kind: 'automation', name: 'not-there'});
    assert.deepEqual(missing, {status: 'not_found', kind: 'automation', name: 'not-there'});

    const entries = await catalog.list();
    for (const entry of entries) {
        assert.equal(Object.hasOwn(entry, 'source'), false);
        assert.equal(Object.hasOwn(entry, 'steps'), false);
    }
});

test('bounded catalog caps result sizes and is deterministically ordered', async () => {
    const {library, workflow} = createLibraryHarness();
    for (const name of ['extra-a', 'extra-b', 'extra-c']) {
        workflow.save({kind: 'dsl', name, content: 'output value = input.value', stepResolves: {}});
    }
    const catalog = createGuidanceCatalog(library);

    const capped = await catalog.list({kind: 'automation', limit: 2});
    assert.equal(capped.length, 2);

    const all = await catalog.list({kind: 'automation'});
    assert.deepEqual(all.map((entry) => entry.name), ['extra-a', 'extra-b', 'extra-c', SUBMIT_REPORT_AUTOMATION].sort());
    assert.deepEqual(all.map((entry) => entry.name), all.map((entry) => entry.name));
});

test('catalog health surfaces evidence states only after explicit validation', async () => {
    const {library} = createLibraryHarness();
    const catalog = createGuidanceCatalog(library);
    assert.equal(await catalog.health(catalogId), 'unknown');

    const evidence = await catalog.validate(catalogId);
    assert.equal(evidence.outcome, 'ready');
    assert.equal(await catalog.health(catalogId), 'ready');

    const entry = await catalog.entry(catalogId);
    assert.ok(entry);
    assert.equal(entry.health, 'ready');
});