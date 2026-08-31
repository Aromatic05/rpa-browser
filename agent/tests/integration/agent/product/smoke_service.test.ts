import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductSmokeSession, fixtureUrl, httpBase, bearerHeaders} from '../../../helpers/agent_product_harness';
import {createScriptedModelRuntime, planFormProgramScript, assistant} from '../../../helpers/agent_product_faux';
import {startFixtureServer} from '../../../helpers/server';
import {passEntry, failEntry} from '../../../helpers/agent_product_matrix';
import {createAuthSecurity} from '../../../helpers/agent_security_composition';
import type {AgentRunResult} from '../../../../src/agent/execution/types';

const CUSTOMER_PROFILE = '/step_actions/customer_profile.html';

const runAgentRequest = async (port: number, body: Record<string, unknown>, token?: string) => {
    const response = await fetch(`${httpBase(port)}/agent`, {
        method: 'POST',
        headers: bearerHeaders(token),
        body: JSON.stringify(body),
    });
    return {response, body: await response.json() as AgentRunResult};
};

const completedProgramRun = async (port: number, provider: string, model: string) => {
    const {response, body} = await runAgentRequest(port, {
        prompt: 'fill the customer name field',
        provider,
        model,
        executionMode: 'program',
    });
    assert.equal(response.status, 200);
    return {sessionId: response.headers.get('x-session-id')!, body};
};

test('product: cancellation of a long task leaves the session cancelled and the DOM untouched', async () => {
    const faux = createScriptedModelRuntime(async () => {
        await new Promise<void>(() => {});
        return assistant('done');
    });
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({modelRuntime: faux.runtime});
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, CUSTOMER_PROFILE));

        const start = await fetch(`${httpBase(port)}/agent/sessions`, {
            method: 'POST',
            headers: bearerHeaders(undefined),
            body: JSON.stringify({
                prompt: 'long-running drain task',
                provider: faux.provider,
                model: faux.model,
                executionMode: 'react-baseline',
            }),
        });
        assert.equal(start.status, 202);
        const started = await start.json() as {sessionId: string; state: string};
        const sessionId = started.sessionId;
        assert.equal(started.state, 'running');

        const deadline = Date.now() + 15_000;
        let running = false;
        while (Date.now() < deadline) {
            const status = await (await fetch(`${httpBase(port)}/agent/sessions/${sessionId}`)).json() as {state: string};
            if (status.state === 'running') {
                running = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        assert.equal(running, true, 'the long task must be observable as running before cancellation');

        const cancelled = await fetch(`${httpBase(port)}/agent/sessions/${sessionId}/cancel`, {method: 'POST'});
        assert.equal(cancelled.status, 200);
        const cancelledSnapshot = await cancelled.json() as {state: string};
        assert.equal(cancelledSnapshot.state, 'cancelled');

        const after = await (await fetch(`${httpBase(port)}/agent/sessions/${sessionId}`)).json() as {state: string};
        assert.equal(after.state, 'cancelled', 'cancellation must be durable');
        await session.page.waitForTimeout(300);
        assert.equal(await session.page.locator('#customerName').inputValue(), '',
            'cancellation must not mutate the DOM');
        session.record(passEntry('service.cancel-long-task', 'cancellation of a long task'));
    } catch (error) {
        session.record(failEntry('service.cancel-long-task', 'cancellation of a long task', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});

test('product: session list/status/report retrieval after completion', async () => {
    const faux = createScriptedModelRuntime(planFormProgramScript({fieldSelector: '#customerName', value: 'Reported'}));
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({modelRuntime: faux.runtime});
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, CUSTOMER_PROFILE));
        const {sessionId, body} = await completedProgramRun(port, faux.provider, faux.model);
        assert.equal(body.programs?.[0]?.status, 'completed');

        const list = await (await fetch(`${httpBase(port)}/agent/sessions`)).json() as {
            sessions: Array<{sessionId: string; state: string}>;
        };
        const listed = list.sessions.find((entry) => entry.sessionId === sessionId);
        assert.ok(listed, 'the completed session must appear in the session list');
        assert.equal(listed?.state, 'completed');

        const status = await (await fetch(`${httpBase(port)}/agent/sessions/${sessionId}`)).json() as {
            state: string;
            reportAvailable: boolean | string;
        };
        assert.equal(status.state, 'completed');
        assert.equal(String(status.reportAvailable), 'true');

        const report = await (await fetch(`${httpBase(port)}/agent/sessions/${sessionId}/report`)).json() as {
            sessionId: string;
            report: {terminal?: {status: string}};
        };
        assert.equal(report.sessionId, sessionId);
        assert.equal(report.report?.terminal?.status, 'completed');
        const reportText = JSON.stringify(report);
        assert.ok(!reportText.includes('sk-'), 'reports must not leak credentials');
        session.record(passEntry('service.session-report', 'session/report retrieval after completion'));
    } catch (error) {
        session.record(failEntry('service.session-report', 'session/report retrieval after completion', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});

test('product: auth-enabled service enforces bearer tokens and redacts the token', async () => {
    const token = 'product-smoke-bearer-token';
    const faux = createScriptedModelRuntime(planFormProgramScript({fieldSelector: '#customerName', value: 'Secured'}));
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({
        modelRuntime: faux.runtime,
        security: createAuthSecurity(token),
    });
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, CUSTOMER_PROFILE));

        const missing = await runAgentRequest(port, {
            prompt: 'fill the customer name field',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
        });
        assert.equal(missing.response.status, 401, 'missing bearer token must be rejected');
        assert.ok(!JSON.stringify(missing.body).includes(token));

        const wrong = await runAgentRequest(port, {
            prompt: 'fill the customer name field',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
        }, 'wrong-token');
        assert.equal(wrong.response.status, 401, 'wrong bearer token must be rejected');

        const accepted = await runAgentRequest(port, {
            prompt: 'fill the customer name field',
            provider: faux.provider,
            model: faux.model,
            executionMode: 'program',
        }, token);
        assert.equal(accepted.response.status, 200, 'valid bearer token must be accepted');
        assert.ok(!JSON.stringify(accepted.body).includes(token), 'the token must never appear in the response');
        assert.equal(accepted.body.programs?.[0]?.status, 'completed');
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.locator('#customerName').inputValue(), 'Secured');
        session.record(passEntry('service.auth-enabled', 'auth-enabled service enforces bearer tokens'));
    } catch (error) {
        session.record(failEntry('service.auth-enabled', 'auth-enabled service enforces bearer tokens', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});