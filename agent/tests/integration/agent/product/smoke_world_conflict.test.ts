import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductSmokeSession, fixtureUrl, httpBase, bearerHeaders, st, newStepId} from '../../../helpers/agent_product_harness';
import {createScriptedModelRuntime, crossBarrierScript} from '../../../helpers/agent_product_faux';
import {startFixtureServer} from '../../../helpers/server';
import {passEntry, failEntry} from '../../../helpers/agent_product_matrix';
import type {AgentRunResult} from '../../../../src/agent/execution/types';

const CUSTOMER_PROFILE = '/step_actions/customer_profile.html';
const ANNOTATOR_PAGE = '/entity_rules/annotator_form.html';

type ResolvedTarget = {nodeId: string; meta: {pageEpoch: string; captureRevision: number}};

const resolveCustomerName = async (session: Awaited<ReturnType<typeof openProductSmokeSession>>): Promise<ResolvedTarget> => {
    await session.runSteps([st(newStepId(), 'browser.snapshot', {})]);
    const results = await session.runSteps([st(newStepId(), 'browser.capture_resolve', {selector: '#customerName'})]);
    assert.equal(results[0].ok, true, JSON.stringify(results[0].error ?? null));
    const data = results[0].data as {target?: ResolvedTarget};
    assert.ok(data.target?.nodeId && data.target.meta, 'capture_resolve must return an observed target envelope');
    return data.target;
};

const runStaleProgram = async (port: number, provider: string, model: string, target: ResolvedTarget): Promise<AgentRunResult> => {
    const response = await fetch(`${httpBase(port)}/agent`, {
        method: 'POST',
        headers: bearerHeaders(undefined),
        body: JSON.stringify({
            prompt: 'fill using the previously observed target',
            provider,
            model,
            executionMode: 'program',
            source: 'fill input.target with input.value\noutput result = input.value',
            input: {target, value: 'Sneaky'},
        }),
    });
    assert.equal(response.status, 200);
    return await response.json() as AgentRunResult;
};

test('product: navigation page-epoch change refuses a stale observed transact', async () => {
    const faux = createScriptedModelRuntime(crossBarrierScript);
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({modelRuntime: faux.runtime});
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, CUSTOMER_PROFILE));
        const target = await resolveCustomerName(session);
        const beforeEpoch = target.meta.pageEpoch;

        const navigated = await session.runSteps([st(newStepId(), 'browser.goto', {url: fixtureUrl(fixture, ANNOTATOR_PAGE)})]);
        assert.equal(navigated[0].ok, true);

        const result = await runStaleProgram(port, faux.provider, faux.model, target);
        const program = result.programs?.[0];
        assert.equal(program?.status, 'paused', 'the stale transact must pause on the world conflict');
        assert.equal(program?.pause?.reason, 'failure');
        assert.equal(program?.pause?.failure?.code, 'ERR_AGENT_WORLD_CONFLICT');
        assert.ok((program?.effects ?? []).every((effect) =>
            effect.worldBefore.pageEpoch === effect.worldAfter.pageEpoch
            && effect.worldBefore.captureRevision === effect.worldAfter.captureRevision),
            'no world effect may change the world after a navigation epoch change');
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.locator('#CustomerName').inputValue(), '');
        session.record(passEntry('world-conflict.navigation', 'navigation page-epoch change refuses a stale observed transact', [
            `observed epoch ${beforeEpoch} -> refused after navigation`,
        ]));
    } catch (error) {
        session.record(failEntry('world-conflict.navigation', 'navigation page-epoch change refuses a stale observed transact', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});

test('product: dynamic SPA re-render between read and transact refuses the mutation', async () => {
    const faux = createScriptedModelRuntime(crossBarrierScript);
    const fixture = await startFixtureServer();
    const session = await openProductSmokeSession({modelRuntime: faux.runtime});
    const port = await session.startService();
    try {
        await session.page.goto(fixtureUrl(fixture, CUSTOMER_PROFILE));
        const target = await resolveCustomerName(session);
        const beforeRevision = target.meta.captureRevision;

        // Simulate an SPA re-render: the original input is replaced by a new node.
        await session.page.evaluate(() => {
            const original = document.querySelector('#customerName');
            const parent = original?.parentElement;
            if (original && parent) {
                const replacement = document.createElement('input');
                replacement.id = 'customerName-v2';
                replacement.setAttribute('aria-label', '客户名称 v2');
                parent.replaceChild(replacement, original);
            }
        });
        const refreshed = await session.runSteps([st(newStepId(), 'browser.snapshot', {refresh: true})]);
        assert.equal(refreshed[0].ok, true);

        const result = await runStaleProgram(port, faux.provider, faux.model, target);
        const program = result.programs?.[0];
        assert.equal(program?.status, 'paused', 'the stale transact must pause on the world conflict');
        assert.equal(program?.pause?.reason, 'failure');
        assert.equal(program?.pause?.failure?.code, 'ERR_AGENT_WORLD_CONFLICT');
        assert.ok((program?.effects ?? []).every((effect) =>
            effect.worldBefore.pageEpoch === effect.worldAfter.pageEpoch
            && effect.worldBefore.captureRevision === effect.worldAfter.captureRevision),
            'no world effect may change the world after the SPA re-render');
        await session.page.waitForTimeout(250);
        assert.equal(await session.page.locator('#customerName-v2').inputValue(), '',
            'the re-rendered field must not carry the stale program value');
        session.record(passEntry('world-conflict.spa-render', 'dynamic SPA re-render between read and transact refuses the mutation', [
            `observed captureRevision ${beforeRevision} -> refused after re-render`,
        ]));
    } catch (error) {
        session.record(failEntry('world-conflict.spa-render', 'dynamic SPA re-render between read and transact refuses the mutation', 'product',
            error instanceof Error ? error.message : String(error)));
        throw error;
    } finally {
        session.flushMatrix();
        await session.stop();
        await fixture.close();
    }
});