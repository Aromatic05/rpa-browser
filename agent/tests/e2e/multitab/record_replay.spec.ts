import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import type { StepUnion } from '../../../src/runner/steps/types';
import type { Action } from '../../../src/actions/action_protocol';
import { createMultitabHarness } from '../../helpers/e2e_multitab_helper';

const step = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args']): Extract<StepUnion, { name: T }> => ({
    id,
    name,
    args,
});

const mustOk = (result: { ok: boolean; error?: { code?: string; message?: string } }, label: string) => {
    expect(result.ok, `${label} failed: ${JSON.stringify(result.error)}`).toBeTruthy();
};

const delay = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms));
const pauseForHeaded = async (ms: number) => await delay(process.env.RPA_E2E_HEADED === '1' ? ms : 0);
const nowIso = () => new Date().toISOString();
const logStep = (message: string) => console.log(`[e2e-multitab][${nowIso()}] ${message}`);

const listTabs = async (
    harness: Awaited<ReturnType<typeof createMultitabHarness>>,
    workspaceName: string,
): Promise<Array<{ tabName: string; url: string; active: boolean }>> => {
    const reply = await harness.dispatchAction({
        v: 1,
        id: crypto.randomUUID(),
        type: 'tab.list',
        workspaceName,
        at: Date.now(),
    });
    expect(reply.type).toBe('tab.list.result');
    return (((reply.payload || {}) as { tabs?: Array<{ tabName: string; url: string; active: boolean }> }).tabs || []);
};

const closeTabRequired = async (
    harness: Awaited<ReturnType<typeof createMultitabHarness>>,
    workspaceName: string,
    tabName: string,
) => {
    const before = await listTabs(harness, workspaceName);
    expect(before.map((t) => t.tabName)).toContain(tabName);
    const reply = await harness.dispatchAction({
        v: 1,
        id: crypto.randomUUID(),
        type: 'tab.close',
        workspaceName,
        payload: { tabName },
        at: Date.now(),
    });
    expect(reply.type).toBe('tab.close.result');
};

const clickAndCaptureOpenedTab = async (
    harness: Awaited<ReturnType<typeof createMultitabHarness>>,
    workspaceName: string,
    clickStep: Extract<StepUnion, { name: 'browser.click' }>,
    urlPart: string,
) => {
    const beforeTabs = await listTabs(harness, workspaceName);
    const beforeNames = beforeTabs.map((tab) => tab.tabName);
    const clickResult = await harness.runStep(workspaceName, clickStep);
    mustOk(clickResult, clickStep.id);
    await expect
        .poll(async () => {
            const afterTabs = await listTabs(harness, workspaceName);
            return afterTabs.filter((tab) => tab.url.includes(urlPart) && !beforeNames.includes(tab.tabName)).length;
        }, { timeout: 15000 })
        .toBe(1);
    const afterTabs = await listTabs(harness, workspaceName);
    const opened = afterTabs.filter((tab) => tab.url.includes(urlPart) && !beforeNames.includes(tab.tabName));
    expect(opened.length).toBe(1);
    return opened[0];
};

test('records and replays active and passive multi-tab workflow', async () => {
    const harness = await createMultitabHarness();

    const dispatchLogged = async (label: string, action: Action) => {
        const reply = await harness.dispatchAction(action);
        logStep(`${label} -> ${reply.type}`);
        return reply;
    };
    const runStepLogged = async (workspaceName: string, label: string, s: StepUnion) => {
        const result = await harness.runStep(workspaceName, s);
        logStep(`${label} -> ok=${String(result.ok)}`);
        return result;
    };

    const workbenchUrl = `${harness.baseURL}/multitab/workbench.html`;
    const kbUrl = `${harness.baseURL}/multitab/knowledge_base.html`;

    logStep('create workspace and open workbench');
    const first = await harness.createWorkspaceAndOpen(workbenchUrl);
    logStep(`workspace created workspaceName=${first.workspaceName} tabName=${first.tabName}`);
    const workspaceName = first.workspaceName;
    const workbenchTabName = first.tabName;

    // 契约: 初始 tab 唯一，无幽灵
    {
        const tabs = await listTabs(harness, workspaceName);
        expect(tabs.length).toBe(1);
        expect(tabs[0]?.tabName).toBe(workbenchTabName);
    }

    const recordStart = await dispatchLogged('record.start', { v: 1, id: crypto.randomUUID(), type: 'record.start', workspaceName, at: Date.now() });
    expect(recordStart.type).toBe('record.start.result');
    await harness.waitForWorkspaceState(workspaceName, 'recording');

    const createdKb = await runStepLogged(workspaceName, 'kb create recorded', step('kb-create-recorded', 'browser.create_tab', {}));
    mustOk(createdKb, 'kb create recorded');
    const knowledgeTabName = typeof (createdKb.data as any)?.tab_id === 'string' ? (createdKb.data as any).tab_id : '';
    expect(knowledgeTabName).toBeTruthy();

    // 契约: 主动建 tab 后 2 条记录，无幽灵
    {
        const tabs = await listTabs(harness, workspaceName);
        expect(tabs.length).toBe(2);
        const names = tabs.map((t) => t.tabName);
        expect(names).toContain(workbenchTabName);
        expect(names).toContain(knowledgeTabName);
    }

    mustOk(await runStepLogged(workspaceName, 'switch kb recorded', step('switch-kb-recorded', 'browser.switch_tab', { tabName: knowledgeTabName })), 'switch kb recorded');
    mustOk(await runStepLogged(workspaceName, 'kb goto recorded', step('kb-goto-recorded', 'browser.goto', { url: kbUrl })), 'kb goto recorded');
    mustOk(await runStepLogged(workspaceName, 'kb fill', step('kb-fill', 'browser.fill', { selector: '#kbSearch', value: '退款规则' })), 'kb fill');
    mustOk(await runStepLogged(workspaceName, 'kb quote click', step('kb-click-quote', 'browser.click', { selector: '#quoteRefundRule' })), 'kb quote click');
    const kbRuleState = await runStepLogged(workspaceName, 'kb check rule', step('kb-check-rule', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=kb-root]")?.dataset.selectedRule || "";' }));
    mustOk(kbRuleState, 'kb rule state');
    expect(kbRuleState.data).toBe('refund-policy');

    mustOk(await runStepLogged(workspaceName, 'switch workbench 1', step('switch-workbench-1', 'browser.switch_tab', { tabName: workbenchTabName })), 'switch workbench 1');

    // ── payment: 被动开页 ──
    const paymentTab = await clickAndCaptureOpenedTab(
        harness,
        workspaceName,
        step('wb-open-payment', 'browser.click', { selector: '#openPaymentBtn' }),
        '/multitab/payment_check.html',
    );
    logStep(`open payment -> tabName=${paymentTab.tabName}`);
    // 契约: 被动开页新 tabName 不与 workbench 相同
    expect(paymentTab.tabName).not.toBe(workbenchTabName);
    {
        const tabs = await listTabs(harness, workspaceName);
        // 契约: workbench URL 未被覆盖
        const wb = tabs.find((t) => t.tabName === workbenchTabName);
        expect(wb?.url).toContain('/multitab/workbench.html');
    }

    mustOk(await runStepLogged(workspaceName, 'switch payment', step('switch-payment', 'browser.switch_tab', { tabName: paymentTab.tabName })), 'switch payment');
    mustOk(await runStepLogged(workspaceName, 'approve payment', step('payment-approve', 'browser.click', { selector: '#approvePayment' })), 'approve payment');
    const paymentVerified = await runStepLogged(workspaceName, 'payment verify state', step('payment-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=payment-root]")?.dataset.paymentVerified || "";' }));
    mustOk(paymentVerified, 'payment verify state');
    expect(paymentVerified.data).toBe('true');
    await dispatchLogged('tab.close payment', { v: 1, id: crypto.randomUUID(), type: 'tab.close', workspaceName, payload: { tabName: paymentTab.tabName }, at: Date.now() });

    // 契约: 关闭 payment 后 tab 数回落到关闭前
    {
        const tabs = await listTabs(harness, workspaceName);
        expect(tabs.length).toBe(2);
        const names = tabs.map((t) => t.tabName);
        expect(names).toContain(workbenchTabName);
        expect(names).toContain(knowledgeTabName);
        expect(names).not.toContain(paymentTab.tabName);
    }

    mustOk(await runStepLogged(workspaceName, 'switch workbench 2', step('switch-workbench-2', 'browser.switch_tab', { tabName: workbenchTabName })), 'switch workbench 2');

    // ── customer: 被动开页 ──
    const customerTab = await clickAndCaptureOpenedTab(
        harness,
        workspaceName,
        step('wb-open-customer', 'browser.click', { selector: '#openCustomerBtn' }),
        '/multitab/customer_detail.html',
    );
    logStep(`open customer -> tabName=${customerTab.tabName}`);
    expect(customerTab.tabName).not.toBe(workbenchTabName);

    mustOk(await runStepLogged(workspaceName, 'switch customer', step('switch-customer', 'browser.switch_tab', { tabName: customerTab.tabName })), 'switch customer');
    mustOk(await runStepLogged(workspaceName, 'mark vip risk', step('customer-mark-risk', 'browser.click', { selector: '#markVipRisk' })), 'mark vip risk');
    const customerTag = await runStepLogged(workspaceName, 'customer tag check', step('customer-check-tag', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=customer-root]")?.dataset.customerTag || "";' }));
    mustOk(customerTag, 'customer tag check');
    expect(customerTag.data).toBe('vip-risk');
    await dispatchLogged('tab.close customer', { v: 1, id: crypto.randomUUID(), type: 'tab.close', workspaceName, payload: { tabName: customerTab.tabName }, at: Date.now() });

    {
        const tabs = await listTabs(harness, workspaceName);
        expect(tabs.length).toBe(2);
        expect(tabs.map((t) => t.tabName)).not.toContain(customerTab.tabName);
    }

    mustOk(await runStepLogged(workspaceName, 'switch workbench 3', step('switch-workbench-3', 'browser.switch_tab', { tabName: workbenchTabName })), 'switch workbench 3');

    // ── audit: 被动开页 ──
    const auditTab = await clickAndCaptureOpenedTab(
        harness,
        workspaceName,
        step('wb-open-audit', 'browser.click', { selector: '#openAuditBtn' }),
        '/multitab/audit_log.html',
    );
    logStep(`open audit -> tabName=${auditTab.tabName}`);
    expect(auditTab.tabName).not.toBe(workbenchTabName);

    mustOk(await runStepLogged(workspaceName, 'switch audit', step('switch-audit', 'browser.switch_tab', { tabName: auditTab.tabName })), 'switch audit');
    mustOk(await runStepLogged(workspaceName, 'confirm audit', step('audit-confirm-reviewed', 'browser.click', { selector: '#confirmAuditReviewed' })), 'confirm audit');
    const auditReviewed = await runStepLogged(workspaceName, 'audit reviewed check', step('audit-check-reviewed', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=audit-root]")?.dataset.auditReviewed || "";' }));
    mustOk(auditReviewed, 'audit reviewed check');
    expect(auditReviewed.data).toBe('true');
    await dispatchLogged('tab.close audit', { v: 1, id: crypto.randomUUID(), type: 'tab.close', workspaceName, payload: { tabName: auditTab.tabName }, at: Date.now() });

    {
        const tabs = await listTabs(harness, workspaceName);
        expect(tabs.length).toBe(2);
        expect(tabs.map((t) => t.tabName)).not.toContain(auditTab.tabName);
    }

    mustOk(await runStepLogged(workspaceName, 'switch workbench 4', step('switch-workbench-4', 'browser.switch_tab', { tabName: workbenchTabName })), 'switch workbench 4');
    mustOk(await runStepLogged(workspaceName, 'workbench sync customer', step('wb-sync-customer', 'browser.click', { selector: '#syncCustomerBtn' })), 'workbench sync customer');
    mustOk(await runStepLogged(workspaceName, 'workbench mark done', step('wb-mark-done', 'browser.click', { selector: '#markDoneBtn' })), 'workbench mark done');

    const recordStop = await dispatchLogged('record.stop', { v: 1, id: crypto.randomUUID(), type: 'record.stop', workspaceName, at: Date.now() });
    expect(recordStop.type).toBe('record.stop.result');
    await harness.waitForWorkspaceState(workspaceName, 'idle');

    const recordGet = await dispatchLogged('record.get', { v: 1, id: crypto.randomUUID(), type: 'record.get', workspaceName, at: Date.now() });
    expect(recordGet.type).toBe('record.get.result');
    const recordingSteps = ((((recordGet.payload || {}) as { steps?: Array<{ name: string; args?: Record<string, unknown> }> }).steps) || []);

    const names = recordingSteps.map((s) => s.name);
    expect(names).toContain('browser.create_tab');
    expect(names).toContain('browser.switch_tab');
    expect(names).toContain('browser.close_tab');
    expect(names.filter((name) => name === 'browser.switch_tab').length).toBeGreaterThanOrEqual(4);

    const recordingName = `multitab-e2e-${Date.now()}`;
    const recordSave = await dispatchLogged('record.save', {
        v: 1,
        id: crypto.randomUUID(),
        type: 'record.save',
        workspaceName,
        payload: { recordingName },
        at: Date.now(),
    });
    expect(recordSave.type).toBe('record.save.result');

    // ── 重置: 关 kb，只留 workbench ──
    await closeTabRequired(harness, workspaceName, knowledgeTabName);
    const tabsBeforeReset = await listTabs(harness, workspaceName);
    // 契约: 仅剩 workbench
    expect(tabsBeforeReset.length).toBe(1);
    expect(tabsBeforeReset[0]?.tabName).toBe(workbenchTabName);

    await runStepLogged(workspaceName, 'switch before replay', step('switch-workbench-before-replay', 'browser.switch_tab', { tabName: workbenchTabName }));
    await runStepLogged(workspaceName, 'clear workbench storage', step('reset-workbench-clear-storage', 'browser.evaluate', { expression: 'localStorage.clear(); return true;' }));
    await runStepLogged(workspaceName, 'reload workbench for reset', step('reset-workbench-goto', 'browser.goto', { url: `${workbenchUrl}?e2e_reset=${Date.now()}` }));

    const resetTabs = await listTabs(harness, workspaceName);
    // 契约: reload 后仍仅 1 条 workbench
    expect(resetTabs.length).toBe(1);
    expect(resetTabs[0]?.tabName).toBe(workbenchTabName);
    expect(resetTabs[0]?.active).toBeTruthy();

    const resetState = await harness.readWorkbenchState(workspaceName);
    expect(resetState.ticketStatus).toBe('pending');
    expect(resetState.usedRule).toBe('');
    expect(resetState.paymentStatus).toBe('pending');
    expect(resetState.customerSynced).toBe('false');
    expect(resetState.auditOpened).toBe('false');

    await pauseForHeaded(1200);
    logStep(`Starting replay with recording ${recordingName}`);

    const playStart = await dispatchLogged('play.start', {
        v: 1,
        id: crypto.randomUUID(),
        type: 'play.start',
        workspaceName,
        payload: { recordingName, stopOnError: true },
        at: Date.now(),
    });
    expect(playStart.type).toBe('play.started');
    await harness.waitForWorkspaceState(workspaceName, 'idle');
    await pauseForHeaded(1500);

    const replayStepEntries = await harness.readReplayStepEntries();
    expect(replayStepEntries.length).toBe(recordingSteps.length);
    replayStepEntries.forEach((entry, index) => {
        expect(entry.ok).toBeTruthy();
        expect(entry.stepName).toBe(recordingSteps[index]?.name);
    });

    // ── 回放后状态 ──
    const replayTabs = await listTabs(harness, workspaceName);
    // 契约: 回放后 workbench + kb 两个 tab
    expect(replayTabs.length).toBe(2);
    const activeTabs = replayTabs.filter((tab) => tab.active);
    expect(activeTabs.length).toBe(1);
    expect(activeTabs[0]?.tabName).toBe(workbenchTabName);
    expect(replayTabs.filter((tab) => tab.url.includes('/multitab/knowledge_base.html')).length).toBe(1);
    // 契约: payment/customer/audit 均已关闭
    expect(replayTabs.filter((tab) => tab.url.includes('/multitab/payment_check.html')).length).toBe(0);
    expect(replayTabs.filter((tab) => tab.url.includes('/multitab/customer_detail.html')).length).toBe(0);
    expect(replayTabs.filter((tab) => tab.url.includes('/multitab/audit_log.html')).length).toBe(0);

    const replayState = await harness.readWorkbenchState(workspaceName);
    expect(replayState.ticketStatus).toBe('done');
    expect(replayState.usedRule).toBe('refund-policy');
    expect(replayState.paymentStatus).toBe('verified');
    expect(replayState.customerSynced).toBe('true');
    expect(replayState.auditOpened).toBe('true');

    await harness.close();
});

test.setTimeout(180000);
