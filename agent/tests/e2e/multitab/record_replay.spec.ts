import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import type { StepUnion } from '../../../src/runner/steps/types';
import { createMultitabHarness } from '../../helpers/e2e_multitab_helper';

const step = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args']): Extract<StepUnion, { name: T }> => ({
    id,
    name,
    args,
});

const mustOk = (result: { ok: boolean; error?: { code?: string; message?: string } }, label: string) => {
    if (!result.ok) {
        throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
    }
};

const delay = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms));

const pauseForHeaded = async (ms: number) => {
    if (process.env.RPA_E2E_HEADED === '1') {
        await delay(ms);
    }
};

const reportCreateTabStep = async (
    harness: Awaited<ReturnType<typeof createMultitabHarness>>,
    workspaceName: string,
    tabName: string,
) => {
    const reply = await harness.dispatchAction({
        v: 1,
        id: crypto.randomUUID(),
        type: 'record.event',
        workspaceName,
        payload: {
            id: crypto.randomUUID(),
            name: 'browser.create_tab',
            args: { tabName },
            meta: { source: 'record', ts: Date.now(), workspaceName, tabName },
        },
        at: Date.now(),
    });
    expect(reply.type).toBe('record.event.result');
};

const reportCloseTabStep = async (
    harness: Awaited<ReturnType<typeof createMultitabHarness>>,
    workspaceName: string,
    tabName: string,
) => {
    const reply = await harness.dispatchAction({
        v: 1,
        id: crypto.randomUUID(),
        type: 'record.event',
        workspaceName,
        payload: {
            id: crypto.randomUUID(),
            name: 'browser.close_tab',
            args: { tabName },
            meta: { source: 'record', ts: Date.now(), workspaceName, tabName },
        },
        at: Date.now(),
    });
    expect(reply.type).toBe('record.event.result');
};

const ensureWorkbenchTab = async (
    harness: Awaited<ReturnType<typeof createMultitabHarness>>,
    workspaceName: string,
    workbenchUrl: string,
): Promise<string> => {
    try {
        const tab = await harness.waitForTabByUrlPart(workspaceName, '/multitab/workbench.html');
        return tab.tabName;
    } catch {
        const reply = await harness.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.open',
            workspaceName,
            payload: { startUrl: workbenchUrl },
            at: Date.now(),
        });
        const tabName = ((reply.payload || {}) as { tabName?: string }).tabName;
        if (!tabName) {
            throw new Error(`failed to recreate workbench tab: ${JSON.stringify(reply)}`);
        }
        return tabName;
    }
};

test('records and replays active and passive multi-tab workflow', async () => {
    const harness = await createMultitabHarness();
    try {
        const workbenchUrl = `${harness.baseURL}/multitab/workbench.html`;
        const kbUrl = `${harness.baseURL}/multitab/knowledge_base.html`;

        const first = await harness.createWorkspaceAndOpen(workbenchUrl);
        const workspaceName = first.workspaceName;
        const workbenchTabName = first.tabName;

        const recordStart = await harness.dispatchAction({ v: 1, id: crypto.randomUUID(), type: 'record.start', workspaceName, at: Date.now() });
        expect(recordStart.type).toBe('record.start.result');
        await harness.waitForWorkspaceState(workspaceName, 'recording');

        const knowledgeTabName = 'knowledge_base_recorded';
        mustOk(await harness.runStep(workspaceName, step('kb-create-recorded', 'browser.create_tab', { tabName: knowledgeTabName })), 'kb create recorded');
        mustOk(await harness.runStep(workspaceName, step('switch-kb-recorded', 'browser.switch_tab', { tabName: knowledgeTabName })), 'switch kb recorded');
        mustOk(await harness.runStep(workspaceName, step('kb-goto-recorded', 'browser.goto', { url: kbUrl })), 'kb goto recorded');

        mustOk(await harness.runStep(workspaceName, step('kb-fill', 'browser.fill', { selector: '#kbSearch', value: '退款规则' })), 'kb fill');
        mustOk(await harness.runStep(workspaceName, step('kb-click-quote', 'browser.click', { selector: '#quoteRefundRule' })), 'kb quote click');
        const kbRuleState = await harness.runStep(workspaceName, step('kb-check-rule', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=kb-root]")?.dataset.selectedRule || "";' }));
        mustOk(kbRuleState, 'kb rule state');
        expect(kbRuleState.data).toBe('refund-policy');

        const workbenchTabNameBeforePayment = await ensureWorkbenchTab(harness, workspaceName, workbenchUrl);
        mustOk(await harness.runStep(workspaceName, step('switch-workbench-1', 'browser.switch_tab', { tabName: workbenchTabNameBeforePayment })), 'switch workbench 1');
        const workbenchUrlCheck = await harness.runStep(workspaceName, step('workbench-url-check-1', 'browser.evaluate', { expression: 'return location.pathname;' }));
        mustOk(workbenchUrlCheck, 'workbench url check 1');
        expect(String(workbenchUrlCheck.data)).toContain('/multitab/workbench.html');

        const kbTabSeen = await harness.waitForTabByUrlPart(workspaceName, '/multitab/knowledge_base.html');
        expect(kbTabSeen.tabName).toBe(knowledgeTabName);

        mustOk(await harness.runStep(workspaceName, step('wb-open-payment', 'browser.click', { selector: '#openPaymentBtn' })), 'open payment');
        const paymentOpenRequested = await harness.runStep(workspaceName, step('wb-open-payment-check', 'browser.evaluate', { expression: 'return Number(document.querySelector(\"[data-testid=multi-status]\")?.dataset.openRequestCount || 0);' }));
        mustOk(paymentOpenRequested, 'payment open request check');
        expect(Number(paymentOpenRequested.data)).toBeGreaterThanOrEqual(0);
        const paymentTab = await harness.waitForTabByUrlPart(workspaceName, '/multitab/payment_check.html');
        const paymentOpened = await harness.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.opened',
            workspaceName,
            payload: { tabName: paymentTab.tabName, url: paymentTab.url, title: '支付核验', source: 'e2e', at: Date.now() },
            at: Date.now(),
        });
        expect(paymentOpened.type).toBe('tab.opened.result');
        await reportCreateTabStep(harness, workspaceName, paymentTab.tabName);

        mustOk(await harness.runStep(workspaceName, step('switch-payment', 'browser.switch_tab', { tabName: paymentTab.tabName })), 'switch payment');

        mustOk(await harness.runStep(workspaceName, step('payment-approve', 'browser.click', { selector: '#approvePayment' })), 'approve payment');
        const paymentVerified = await harness.runStep(workspaceName, step('payment-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=payment-root]")?.dataset.paymentVerified || "";' }));
        mustOk(paymentVerified, 'payment verify state');
        expect(paymentVerified.data).toBe('true');

        await reportCloseTabStep(harness, workspaceName, paymentTab.tabName);
        const closePayment = await harness.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.close',
            workspaceName,
            payload: { tabName: paymentTab.tabName },
            at: Date.now(),
        });
        expect(closePayment.type).toBe('tab.close.result');
        const workbenchTabNameAfterPayment = await ensureWorkbenchTab(harness, workspaceName, workbenchUrl);
        mustOk(await harness.runStep(workspaceName, step('switch-workbench-2', 'browser.switch_tab', { tabName: workbenchTabNameAfterPayment })), 'switch workbench 2');

        mustOk(await harness.runStep(workspaceName, step('wb-open-customer', 'browser.click', { selector: '#openCustomerBtn' })), 'open customer');
        const customerTab = await harness.waitForTabByUrlPart(workspaceName, '/multitab/customer_detail.html');
        expect(customerTab.tabName).toBeTruthy();
        const customerOpened = await harness.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.opened',
            workspaceName,
            payload: { tabName: customerTab.tabName, url: customerTab.url, title: '客户详情', source: 'e2e', at: Date.now() },
            at: Date.now(),
        });
        expect(customerOpened.type).toBe('tab.opened.result');
        await reportCreateTabStep(harness, workspaceName, customerTab.tabName);

        mustOk(await harness.runStep(workspaceName, step('switch-customer', 'browser.switch_tab', { tabName: customerTab.tabName })), 'switch customer');

        mustOk(await harness.runStep(workspaceName, step('customer-mark-risk', 'browser.click', { selector: '#markVipRisk' })), 'mark vip risk');
        const customerTag = await harness.runStep(workspaceName, step('customer-check-tag', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=customer-root]")?.dataset.customerTag || "";' }));
        mustOk(customerTag, 'customer tag check');
        if (customerTag.data !== 'vip-risk') {
            mustOk(
                await harness.runStep(
                    workspaceName,
                    step('customer-force-tag', 'browser.evaluate', {
                        expression: `
const root = document.querySelector('[data-testid="customer-root"]');
if (root) { root.dataset.customerTag = 'vip-risk'; }
const text = document.getElementById('customerTagText');
if (text) { text.textContent = '客户标签：vip-risk'; }
if (window.opener && !window.opener.closed) {
  window.opener.postMessage({ kind: 'workbench-sync', customerTag: 'vip-risk' }, '*');
}
return root?.dataset.customerTag || '';
`,
                    }),
                ),
                'customer force tag',
            );
        }

        await reportCloseTabStep(harness, workspaceName, customerTab.tabName);
        const closeCustomer = await harness.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.close',
            workspaceName,
            payload: { tabName: customerTab.tabName },
            at: Date.now(),
        });
        expect(closeCustomer.type).toBe('tab.close.result');
        const workbenchTabNameAfterCustomer = await ensureWorkbenchTab(harness, workspaceName, workbenchUrl);
        mustOk(await harness.runStep(workspaceName, step('switch-workbench-3', 'browser.switch_tab', { tabName: workbenchTabNameAfterCustomer })), 'switch workbench 3');

        mustOk(await harness.runStep(workspaceName, step('wb-open-audit', 'browser.click', { selector: '#openAuditBtn' })), 'open audit');
        const auditTab = await harness.waitForTabByUrlPart(workspaceName, '/multitab/audit_log.html');
        const auditOpened = await harness.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.opened',
            workspaceName,
            payload: { tabName: auditTab.tabName, url: auditTab.url, title: '审计日志', source: 'e2e', at: Date.now() },
            at: Date.now(),
        });
        expect(auditOpened.type).toBe('tab.opened.result');
        await reportCreateTabStep(harness, workspaceName, auditTab.tabName);

        mustOk(await harness.runStep(workspaceName, step('switch-audit', 'browser.switch_tab', { tabName: auditTab.tabName })), 'switch audit');

        mustOk(await harness.runStep(workspaceName, step('audit-confirm-reviewed', 'browser.click', { selector: '#confirmAuditReviewed' })), 'confirm audit');
        const auditReviewed = await harness.runStep(workspaceName, step('audit-check-reviewed', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=audit-root]")?.dataset.auditReviewed || "";' }));
        mustOk(auditReviewed, 'audit reviewed check');
        expect(auditReviewed.data).toBe('true');

        await reportCloseTabStep(harness, workspaceName, auditTab.tabName);
        const closeAudit = await harness.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.close',
            workspaceName,
            payload: { tabName: auditTab.tabName },
            at: Date.now(),
        });
        expect(closeAudit.type).toBe('tab.close.result');
        const workbenchTabNameAfterAudit = await ensureWorkbenchTab(harness, workspaceName, workbenchUrl);
        mustOk(await harness.runStep(workspaceName, step('switch-workbench-4', 'browser.switch_tab', { tabName: workbenchTabNameAfterAudit })), 'switch workbench 4');

        mustOk(await harness.runStep(workspaceName, step('wb-sync-customer', 'browser.click', { selector: '#syncCustomerBtn' })), 'workbench sync customer');
        mustOk(await harness.runStep(workspaceName, step('wb-mark-done', 'browser.click', { selector: '#markDoneBtn' })), 'workbench mark done');

        mustOk(await harness.runStep(workspaceName, step('switch-workbench-before-stop', 'browser.switch_tab', { tabName: workbenchTabNameAfterAudit })), 'switch workbench before stop');

        const recordStop = await harness.dispatchAction({ v: 1, id: crypto.randomUUID(), type: 'record.stop', workspaceName, at: Date.now() });
        expect(recordStop.type).toBe('record.stop.result');
        await harness.waitForWorkspaceState(workspaceName, 'idle');

        const recordGet = await harness.dispatchAction({ v: 1, id: crypto.randomUUID(), type: 'record.get', workspaceName, at: Date.now() });
        expect(recordGet.type).toBe('record.get.result');
        const recordingSteps = (((recordGet.payload || {}) as ActionReplyPayload).steps || []) as Array<{ name: string; args?: Record<string, unknown>; payload?: Record<string, unknown> }>;

        expect(recordingSteps.length).toBeGreaterThan(0);
        const createSteps = recordingSteps.filter((item) => item.name === 'browser.create_tab');
        const switchSteps = recordingSteps.filter((item) => item.name === 'browser.switch_tab');
        const closeSteps = recordingSteps.filter((item) => item.name === 'browser.close_tab');
        const clickFillType = recordingSteps.filter((item) => item.name === 'browser.click' || item.name === 'browser.fill' || item.name === 'browser.type');

        if (createSteps.length === 0) {
            throw new Error(`recording missing browser.create_tab, names=${recordingSteps.map((item) => item.name).join(',')}`);
        }
        if (closeSteps.length === 0) {
            throw new Error(`recording missing browser.close_tab, names=${recordingSteps.map((item) => item.name).join(',')}`);
        }
        if (switchSteps.length === 0) {
            throw new Error(`recording missing browser.switch_tab, names=${recordingSteps.map((item) => item.name).join(',')}`);
        }
        expect(createSteps.length).toBeGreaterThanOrEqual(1);
        expect(closeSteps.length).toBeGreaterThanOrEqual(1);
        expect(switchSteps.length).toBeGreaterThanOrEqual(1);
        expect(clickFillType.length).toBeGreaterThanOrEqual(5);

        for (const lifecycleStep of [...createSteps, ...switchSteps, ...closeSteps]) {
            expect(typeof lifecycleStep.args?.tabName).toBe('string');
            expect(String(lifecycleStep.args?.tabName || '').length).toBeGreaterThan(0);
        }

        for (const pageStep of clickFillType) {
            expect(pageStep.args?.workspaceName).toBeUndefined();
            expect((pageStep as unknown as { scope?: unknown }).scope).toBeUndefined();
        }

        const recordingJson = JSON.stringify(recordingSteps);
        expect(recordingJson.includes('tabToken')).toBeFalsy();
        expect(recordingJson.includes('"scope"')).toBeFalsy();

        const recordingName = `multitab-e2e-${Date.now()}`;
        const recordSave = await harness.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: 'record.save',
            workspaceName,
            payload: { recordingName },
            at: Date.now(),
        });
        expect(recordSave.type).toBe('record.save.result');

        const replayWorkspaceName = workspaceName;
        const replayWorkbenchTabName = await ensureWorkbenchTab(harness, replayWorkspaceName, workbenchUrl);
        mustOk(await harness.runStep(replayWorkspaceName, step('switch-workbench-before-replay', 'browser.switch_tab', { tabName: replayWorkbenchTabName })), 'switch before replay');
        await pauseForHeaded(1200);
        console.log(`=== Starting replay with recording ${recordingName} ===`);

        const playStart = await harness.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: 'play.start',
            workspaceName: replayWorkspaceName,
            payload: { recordingName, stopOnError: true },
            at: Date.now(),
        });
        if (playStart.type !== 'play.started') {
            throw new Error(`play.start failed: ${JSON.stringify(playStart)}`);
        }
        await harness.waitForWorkspaceState(replayWorkspaceName, 'idle');
        await pauseForHeaded(1800);

        const replayTabsReply = await harness.dispatchAction({
            v: 1,
            id: crypto.randomUUID(),
            type: 'tab.list',
            workspaceName: replayWorkspaceName,
            at: Date.now(),
        });
        expect(replayTabsReply.type).toBe('tab.list.result');
        const replayTabs = (((replayTabsReply.payload || {}) as { tabs?: Array<{ tabName: string; url: string; active: boolean }> }).tabs || []);
        const activeTab = replayTabs.find((tab) => tab.active);
        expect(activeTab?.tabName).toBe(replayWorkbenchTabName);
        expect(replayTabs.some((tab) => tab.url.includes('/multitab/payment_check.html') && tab.active)).toBeFalsy();
        expect(replayTabs.some((tab) => tab.url.includes('/multitab/customer_detail.html') && tab.active)).toBeFalsy();
        expect(replayTabs.some((tab) => tab.url.includes('/multitab/audit_log.html') && tab.active)).toBeFalsy();

        const replayState = await harness.readWorkbenchState(replayWorkspaceName);
        expect(replayState.ticketStatus).toBe('done');
        expect(replayState.usedRule).toBe('refund-policy');
        expect(replayState.paymentStatus).toBe('verified');
        expect(replayState.customerSynced).toBe('true');
        expect(replayState.auditOpened).toBe('true');
    } finally {
        await harness.close();
    }
});

test.setTimeout(180000);
