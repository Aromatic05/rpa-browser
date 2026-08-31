import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createLibraryHarness,
    ENSURE_LOGIN_PROCEDURE,
    NESTED_CHECK_PROCEDURE,
    ORDERS_PAGE_PROFILE,
    SUBMIT_REPORT_AUTOMATION,
} from '../../../helpers/library_harness';
import {createWorkspaceLibrary} from '../../../../src/agent/library/workspace';

const automationId = {kind: 'automation', name: SUBMIT_REPORT_AUTOMATION} as const;
const procedureId = {kind: 'procedure', name: NESTED_CHECK_PROCEDURE} as const;

test('health is Unknown before any validation evidence exists; never inferred from file existence', async () => {
    const {library} = createLibraryHarness();
    assert.equal(await library.health(automationId), 'unknown');
    assert.equal(await library.health(procedureId), 'unknown');
    assert.equal(await library.health({kind: 'page_knowledge', name: ORDERS_PAGE_PROFILE}), 'unknown');

    const automation = await library.summary(automationId);
    assert.ok(automation && automation.kind === 'automation');
    assert.equal(automation.health, 'unknown');
});

test('valid dependency closure becomes Ready only after fresh validation evidence', async () => {
    const {library} = createLibraryHarness();
    const evidence = await library.validate(automationId);
    assert.equal(evidence.outcome, 'ready');
    assert.equal(await library.health(automationId), 'ready');

    const automation = await library.summary(automationId);
    assert.ok(automation && automation.kind === 'automation');
    assert.equal(automation.health, 'ready');
});

test('missing Page Knowledge becomes Broken only after fresh validation evidence', async () => {
    const {library, workflow} = createLibraryHarness();
    workflow.save({
        kind: 'dsl',
        name: 'ghost-report',
        content: 'use entity_rules "ghost-page" as orders\noutput done = input.done',
        stepResolves: {},
    });
    const ghostId = {kind: 'automation', name: 'ghost-report'} as const;
    assert.equal(await library.health(ghostId), 'unknown');

    const evidence = await library.validate(ghostId);
    assert.equal(evidence.outcome, 'broken');
    assert.deepEqual(evidence.summary.codes, ['ERR_DSL_ENTITY_PROFILE_NOT_FOUND']);
    assert.equal(await library.health(ghostId), 'broken');
});

test('revision change invalidates health evidence and surfaces NeedsReview', async () => {
    const {library, workflow} = createLibraryHarness();
    await library.validate(automationId);
    await library.validate(procedureId);
    assert.equal(await library.health(automationId), 'ready');
    assert.equal(await library.health(procedureId), 'ready');

    const current = workflow.get(NESTED_CHECK_PROCEDURE, {kind: 'checkpoint'});
    assert.ok(current && current.kind === 'checkpoint');
    workflow.save({
        ...current,
        bodyDsl: `${current.bodyDsl}\nwait 1`,
    });

    assert.equal(await library.health(automationId), 'needs_review');
    assert.equal(await library.health(procedureId), 'needs_review');

    const revalidated = await library.validate(automationId);
    assert.equal(revalidated.outcome, 'ready');
    assert.equal(await library.health(automationId), 'ready');
});

test('dependency revision change invalidates evidence, then revalidation records Broken', async () => {
    const {library, workflow} = createLibraryHarness();
    await library.validate(automationId);
    assert.equal(await library.health(automationId), 'ready');

    workflow.delete(ORDERS_PAGE_PROFILE, {kind: 'entity_rules'});

    assert.equal(await library.health(automationId), 'needs_review');

    const evidence = await library.validate(automationId);
    assert.equal(evidence.outcome, 'broken');
    assert.ok(evidence.summary.codes.includes('ERR_DSL_ENTITY_PROFILE_NOT_FOUND'));
    assert.equal(await library.health(automationId), 'broken');
});

test('recursive checkpoint graph is diagnosed without crashing the catalog', async () => {
    const {library, workflow} = createLibraryHarness();
    workflow.save({
        kind: 'checkpoint',
        name: 'recursive-proc',
        checkpoint: {
            id: 'recursive-proc',
            kind: 'procedure',
            trigger: {matchRules: []},
            body: {language: 'dsl', source: 'body.dsl'},
        },
        stepResolves: {},
        hints: {},
        bodyDsl: 'use checkpoint "recursive-proc"',
    });
    workflow.save({
        kind: 'dsl',
        name: 'recursive-report',
        content: 'use checkpoint "recursive-proc"',
        stepResolves: {},
    });

    const evidence = await library.validate({kind: 'automation', name: 'recursive-report'});
    assert.equal(evidence.outcome, 'broken');
    assert.deepEqual(evidence.summary.codes, ['ERR_DSL_CHECKPOINT_RECURSION']);

    const listed = await library.list({kind: 'automation'});
    const recursive = listed.find((item) => item.name === 'recursive-report');
    assert.ok(recursive && recursive.kind === 'automation');
    assert.equal(recursive.health, 'broken');
});

test('evidence records asset revision and dependency revisions for staleness comparison', async () => {
    const {library, workflow} = createLibraryHarness();
    const evidence = await library.validate(automationId);
    assert.equal(evidence.assetName, SUBMIT_REPORT_AUTOMATION);
    assert.equal(evidence.assetKind, 'automation');
    assert.ok(evidence.assetRevision && typeof evidence.assetRevision === 'string');
    const nestedDependency = evidence.dependencies
        .find((dependency) => dependency.name === NESTED_CHECK_PROCEDURE);
    assert.ok(nestedDependency);
    const nestedArtifact = workflow.get(NESTED_CHECK_PROCEDURE, {kind: 'checkpoint'});
    assert.ok(nestedArtifact && nestedArtifact.kind === 'checkpoint');
    assert.ok(nestedDependency.revision);
    assert.equal(typeof nestedDependency.revision, 'string');
});

test('validation evidence is isolated per library instance (no background inference)', async () => {
    const {library, runStepsDeps, workspaceName} = createLibraryHarness();
    await library.validate(automationId);
    const fresh = createWorkspaceLibrary({workspaceName, deps: runStepsDeps});
    assert.equal(await fresh.health(automationId), 'unknown');
    const freshAutomation = await fresh.summary(automationId);
    assert.ok(freshAutomation && freshAutomation.kind === 'automation');
    assert.equal(freshAutomation.health, 'unknown');
});

test('ensure-login procedure validates as Ready with its page knowledge dependency', async () => {
    const {library} = createLibraryHarness();
    const evidence = await library.validate({kind: 'procedure', name: ENSURE_LOGIN_PROCEDURE});
    assert.equal(evidence.outcome, 'ready');
    assert.equal(await library.health({kind: 'procedure', name: ENSURE_LOGIN_PROCEDURE}), 'ready');
});