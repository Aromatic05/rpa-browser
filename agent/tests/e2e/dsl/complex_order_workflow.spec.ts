import {test, expect} from '@playwright/test';
import crypto from 'node:crypto';
import {dispatch, runStep, startAgent} from '../../helpers/e2e_multitab_helper';
import {startFixtureServer} from '../../helpers/server';
import type {Action} from '../../../src/actions/action_protocol';
import type {StepUnion} from '../../../src/runner/steps/types';

type AgentHandle = Awaited<ReturnType<typeof startAgent>>;

type WorkflowState = {
    authenticated: boolean;
    sessionValid: boolean;
    expiryInjected: boolean;
    loginCount: number;
    renewalCount: number;
    approvedOrders: string[];
    events: string[];
};

const WORKSPACE_NAME = 'default';
const WORKFLOW_FIXTURE = 'tests/fixtures/workflows/dsl_order_workflow';

const action = (type: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName: WORKSPACE_NAME,
    payload,
    at: Date.now(),
});

const step = <T extends StepUnion['name']>(
    id: string,
    name: T,
    args: Extract<StepUnion, {name: T}>['args'],
): Extract<StepUnion, {name: T}> => ({id, name, args} as Extract<StepUnion, {name: T}>);

const useExistingBrowserTab = async (agent: AgentHandle, url: string): Promise<void> => {
    let tabName = '';
    await expect.poll(async () => {
        const listed = await dispatch(agent.endpoint, action('tab.list'));
        const tabs = (listed.payload as {tabs?: Array<{tabName: string; active?: boolean}>})?.tabs || [];
        tabName = tabs.find((tab) => tab.active)?.tabName || tabs[0]?.tabName || '';
        return tabName;
    }, {timeout: 20_000}).not.toBe('');

    const switched = await runStep(
        agent.endpoint,
        WORKSPACE_NAME,
        step('switch-existing-tab', 'browser.switch_tab', {tabName}),
    );
    expect(switched.ok, JSON.stringify(switched.error || {})).toBe(true);

    const navigated = await runStep(
        agent.endpoint,
        WORKSPACE_NAME,
        step('open-workflow-page', 'browser.goto', {url}),
    );
    expect(navigated.ok, JSON.stringify(navigated.error || {})).toBe(true);
};

const evaluate = async <T>(agent: AgentHandle, expression: string): Promise<T> => {
    const result = await runStep(
        agent.endpoint,
        WORKSPACE_NAME,
        step(`evaluate-${crypto.randomUUID()}`, 'browser.evaluate', {expression}),
    );
    if (!result.ok) {
        throw new Error(`browser.evaluate failed: ${JSON.stringify(result.error || {})}`);
    }
    return result.data as T;
};

test('executes a persisted DSL workflow with entity rules, checkpoints, table enumeration, and recovery', async ({browserName}, testInfo) => {
    void browserName;
    testInfo.setTimeout(180_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent({workflowFixtureDir: WORKFLOW_FIXTURE});
    try {
        await useExistingBrowserTab(agent, `${fixture.baseURL}/dsl_order_workflow.html`);

        const loaded = await dispatch(agent.endpoint, action('dsl.get', {dslName: 'main'}));
        expect(loaded.type).toBe('dsl.get.result');
        expect(typeof (loaded.payload as {content?: unknown}).content).toBe('string');

        const validated = await dispatch(agent.endpoint, action('dsl.validate', {dslName: 'main'}));
        expect(validated.type).toBe('dsl.validate.result');
        expect((validated.payload as {ok?: boolean; diagnostics?: unknown[]}).ok).toBe(true);
        expect((validated.payload as {diagnostics?: unknown[]}).diagnostics).toEqual([]);
        expect(await evaluate<WorkflowState>(agent, `
            return JSON.parse(document.body.dataset.workflowState || '{}');
        `)).toMatchObject({authenticated: false, loginCount: 0, renewalCount: 0, approvedOrders: []});

        const ran = await dispatch(agent.endpoint, action('dsl.run', {
            dslName: 'main',
            input: {username: 'operator', password: 'correct-horse'},
        }));
        expect(ran.type, JSON.stringify(ran.payload || {})).toBe('dsl.run.result');
        const output = (ran.payload as {output?: {processedRows?: Array<Record<string, unknown>>}}).output;
        expect(output?.processedRows?.map((row) => row.orderNo)).toEqual(['PO-101', 'PO-102', 'PO-103']);

        await expect.poll(async () => await evaluate<WorkflowState>(agent, `
            return JSON.parse(document.body.dataset.workflowState || '{}');
        `), {timeout: 30_000}).toEqual({
            authenticated: true,
            sessionValid: true,
            expiryInjected: true,
            loginCount: 1,
            renewalCount: 1,
            approvedOrders: ['PO-101', 'PO-102', 'PO-103'],
            events: [
                'login:operator',
                'approve:PO-101',
                'session-expired',
                'session-renewed',
                'approve:PO-102',
                'approve:PO-103',
            ],
        });
        expect(await evaluate(agent, `
            return Object.fromEntries([...document.querySelectorAll('#orders-table tbody tr')]
                .map((row) => [row.dataset.orderNo, row.querySelector('.order-status')?.textContent || '']));
        `)).toEqual({'PO-101': '已批准', 'PO-102': '已批准', 'PO-103': '已批准'});
    } finally {
        await agent.close();
        await fixture.close();
    }
});
