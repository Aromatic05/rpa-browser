import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductSmokeSession, fixtureUrl, httpBase, bearerHeaders} from '../../../helpers/agent_product_harness';
import {createScriptedModelRuntime, rollbackRestoreScript, rewindRepairScript} from '../../../helpers/agent_product_faux';
import {startFixtureServer} from '../../../helpers/server';
import {passEntry, failEntry} from '../../../helpers/agent_product_matrix';
import type {AgentRunResult} from '../../../../src/agent/execution/types';
import type {EntityRuleMatchArtifact, EntityRuleAnnotationArtifact} from '../../../../src/automation/workflow/entity_rules';

const ANNOTATOR_PAGE = '/entity_rules/annotator_form.html';

const RECOVERY_MATCH: EntityRuleMatchArtifact = {
    version: 2,
    rules: [
        {ruleId: 'customer-root', source: 'region', expect: 'unique', match: {kind: 'form', idEquals: 'CustomerForm'}},
        {ruleId: 'customer-name', source: 'node', expect: 'unique', within: 'customer-root', match: {idEquals: 'CustomerName'}},
    ],
};

const RECOVERY_ANNOTATION: EntityRuleAnnotationArtifact = {
    version: 2,
    bindings: [
        {ruleId: 'customer-root', entityKey: 'customerForm', businessTag: 'recovery.form', entityKind: 'form', displayName: 'Customer form'},
        {ruleId: 'customer-name', fieldKey: 'customerName', fieldRole: 'field', fieldName: 'Customer name', effect: {reversibility: 'reversible'}},
    ],
};

const FAILING_SOURCE = [
    'use entity_rules "recovery-form" as hitl',
    'fill hitl.customerForm.customerName with input.value',
    'ensure compute eq(input.expected, true)',
    'output result = input.value',
].join('\n');

const runRecoveryRequest = async (port: number, body: Record<string, unknown>) => {
    const response = await fetch(`${httpBase(port)}/agent`, {
        method: 'POST',
        headers: bearerHeaders(undefined),
        body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `agent run failed with ${response.status}`);
    return await response.json() as AgentRunResult;
};

test('product: reversible failure -> rollback -> physical restore when the pre-value is captured', async () => {
    const fixture = await startFixtureServer();
    const faux = createScriptedModelRuntime(rollbackRestoreScript({source: FAILING_SOURCE, input: {}}));
    const session = await openProductSmokeSession({
        modelRuntime: faux.runtime,
        entityRules: [{profileName: 'recovery-form', match: RECOVERY_MATCH, annotation: RECOVERY_ANNOTATION}],
    });
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, ANNOTATOR_PAGE));
        await session.page.locator('#CustomerName').fill('Old');

        const result = await runRecoveryRequest(port, {
            prompt: 'recover from the reversible failure',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
            source: FAILING_SOURCE,
            input: {value: 'Alice', expected: false},
        });

        const program = result.programs?.[0];
        assert.equal(program?.status, 'failed', 'the terminalized failure must be reported honestly');
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.locator('#CustomerName').inputValue(), 'Old',
            'rollback must restore the captured pre-effect value');
        assert.ok((program?.effects ?? []).some((effect) => effect.compensates !== undefined),
            'the effect journal must record a compensation for the reversible fill');
        session.record(passEntry('recovery.rollback-restore', 'reversible failure -> rollback -> physical restore (captured pre-value)'));
    } catch (error) {
        session.record(failEntry('recovery.rollback-restore', 'reversible failure -> rollback -> physical restore (captured pre-value)', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});

test('product: rollback of an initially-empty field restores the DOM', async () => {
    const fixture = await startFixtureServer();
    const faux = createScriptedModelRuntime(rollbackRestoreScript({source: FAILING_SOURCE, input: {}}));
    const session = await openProductSmokeSession({
        modelRuntime: faux.runtime,
        entityRules: [{profileName: 'recovery-form', match: RECOVERY_MATCH, annotation: RECOVERY_ANNOTATION}],
    });
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, ANNOTATOR_PAGE));

        const result = await runRecoveryRequest(port, {
            prompt: 'recover from the reversible failure',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
            source: FAILING_SOURCE,
            input: {value: 'Alice', expected: false},
        });

        const program = result.programs?.[0];
        assert.equal(program?.status, 'failed');
        await session.page.waitForTimeout(250);
        const domValue = await session.page.locator('#CustomerName').inputValue();
        const compensated = (program?.effects ?? []).some((effect) => effect.compensates !== undefined);
        const restored = domValue === '' && compensated;
        session.record(restored
            ? passEntry('recovery.rollback-empty-field', 'rollback physical restore of an initially-empty field')
            : failEntry(
                'recovery.rollback-empty-field',
                'rollback physical restore of an initially-empty field',
                'product',
                'physical rollback did not restore the explicitly observed empty field state',
                [`DOM #CustomerName after rollback = ${JSON.stringify(domValue)}`, `compensation recorded = ${String(compensated)}`],
            ));
        assert.equal(domValue, '', 'rollback must restore an initially-empty field to empty');
        assert.ok(compensated, 'rollback must record a compensation for an empty-field fill');
    } catch (error) {
        if (!session.matrix.entries.some((entry) => entry.id === 'recovery.rollback-empty-field')) {
            session.record(failEntry('recovery.rollback-empty-field', 'rollback physical restore of an initially-empty field', 'product',
                error instanceof Error ? error.message : String(error)));
        }
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});

test('product: reversible failure -> rewind -> repair -> completed in one retained transaction', async () => {
    const fixture = await startFixtureServer();
    const faux = createScriptedModelRuntime(rewindRepairScript({
        source: FAILING_SOURCE,
        input: {},
        patchSource: 'output patched = input.value',
    }));
    const session = await openProductSmokeSession({
        modelRuntime: faux.runtime,
        entityRules: [{profileName: 'recovery-form', match: RECOVERY_MATCH, annotation: RECOVERY_ANNOTATION}],
    });
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, ANNOTATOR_PAGE));

        const result = await runRecoveryRequest(port, {
            prompt: 'repair and rerun the failed step',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
            source: FAILING_SOURCE,
            input: {value: 'Alice', expected: false},
        });

        const program = result.programs?.[0];
        assert.equal(program?.status, 'completed', JSON.stringify(program?.error ?? program?.pause ?? null));
        assert.equal((JSON.parse(program?.text ?? '{}') as Record<string, unknown>).result, 'Alice');
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.locator('#CustomerName').inputValue(), 'Alice',
            'the repaired statement must leave the real DOM consistent in the same retained transaction');
        session.record(passEntry('recovery.rewind-repair', 'reversible failure -> rewind -> repair -> completed'));
    } catch (error) {
        session.record(failEntry('recovery.rewind-repair', 'reversible failure -> rewind -> repair -> completed', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});