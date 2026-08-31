import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { startAgent, runStep, dispatch, type AgentHandle } from '../../helpers/e2e_multitab_helper';
import { startFixtureServer } from '../../helpers/server';
import { sendControlEval } from '../../../src/interface/control/client';
import type { Action } from '../../../src/interface/actions/action_protocol';
import type { StepUnion } from '../../../src/automation/runner/steps/types';

const WORKSPACE = 'default';

const action = (type: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName: WORKSPACE,
    payload,
    at: Date.now(),
});

const step = <T extends StepUnion['name']>(
    id: string,
    name: T,
    args: Extract<StepUnion, { name: T }>['args'],
): Extract<StepUnion, { name: T }> => ({id, name, args} as Extract<StepUnion, { name: T }>);

const run = async (agent: AgentHandle, s: StepUnion) => {
    const result = await runStep(agent.endpoint, WORKSPACE, s);
    expect(result.ok, JSON.stringify(result.error ?? {})).toBe(true);
    return result.data;
};

const freshness = async (agent: AgentHandle): Promise<{status: string; refreshReason?: string}> => {
    const response = await sendControlEval({
        source: `
            const tab = ctx.resolveWorkspace(input.ws).tabs.getActiveTab();
            if (!tab || !tab.page) { return { status: 'no-page' }; }
            return ctx.deps.pageSession.readFreshness(tab.page, tab.page.url());
        `,
        input: {ws: WORKSPACE},
    }, {endpoint: agent.endpoint});
    expect(response.ok, response.error?.message ?? '').toBe(true);
    return response.result as {status: string; refreshReason?: string};
};

const captureEnvelope = async (agent: AgentHandle): Promise<{nodeId: string; meta: {pageEpoch: string; captureRevision: number}}> => {
    const data = await run(agent, step('capture', 'browser.capture_resolve', {selector: '#submit'}));
    const target = (data as {target: {nodeId: string; meta: {pageEpoch: string; captureRevision: number}}}).target;
    return target;
};

const scheduleSelfMutation = async (agent: AgentHandle): Promise<void> => {
    await run(agent, step('schedule-mutation', 'browser.evaluate', {
        expression: `setTimeout(() => { document.getElementById('submit').textContent = 'Submit now'; }, 50); true`,
    }));
};

test('a page that mutates itself invalidates the observed world and re-observation recaptures exactly once', async ({browserName}, testInfo) => {
    void browserName;
    testInfo.setTimeout(120_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    try {
        await run(agent, step('open-page', 'browser.goto', {url: `${fixture.baseURL}/agent_world/self_mutating.html`}));

        // Observed world revision N on a quiet page.
        const first = await captureEnvelope(agent);
        await expect.poll(async () => (await freshness(agent)).status, {timeout: 10_000}).toBe('fresh');

        // The page changes itself via a timer; no rpa-browser tool mutates it.
        await scheduleSelfMutation(agent);
        await expect.poll(async () => (await freshness(agent)).status, {timeout: 10_000}).toBe('dirty');

        // Re-observation recaptures to N+1 and the session is consumed back to fresh.
        const refreshed = await captureEnvelope(agent);
        expect(refreshed.meta.pageEpoch).toBe(first.meta.pageEpoch);
        expect(refreshed.meta.captureRevision).toBe(first.meta.captureRevision + 1);
        await expect.poll(async () => (await freshness(agent)).status, {timeout: 10_000}).toBe('fresh');

        // A quiet page never spuriously bumps: repeated snapshot reads stay fresh
        // and keep the same revision.
        await run(agent, step('snapshot-1', 'browser.snapshot', {}));
        await run(agent, step('snapshot-2', 'browser.snapshot', {}));
        expect(await freshness(agent)).toMatchObject({status: 'fresh'});
        const stable = await captureEnvelope(agent);
        expect(stable.meta.captureRevision).toBe(refreshed.meta.captureRevision);
        expect(await freshness(agent)).toMatchObject({status: 'fresh'});
    } finally {
        await agent.close();
        await fixture.close();
    }
});

test('the observer is reinstalled on navigation so a mutated new document dirties the session again', async ({browserName}, testInfo) => {
    void browserName;
    testInfo.setTimeout(120_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    try {
        const firstUrl = `${fixture.baseURL}/agent_world/self_mutating.html`;
        await run(agent, step('open-page', 'browser.goto', {url: firstUrl}));
        await captureEnvelope(agent);
        await expect.poll(async () => (await freshness(agent)).status, {timeout: 10_000}).toBe('fresh');

        // Navigate to a new document (same fixture, distinct URL).
        await run(agent, step('navigate', 'browser.goto', {url: `${firstUrl}?page=2`}));
        const afterNav = await captureEnvelope(agent);
        await expect.poll(async () => (await freshness(agent)).status, {timeout: 10_000}).toBe('fresh');

        // The new document's observer must have been reinstalled by the init script.
        await scheduleSelfMutation(agent);
        await expect.poll(async () => (await freshness(agent)).status, {timeout: 10_000}).toBe('dirty');
        const again = await captureEnvelope(agent);
        expect(again.meta.captureRevision).toBe(afterNav.meta.captureRevision + 1);
    } finally {
        await agent.close();
        await fixture.close();
    }
});

test('closing a managed page tears the observer down without breaking later page sessions', async ({browserName}, testInfo) => {
    void browserName;
    testInfo.setTimeout(120_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    try {
        await run(agent, step('open-page', 'browser.goto', {url: `${fixture.baseURL}/agent_world/self_mutating.html`}));
        const first = await captureEnvelope(agent);
        expect(first.meta.captureRevision).toBeGreaterThan(0);

        const closed = await dispatch(agent.endpoint, action('tab.close', {tabName: 'main'}));
        expect(closed.type).toBe('tab.close.result');

        // A fresh tab gets a clean page session and observer after close.
        await run(agent, step('reopen', 'browser.goto', {url: `${fixture.baseURL}/agent_world/self_mutating.html?reopen=1`}));
        const reopened = await captureEnvelope(agent);
        expect(reopened.meta.pageEpoch).not.toBe(first.meta.pageEpoch);
        await scheduleSelfMutation(agent);
        await expect.poll(async () => (await freshness(agent)).status, {timeout: 10_000}).toBe('dirty');
    } finally {
        await agent.close();
        await fixture.close();
    }
});