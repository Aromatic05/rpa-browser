import test from 'node:test';
import assert from 'node:assert/strict';
import type {EntityRulesRuntime} from '../../../../src/automation/snapshot/rules';
import type {Library} from '../../../../src/agent/library/contracts';
import type {Workflow} from '../../../../src/automation/workflow';
import {createKnowledgeTools, KNOWLEDGE_CATALOG_TOOL, KNOWLEDGE_INSPECT_TOOL, type KnowledgeSeamDeps} from '../../../../src/agent/execution/knowledge';
import {queryKnowledgeCatalog} from '../../../../src/agent/execution/knowledge/catalog';
import {PROGRAM_FIRST_SYSTEM_PROMPT} from '../../../../src/agent/execution/program/runner';
import {
    createLibraryHarness,
    ENSURE_LOGIN_PROCEDURE,
    NESTED_CHECK_PROCEDURE,
    SUBMIT_REPORT_AUTOMATION,
} from '../../../helpers/library_harness';

const seamedHarness = (): KnowledgeSeamDeps & {library: Library; workflow: Workflow; entityRulesRuntime: EntityRulesRuntime} => {
    const harness = createLibraryHarness();
    const runtime = harness.runStepsDeps.resolveWorkspace(harness.workspaceName).entityRules;
    return {
        library: harness.library,
        workflow: harness.workflow,
        entityRulesRuntime: runtime,
        entityRules: runtime.getProvider(harness.workflow),
    };
};

test('catalog is bounded: kind/limit/filter shape the result and never leak internals', async () => {
    const seam = seamedHarness();
    const all = await queryKnowledgeCatalog(seam, {});
    assert.equal(all.count, 6);
    assert.equal(all.truncated, false);
    assert.deepEqual(all.entries.map((entry) => entry.id.name).sort(), [
        ENSURE_LOGIN_PROCEDURE,
        NESTED_CHECK_PROCEDURE,
        'demo-onboarding',
        'orders-page',
        'renew-session',
        SUBMIT_REPORT_AUTOMATION,
    ].sort());

    const capped = await queryKnowledgeCatalog(seam, {limit: 2});
    assert.equal(capped.count, 2);
    assert.equal(capped.truncated, true);

    const byKind = await queryKnowledgeCatalog(seam, {kind: 'procedure'});
    assert.deepEqual(byKind.entries.map((entry) => entry.id.name).sort(), [
        ENSURE_LOGIN_PROCEDURE,
        NESTED_CHECK_PROCEDURE,
    ].sort());

    const filtered = await queryKnowledgeCatalog(seam, {kind: 'procedure', filter: 'orderNo'});
    assert.deepEqual(filtered.entries.map((entry) => entry.id.name), [NESTED_CHECK_PROCEDURE]);

    for (const entry of all.entries) {
        const serialized = JSON.stringify(entry);
        for (const forbidden of ['revision', 'updatedAt', 'dependencies', 'body', 'bodyDsl', 'source', 'steps', 'selector']) {
            assert.equal(Object.hasOwn(entry, forbidden), false, `${entry.id.kind}:${entry.id.name} leaked ${forbidden}`);
        }
        for (const forbiddenText of ['use checkpoint', 'use entity_rules', 'body.dsl', 'idEquals', 'nodeId']) {
            assert.equal(serialized.includes(forbiddenText), false, `${entry.id.kind}:${entry.id.name} leaked ${forbiddenText}`);
        }
    }
});

test('broken assets are labeled, never silently excluded, and stay bounded', async () => {
    const seam = seamedHarness();
    seam.workflow.save({
        kind: 'checkpoint',
        name: 'broken-proc',
        checkpoint: {
            id: 'broken-proc',
            kind: 'procedure',
            trigger: {matchRules: []},
            body: {language: 'dsl', source: 'body.dsl'},
        },
        stepResolves: {},
        hints: {},
        bodyDsl: 'use entity_rules "missing-profile" as ghost\noutput v = input.v',
    });
    await seam.library.validate({kind: 'procedure', name: 'broken-proc'});

    const procedure = await queryKnowledgeCatalog(seam, {kind: 'procedure', filter: 'broken'});
    assert.equal(procedure.truncated, false);
    const broken = procedure.entries.find((entry) => entry.id.name === 'broken-proc');
    assert.ok(broken, 'broken asset must appear in the catalog');
    assert.equal(broken.kind, 'procedure');
    assert.equal(broken.health, 'broken');

    const all = await queryKnowledgeCatalog(seam, {});
    assert.equal(all.entries.some((entry) => entry.id.name === 'broken-proc'), true);
});

test('knowledge tools expose bounded read-only parameters and their guidance never embeds asset content', async () => {
    const harness = createLibraryHarness();
    const runtime = harness.runStepsDeps.resolveWorkspace(harness.workspaceName).entityRules;
    const tools = createKnowledgeTools({library: harness.library, entityRules: runtime.getProvider(harness.workflow)});
    assert.deepEqual(tools.map((tool) => tool.name), [KNOWLEDGE_CATALOG_TOOL, KNOWLEDGE_INSPECT_TOOL]);
    assert.equal(tools.every((tool) => tool.name.startsWith('agent.knowledge.')), true);

    const prompt = PROGRAM_FIRST_SYSTEM_PROMPT;
    assert.equal(prompt.includes(KNOWLEDGE_CATALOG_TOOL), true);
    assert.equal(prompt.includes(KNOWLEDGE_INSPECT_TOOL), true);
    for (const assetIdentifier of ['nested-check', 'orders-page', 'ensure-login', 'renew-session']) {
        assert.equal(prompt.includes(assetIdentifier), false, `knowledge content leaked an asset id: ${assetIdentifier}`);
    }
    for (const selectorText of ['idEquals', 'nameEquals', 'textContains', 'ruleId']) {
        assert.equal(prompt.includes(selectorText), false, `knowledge content leaked ${selectorText}`);
    }
});