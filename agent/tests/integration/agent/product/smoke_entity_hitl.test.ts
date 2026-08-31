import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductSmokeSession, fixtureUrl, httpBase, bearerHeaders} from '../../../helpers/agent_product_harness';
import {createScriptedModelRuntime, silentModelScript} from '../../../helpers/agent_product_faux';
import {startFixtureServer} from '../../../helpers/server';
import {passEntry, failEntry} from '../../../helpers/agent_product_matrix';
import type {AgentRunResult} from '../../../../src/agent/execution/types';
import type {EntityRuleMatchArtifact, EntityRuleAnnotationArtifact} from '../../../../src/automation/workflow/entity_rules';

const LOGIN_PAGE = '/dsl_order_workflow.html';
const ANNOTATOR_PAGE = '/entity_rules/annotator_form.html';

const runSourceRequest = async (port: number, body: Record<string, unknown>) => {
    const response = await fetch(`${httpBase(port)}/agent`, {
        method: 'POST',
        headers: bearerHeaders(undefined),
        body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `agent run failed with ${response.status}`);
    const sessionId = response.headers.get('x-session-id');
    assert.ok(sessionId, 'agent run must return an x-session-id');
    const result = await response.json() as AgentRunResult;
    return {sessionId, result};
};

const LOGIN_MATCH: EntityRuleMatchArtifact = {
    version: 2,
    rules: [
        {ruleId: 'login-root', source: 'region', expect: 'unique', match: {kind: 'form', idEquals: 'login-form'}},
        {ruleId: 'login-username', source: 'node', expect: 'unique', within: 'login-root', match: {idEquals: 'username'}},
        {ruleId: 'login-password', source: 'node', expect: 'unique', within: 'login-root', match: {idEquals: 'password'}},
    ],
};

const LOGIN_ANNOTATION: EntityRuleAnnotationArtifact = {
    version: 2,
    bindings: [
        {ruleId: 'login-root', entityKey: 'loginForm', businessTag: 'auth.login2', entityKind: 'form', displayName: 'System login'},
        {ruleId: 'login-username', fieldKey: 'username', fieldRole: 'field', fieldName: 'Username', effect: {reversibility: 'reversible'}},
        {ruleId: 'login-password', fieldKey: 'password', fieldRole: 'field', fieldName: 'Password', effect: {reversibility: 'reversible'}},
    ],
};

const HITL_MATCH: EntityRuleMatchArtifact = {
    version: 2,
    rules: [
        {ruleId: 'customer-root', source: 'region', expect: 'unique', match: {kind: 'form', idEquals: 'CustomerForm'}},
        {ruleId: 'customer-name', source: 'node', expect: 'unique', within: 'customer-root', match: {idEquals: 'CustomerName'}},
        {ruleId: 'customer-save', source: 'node', expect: 'unique', within: 'customer-root', match: {idEquals: 'SaveCustomer'}},
    ],
};

const HITL_ANNOTATION: EntityRuleAnnotationArtifact = {
    version: 2,
    bindings: [
        {ruleId: 'customer-root', entityKey: 'customerForm', businessTag: 'hitl.form', entityKind: 'form', displayName: 'Customer form'},
        {ruleId: 'customer-name', fieldKey: 'customerName', fieldRole: 'field', fieldName: 'Customer name', effect: {reversibility: 'reversible'}},
        {ruleId: 'customer-save', actionIntent: 'submit', actionRole: 'form', actionText: 'Save customer', effect: {reversibility: 'irreversible'}},
    ],
};

const HITL_SOURCE = [
    'use entity_rules "hitl-form" as hitl',
    'fill hitl.customerForm.customerName with input.name',
    'click hitl.customerForm.submit',
    'output done = input.done',
].join('\n');

const armAnnotatorSubmit = (session: Awaited<ReturnType<typeof openProductSmokeSession>>): Promise<void> =>
    session.page.evaluate(() => {
        const form = document.querySelector('#CustomerForm');
        if (form) {
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                document.body.dataset.formSubmitted = 'true';
            });
        }
    });

test('product: annotated business entity path through entity_rules on a real form', async () => {
    const faux = createScriptedModelRuntime(silentModelScript);
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({
        modelRuntime: faux.runtime,
        useEntityRulesWorkflow: true,
        entityRules: [{profileName: 'login-form', match: LOGIN_MATCH, annotation: LOGIN_ANNOTATION}],
    });
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, LOGIN_PAGE));

        const {result} = await runSourceRequest(port, {
            prompt: 'login with the annotated form',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
            source: [
                'use entity_rules "login-form" as login',
                'fill login.loginForm.username with input.username',
                'fill login.loginForm.password with input.password',
                'output ok = input.ok',
            ].join('\n'),
            input: {username: 'operator', password: 'correct-horse', ok: true},
        });

        const program = result.programs?.[0];
        assert.equal(program?.status, 'completed', JSON.stringify(program?.error ?? program?.pause ?? null));
        assert.equal((JSON.parse(program?.text ?? '{}') as Record<string, unknown>).ok, true);
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.locator('#username').inputValue(), 'operator');
        assert.equal(await session.page.locator('#password').inputValue(), 'correct-horse');
        session.record(passEntry('program.entity.annotated-path', 'annotated business entity path through entity_rules'));
    } catch (error) {
        session.record(failEntry('program.entity.annotated-path', 'annotated business entity path through entity_rules', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});

type InteractionRecord = {
    id: string;
    kind: string;
    status: string;
    revision: number;
    payload: {kind: string; actionName?: string; risk?: string};
};

const listInteractions = async (port: number, sessionId: string): Promise<InteractionRecord[]> => {
    const listed = await fetch(`${httpBase(port)}/agent/sessions/${sessionId}/interactions`);
    assert.equal(listed.status, 200);
    return ((await listed.json()) as {interactions: InteractionRecord[]}).interactions;
};

test('product: irreversible HITL approve executes the effect exactly once over HTTP', async () => {
    const faux = createScriptedModelRuntime(silentModelScript);
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({
        modelRuntime: faux.runtime,
        interaction: 'interactive',
        entityRules: [{profileName: 'hitl-form', match: HITL_MATCH, annotation: HITL_ANNOTATION}],
    });
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, ANNOTATOR_PAGE));
        await armAnnotatorSubmit(session);

        const {sessionId, result} = await runSourceRequest(port, {
            prompt: 'approve the irreversible effect',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
            source: HITL_SOURCE,
            input: {name: 'ACME', done: true},
        });

        const program = result.programs?.[0];
        assert.equal(program?.status, 'paused', 'the irreversible submit must pause at a barrier');
        assert.equal(program?.pause?.reason, 'barrier');
        assert.equal(program?.pause?.risk, 'irreversible');

        const interactions = await listInteractions(port, sessionId);
        assert.equal(interactions.length, 1);
        const interaction = interactions[0];
        assert.equal(interaction.kind, 'approval', 'product interaction kind must be approval');
        assert.equal(interaction.payload.kind, 'approval');
        assert.equal(interaction.payload.actionName, 'browser.click');
        assert.equal(interaction.payload.risk, 'irreversible');
        assert.equal(interaction.status, 'pending');
        assert.equal(await session.page.locator('#CustomerName').inputValue(), 'ACME',
            'the reversible fill must run before the barrier');

        const approved = await fetch(`${httpBase(port)}/agent/sessions/${sessionId}/interactions/${interaction.id}/approve`, {
            method: 'POST',
            headers: bearerHeaders(undefined),
            body: JSON.stringify({revision: interaction.revision, approvedBy: 'ops-1'}),
        });
        assert.equal(approved.status, 200);
        const decision = await approved.json() as {interaction: {status: string}; session: {state: string}};
        assert.equal(decision.interaction.status, 'approved');
        assert.equal(decision.session.state, 'completed');
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.evaluate(() => document.body.dataset.formSubmitted), 'true',
            'the approved irreversible click must mutate the real DOM exactly once');
        session.record(passEntry('hitl.approve', 'irreversible HITL approve resumes and executes the effect once'));
    } catch (error) {
        session.record(failEntry('hitl.approve', 'irreversible HITL approve resumes and executes the effect once', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});

test('product: irreversible HITL deny keeps the task running, never executing the denied effect', async () => {
    const faux = createScriptedModelRuntime(silentModelScript);
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({
        modelRuntime: faux.runtime,
        interaction: 'interactive',
        entityRules: [{profileName: 'hitl-form', match: HITL_MATCH, annotation: HITL_ANNOTATION}],
    });
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, ANNOTATOR_PAGE));
        await armAnnotatorSubmit(session);

        const {sessionId} = await runSourceRequest(port, {
            prompt: 'approve the irreversible effect',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
            source: HITL_SOURCE,
            input: {name: 'ACME', done: true},
        });

        const interaction = (await listInteractions(port, sessionId))[0];
        assert.equal(interaction.kind, 'approval');
        assert.equal(interaction.status, 'pending');

        const denied = await fetch(`${httpBase(port)}/agent/sessions/${sessionId}/interactions/${interaction.id}/deny`, {
            method: 'POST',
            headers: bearerHeaders(undefined),
            body: JSON.stringify({revision: interaction.revision, deniedBy: 'ops-2', reason: 'not safe'}),
        });
        assert.equal(denied.status, 200);
        const decision = await denied.json() as {
            interaction: {status: string};
            session: {
                state: string;
                resumable: boolean;
                error: {code: string; message: string} | null;
                result: {control?: unknown; continuation?: unknown};
            };
        };
        assert.equal(decision.interaction.status, 'denied');
        assert.notEqual(decision.session.state, 'cancelled', 'denial must never cancel the task');
        assert.equal(decision.session.error, null, 'denial must not mark the session as errored');
        assert.equal(decision.session.state, 'paused', 'the same task stays paused under control after denial');
        assert.equal(decision.session.resumable, true, 'the same-task control continuation must remain resumable');
        assert.ok(decision.session.result?.control, 'the retained task must keep its same-task control continuation');
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.evaluate(() => document.body.dataset.formSubmitted), undefined,
            'denial must never execute the denied irreversible effect');
        assert.equal(await session.page.locator('#CustomerName').inputValue(), 'ACME',
            'the reversible pre-barrier fill must remain applied after denial');
        session.record(passEntry('hitl.deny', 'irreversible HITL deny keeps the task running without executing the effect'));
    } catch (error) {
        session.record(failEntry('hitl.deny', 'irreversible HITL deny keeps the task running without executing the effect', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});