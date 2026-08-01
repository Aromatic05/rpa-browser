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

const action = (type: string, workspaceName: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName,
    payload,
    at: Date.now(),
});

const controlAction = (type: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    payload,
    at: Date.now(),
});

const step = <T extends StepUnion['name']>(
    id: string,
    name: T,
    args: Extract<StepUnion, {name: T}>['args'],
): Extract<StepUnion, {name: T}> => ({id, name, args} as Extract<StepUnion, {name: T}>);

const createWorkspacePage = async (agent: AgentHandle, workspaceName: string, url: string): Promise<void> => {
    expect((await dispatch(agent.endpoint, controlAction('workspace.create', {workspaceName}))).type)
        .toBe('workspace.create.result');
    const before = await dispatch(agent.endpoint, action('tab.list', workspaceName));
    const beforeNames = new Set(
        ((before.payload as {tabs?: Array<{tabName: string}>})?.tabs || []).map((tab) => tab.tabName),
    );
    expect((await dispatch(agent.endpoint, action('tab.open', workspaceName))).type).toBe('tab.open.result');
    let tabName = '';
    await expect.poll(async () => {
        const listed = await dispatch(agent.endpoint, action('tab.list', workspaceName));
        tabName = ((listed.payload as {tabs?: Array<{tabName: string}>})?.tabs || [])
            .find((tab) => !beforeNames.has(tab.tabName))?.tabName || '';
        return tabName;
    }, {timeout: 20_000}).not.toBe('');
    expect((await runStep(agent.endpoint, workspaceName, step('switch-tab', 'browser.switch_tab', {tabName}))).ok)
        .toBe(true);
    expect((await runStep(agent.endpoint, workspaceName, step('open-page', 'browser.goto', {url}))).ok)
        .toBe(true);
};

const evaluate = async <T>(agent: AgentHandle, workspaceName: string, expression: string): Promise<T> => {
    const result = await runStep(
        agent.endpoint,
        workspaceName,
        step(`evaluate-${crypto.randomUUID()}`, 'browser.evaluate', {expression}),
    );
    if (!result.ok) {
        throw new Error(`browser.evaluate failed: ${JSON.stringify(result.error || {})}`);
    }
    return result.data as T;
};

const saveEntityRules = async (
    agent: AgentHandle,
    workspaceName: string,
    payload: Record<string, unknown>,
): Promise<void> => {
    const saved = await dispatch(agent.endpoint, action('entity_rules.save', workspaceName, payload));
    expect(saved.type).toBe('entity_rules.save.result');
};

const saveLoginRules = async (agent: AgentHandle, workspaceName: string): Promise<void> => {
    await saveEntityRules(agent, workspaceName, {
        profileName: 'dsl-login-rule',
        page: {kind: 'form', urlPattern: 'dsl_order_workflow\\.html'},
        match: {
            version: 2,
            rules: [
                {ruleId: 'login-root', source: 'region', expect: 'unique', match: {kind: 'form', idEquals: 'login-form'}},
                {ruleId: 'username', source: 'node', expect: 'unique', within: 'login-root', match: {idEquals: 'username'}},
                {ruleId: 'password', source: 'node', expect: 'unique', within: 'login-root', match: {idEquals: 'password'}},
                {ruleId: 'submit', source: 'node', expect: 'unique', within: 'login-root', match: {idEquals: 'login-submit'}},
            ],
        },
        annotation: {
            version: 2,
            bindings: [
                {ruleId: 'login-root', entityKey: 'loginForm', businessTag: 'auth.login', entityKind: 'form', displayName: '系统登录'},
                {ruleId: 'username', fieldKey: 'username', fieldRole: 'field', fieldName: '用户名'},
                {ruleId: 'password', fieldKey: 'password', fieldRole: 'field', fieldName: '密码'},
                {ruleId: 'submit', actionIntent: 'submit', actionRole: 'form', actionText: '登录'},
            ],
        },
    });
};

const saveOrderRules = async (agent: AgentHandle, workspaceName: string): Promise<void> => {
    await saveEntityRules(agent, workspaceName, {
        profileName: 'dsl-orders-rule',
        page: {kind: 'table', urlPattern: 'dsl_order_workflow\\.html'},
        match: {
            version: 2,
            rules: [
                {ruleId: 'orders-root', source: 'region', expect: 'unique', match: {kind: 'table', idEquals: 'orders-table'}},
                {ruleId: 'approve', source: 'node', expect: 'one_or_more', within: 'orders-root', match: {classContains: 'approve-order'}},
            ],
        },
        annotation: {
            version: 2,
            bindings: [
                {
                    ruleId: 'orders-root',
                    entityKey: 'ordersTable',
                    businessTag: 'orders.pending',
                    entityKind: 'table',
                    displayName: '待审批订单',
                    primaryKey: {fieldKey: 'orderNo', columns: ['订单编号'], source: 'annotation'},
                    columns: [
                        {fieldKey: 'orderNo', name: '订单编号', source: 'annotation'},
                        {fieldKey: 'applicant', name: '申请人', source: 'annotation'},
                        {fieldKey: 'status', name: '状态', source: 'annotation'},
                        {
                            fieldKey: 'actions',
                            name: '操作',
                            kind: 'action_column',
                            source: 'annotation',
                            actions: [{actionIntent: 'approve', text: '批准'}],
                        },
                    ],
                },
                {ruleId: 'approve', actionIntent: 'approve', actionRole: 'row', actionText: '批准', columnFieldKey: 'actions'},
            ],
        },
    });
};

const saveSessionRules = async (agent: AgentHandle, workspaceName: string): Promise<void> => {
    await saveEntityRules(agent, workspaceName, {
        profileName: 'dsl-session-rule',
        page: {kind: 'panel', urlPattern: 'dsl_order_workflow\\.html'},
        match: {
            version: 2,
            rules: [
                {ruleId: 'expired-root', source: 'region', expect: 'unique', match: {kind: 'panel', idEquals: 'session-expired'}},
                {ruleId: 'renew', source: 'node', expect: 'unique', within: 'expired-root', match: {idEquals: 'renew-session'}},
            ],
        },
        annotation: {
            version: 2,
            bindings: [
                {ruleId: 'expired-root', entityKey: 'expiredSession', businessTag: 'auth.expired', entityKind: 'panel', displayName: '会话失效'},
                {ruleId: 'renew', actionIntent: 'renew', actionRole: 'form', actionText: '续期并继续'},
            ],
        },
    });
};

const saveCheckpoints = async (agent: AgentHandle, workspaceName: string): Promise<void> => {
    const login = await dispatch(agent.endpoint, action('checkpoint.save', workspaceName, {
        checkpoint: {
            id: 'login-to-orders',
            kind: 'procedure',
            name: '登录订单系统',
            body: {language: 'dsl', source: 'body.dsl'},
        },
        bodyDsl: `
use entity_rules "dsl-login-rule" as auth
fill auth.loginForm.username with input.username
fill auth.loginForm.password with input.password
click auth.loginForm.submit
output authenticatedUser = input.username
`,
    }));
    expect(login.type).toBe('checkpoint.save.result');

    const recovery = await dispatch(agent.endpoint, action('checkpoint.save', workspaceName, {
        checkpoint: {
            id: 'renew-expired-session',
            kind: 'recovery',
            name: '续期登录会话',
            enabled: true,
            priority: 100,
            trigger: {
                matchRules: [
                    {errorCode: 'ERR_UNRESOLVED'},
                    {entityExists: {query: '', kind: 'panel', businessTag: 'auth.expired'}},
                ],
                entityRules: {selection: 'explicit', profiles: ['dsl-session-rule'], strict: true},
            },
            policy: {maxAttempts: 1, retryOriginal: true},
            body: {language: 'dsl', source: 'body.dsl'},
        },
        bodyDsl: `
use entity_rules "dsl-session-rule" as session
click session.expiredSession.renew
`,
    }));
    expect(recovery.type).toBe('checkpoint.save.result');
};

const saveMainDsl = async (agent: AgentHandle, workspaceName: string): Promise<void> => {
    const saved = await dispatch(agent.endpoint, action('dsl.save', workspaceName, {
        dslName: 'main',
        content: `
use entity_rules "dsl-orders-rule" as orders
use checkpoint "login-to-orders" with {
  username: input.username
  password: input.password
}
let rows = query orders.ordersTable.currentRows
for row in vars.rows:
  click orders.ordersTable.row(row.orderNo).approve
output processedRows = vars.rows
`,
    }));
    expect(saved.type).toBe('dsl.save.result');
};

test('runs login, table enumeration, row actions, and automatic session recovery through saved DSL assets', async ({browserName: _browserName}, testInfo) => {
    testInfo.setTimeout(180_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    const workspaceName = `dsl-order-workflow-${Date.now()}`;
    try {
        await createWorkspacePage(agent, workspaceName, `${fixture.baseURL}/dsl_order_workflow.html`);
        await saveLoginRules(agent, workspaceName);
        await saveOrderRules(agent, workspaceName);
        await saveSessionRules(agent, workspaceName);
        await saveCheckpoints(agent, workspaceName);
        await saveMainDsl(agent, workspaceName);

        const validated = await dispatch(agent.endpoint, action('dsl.validate', workspaceName, {dslName: 'main'}));
        expect(validated.type).toBe('dsl.validate.result');
        expect((validated.payload as {ok?: boolean; diagnostics?: unknown[]}).ok).toBe(true);
        expect((validated.payload as {diagnostics?: unknown[]}).diagnostics).toEqual([]);
        expect(await evaluate<WorkflowState>(agent, workspaceName, `
            return JSON.parse(document.body.dataset.workflowState || '{}');
        `)).toMatchObject({authenticated: false, loginCount: 0, renewalCount: 0, approvedOrders: []});

        const ran = await dispatch(agent.endpoint, action('dsl.run', workspaceName, {
            dslName: 'main',
            input: {username: 'operator', password: 'correct-horse'},
        }));
        expect(ran.type, JSON.stringify(ran.payload || {})).toBe('dsl.run.result');
        const output = (ran.payload as {output?: {processedRows?: Array<Record<string, unknown>>}}).output;
        expect(output?.processedRows?.map((row) => row.orderNo)).toEqual(['PO-101', 'PO-102', 'PO-103']);

        await expect.poll(async () => await evaluate<WorkflowState>(agent, workspaceName, `
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
        expect(await evaluate(agent, workspaceName, `
            return Object.fromEntries([...document.querySelectorAll('#orders-table tbody tr')]
                .map((row) => [row.dataset.orderNo, row.querySelector('.order-status')?.textContent || '']));
        `)).toEqual({'PO-101': '已批准', 'PO-102': '已批准', 'PO-103': '已批准'});
    } finally {
        await agent.close();
        await fixture.close();
    }
});
