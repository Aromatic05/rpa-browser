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
import {LIBRARY_ASSET_KINDS} from '../../../../src/agent/library/contracts';
import type {
    AutomationSummary,
    DemonstrationSummary,
    PageKnowledgeSummary,
    ProcedureSummary,
    RecoverySummary,
} from '../../../../src/agent/library/contracts';

const automationId = {kind: 'automation', name: SUBMIT_REPORT_AUTOMATION} as const;

test('library lists exactly the five product asset kinds and never a Step asset', async () => {
    const {library} = createLibraryHarness();
    const listed = await library.list();
    const kinds = [...new Set(listed.map((item) => item.kind))].sort();
    assert.deepEqual(kinds, [...LIBRARY_ASSET_KINDS].sort());
    for (const item of listed) {
        assert.equal(Object.hasOwn(item, 'steps'), false);
    }
    assert.deepEqual(listed.filter((item) => item.kind === 'automation').map((item) => item.name), [SUBMIT_REPORT_AUTOMATION]);
    assert.deepEqual(listed.filter((item) => item.kind === 'procedure').map((item) => item.name), [
        ENSURE_LOGIN_PROCEDURE,
        NESTED_CHECK_PROCEDURE,
    ]);
    assert.deepEqual(listed.filter((item) => item.kind === 'recovery').map((item) => item.name), [RENEW_SESSION_RECOVERY]);
    assert.deepEqual(listed.filter((item) => item.kind === 'demonstration').map((item) => item.name), [DEMO_ONBOARDING]);
    assert.deepEqual(listed.filter((item) => item.kind === 'page_knowledge').map((item) => item.name), [ORDERS_PAGE_PROFILE]);
});

test('dependency DAG includes nested Procedures and Page Knowledge references', async () => {
    const {library} = createLibraryHarness();
    const automation = await library.summary(automationId);
    assert.ok(automation && automation.kind === 'automation');
    assert.deepEqual(automation.dependencies, [
        {kind: 'procedure', name: NESTED_CHECK_PROCEDURE},
        {kind: 'page_knowledge', name: ORDERS_PAGE_PROFILE},
    ]);

    const nested = await library.summary({kind: 'procedure', name: NESTED_CHECK_PROCEDURE});
    assert.ok(nested && nested.kind === 'procedure');
    assert.deepEqual(nested.dependencies, [
        {kind: 'procedure', name: ENSURE_LOGIN_PROCEDURE},
        {kind: 'page_knowledge', name: ORDERS_PAGE_PROFILE},
    ]);

    const login = await library.summary({kind: 'procedure', name: ENSURE_LOGIN_PROCEDURE});
    assert.ok(login && login.kind === 'procedure');
    assert.deepEqual(login.dependencies, [{kind: 'page_knowledge', name: ORDERS_PAGE_PROFILE}]);
});

test('summaries are sanitized and never expose raw DSL, bodies, steps, selectors or query plans', async () => {
    const {library} = createLibraryHarness();
    const listed = await library.list();
    for (const item of listed) {
        for (const forbidden of ['content', 'source', 'bodyDsl', 'stepResolves', 'match', 'annotation']) {
            assert.equal(Object.hasOwn(item, forbidden), false, `${item.kind}:${item.name} leaked ${forbidden}`);
        }
        const serialized = JSON.stringify(item);
        for (const forbiddenText of ['use entity_rules', 'use checkpoint', 'body.dsl', '.dsl', 'selector']) {
            assert.equal(serialized.includes(forbiddenText), false, `${item.kind}:${item.name} leaked ${forbiddenText}`);
        }
    }
});

test('procedure summary exposes declared inputs/outputs; recovery exposes sanitized trigger and policy', async () => {
    const {library} = createLibraryHarness();
    const nested = await library.summary({kind: 'procedure', name: NESTED_CHECK_PROCEDURE});
    assert.ok(nested && nested.kind === 'procedure');
    assert.deepEqual((nested as ProcedureSummary).inputs, ['orderNo']);
    assert.deepEqual((nested as ProcedureSummary).outputs, ['handled']);

    const recovery = await library.summary({kind: 'recovery', name: RENEW_SESSION_RECOVERY});
    assert.ok(recovery && recovery.kind === 'recovery');
    assert.deepEqual((recovery as RecoverySummary).triggerSummary, {
        rules: ['errorCode', 'stepName'],
        entityRules: false,
    });
    assert.deepEqual((recovery as RecoverySummary).policySummary, {
        maxAttempts: 2,
        retryOriginal: true,
    });
});

test('demonstration summary exposes page scope, step count, replayability and is never a Step asset', async () => {
    const {library} = createLibraryHarness();
    const demo = await library.summary({kind: 'demonstration', name: DEMO_ONBOARDING});
    assert.ok(demo && demo.kind === 'demonstration');
    assert.deepEqual((demo as DemonstrationSummary).pageScope, ['Orders']);
    assert.equal((demo as DemonstrationSummary).stepCount, 2);
    assert.equal((demo as DemonstrationSummary).replayable, true);
    assert.equal((demo as DemonstrationSummary).dependencies.length, 0);
});

test('page knowledge summary exposes applicability, entity count and safe semantic counts', async () => {
    const {library} = createLibraryHarness();
    const page = await library.summary({kind: 'page_knowledge', name: ORDERS_PAGE_PROFILE});
    assert.ok(page && page.kind === 'page_knowledge');
    const summary = page as PageKnowledgeSummary;
    assert.deepEqual(summary.applicability, {kind: 'table', urlPattern: '^https://example\\.test/orders'});
    assert.equal(summary.entityCount, 1);
    assert.equal(summary.fieldCount, 1);
    assert.equal(summary.actionCount, 1);
    assert.equal(summary.rowActionCount, 1);
    assert.equal(summary.primaryKey, 'orderNo');
    assert.deepEqual(summary.safety, {
        reversible: 1,
        compensatable: 0,
        irreversible: 1,
        unknown: 1,
    });
});

test('capability flags truthfully reflect the wired Agent knowledge seam', async () => {
    const {library} = createLibraryHarness();
    const automation = await library.summary(automationId);
    assert.ok(automation && automation.kind === 'automation');
    assert.deepEqual((automation as AutomationSummary).capabilities, {
        runtimeApplied: false,
        callableFromDsl: false,
        agentDiscovery: true,
        runnerRecovery: false,
        agentRecovery: false,
        replayable: false,
        modelLoadSeam: false,
    });

    const procedure = await library.summary({kind: 'procedure', name: ENSURE_LOGIN_PROCEDURE});
    assert.ok(procedure && procedure.kind === 'procedure');
    assert.deepEqual((procedure as ProcedureSummary).capabilities, {
        runtimeApplied: false,
        callableFromDsl: true,
        agentDiscovery: true,
        runnerRecovery: false,
        agentRecovery: false,
        replayable: false,
        modelLoadSeam: true,
    });

    const recovery = await library.summary({kind: 'recovery', name: RENEW_SESSION_RECOVERY});
    assert.ok(recovery && recovery.kind === 'recovery');
    assert.deepEqual((recovery as RecoverySummary).capabilities, {
        runtimeApplied: false,
        callableFromDsl: false,
        agentDiscovery: true,
        runnerRecovery: true,
        agentRecovery: false,
        replayable: false,
        modelLoadSeam: false,
    });

    const demo = await library.summary({kind: 'demonstration', name: DEMO_ONBOARDING});
    assert.ok(demo && demo.kind === 'demonstration');
    assert.deepEqual((demo as DemonstrationSummary).capabilities, {
        runtimeApplied: false,
        callableFromDsl: false,
        agentDiscovery: true,
        runnerRecovery: false,
        agentRecovery: false,
        replayable: true,
        modelLoadSeam: false,
    });

    const page = await library.summary({kind: 'page_knowledge', name: ORDERS_PAGE_PROFILE});
    assert.ok(page && page.kind === 'page_knowledge');
    assert.deepEqual((page as PageKnowledgeSummary).capabilities, {
        runtimeApplied: true,
        callableFromDsl: false,
        agentDiscovery: true,
        runnerRecovery: false,
        agentRecovery: false,
        replayable: false,
        modelLoadSeam: true,
    });
});

test('capability semantics: Procedure and Page Knowledge are wired model-loadable, Recovery/Demonstration are not', async () => {
    const {library} = createLibraryHarness();
    const listed = await library.list();
    for (const item of listed) {
        assert.equal(item.capabilities.modelLoadSeam, item.kind === 'procedure' || item.kind === 'page_knowledge', `${item.kind}:${item.name} modelLoadSeam mismatch`);
        assert.equal(item.capabilities.agentDiscovery, true, `${item.kind}:${item.name} agentDiscovery mismatch`);
        assert.equal(item.capabilities.callableFromDsl, item.kind === 'procedure', `${item.kind}:${item.name} callableFromDsl mismatch`);
    }

    const recovery = await library.summary({kind: 'recovery', name: RENEW_SESSION_RECOVERY});
    assert.ok(recovery && recovery.kind === 'recovery');
    assert.equal(recovery.capabilities.runnerRecovery, true);
    assert.equal(recovery.capabilities.replayable, false);

    const demo = await library.summary({kind: 'demonstration', name: DEMO_ONBOARDING});
    assert.ok(demo && demo.kind === 'demonstration');
    assert.equal(demo.capabilities.replayable, true);
    assert.equal(demo.capabilities.runnerRecovery, false);
});