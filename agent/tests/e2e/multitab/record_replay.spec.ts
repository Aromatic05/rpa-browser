import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { startAgent, runStep, dispatch } from '../../helpers/e2e_multitab_helper';
import { startFixtureServer } from '../../helpers/server';
import { sendControlEval } from '../../../src/control/client';
import type { StepUnion } from '../../../src/runner/steps/types';
import type { Action } from '../../../src/actions/action_protocol';

const st = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args']): Extract<StepUnion, { name: T }> => ({ id, name, args });
const mustOk = (r: { ok: boolean; error?: { code?: string; message?: string } }, label: string) => { expect(r.ok, `${label} failed: ${JSON.stringify(r.error)}`).toBeTruthy(); };
const log = (m: string) => console.log(`[e2e-mt][${new Date().toISOString()}] ${m}`);

const act = (type: string, workspaceName?: string, payload?: Record<string, unknown>): Action => ({
  v: 1, id: crypto.randomUUID(), type, workspaceName, payload, at: Date.now(),
});

const listTabs = async (ep: string, ws: string) => {
  const r = await dispatch(ep, act('tab.list', ws));
  expect(r.type).toBe('tab.list.result');
  return ((r.payload || {}) as { tabs?: Array<{ tabName: string; url: string; active: boolean }> }).tabs || [];
};

let ep = '';
let baseURL = '';
let closeAgent = async () => {};
let closeFixture = async () => {};

test.beforeEach(async () => {
  const fixture = await startFixtureServer();
  baseURL = fixture.baseURL;
  closeFixture = fixture.close;
  const agent = await startAgent();
  ep = agent.endpoint;
  closeAgent = agent.close;
});

test.afterEach(async () => {
  await closeAgent();
  await closeFixture();
});

test('records and replays active and passive multi-tab workflow', async () => {
  const d = async (label: string, action: Action) => { const r = await dispatch(ep, action); log(`${label} -> ${r.type}`); return r; };
  const rs = async (ws: string, label: string, s: StepUnion) => { const r = await runStep(ep, ws, s); log(`${label} -> ok=${String(r.ok)}`); return r; };

  const awaitWsState = async (ws: string, expected: string) => {
    await expect.poll(async () => {
      const r = await sendControlEval(
        { source: 'const w=ctx.workspaceRegistry.getWorkspace(input.n);return w?w.state:null;', input: { n: ws }, timeoutMs: 3000 },
        { endpoint: ep, timeoutMs: 3000 },
      );
      return r.ok ? r.result : null;
    }, { timeout: 3_000 }).toBe(expected);
  };

  const openTab = async (ws: string, url: string) => {
    const before = (await listTabs(ep, ws)).map((t) => t.tabName);
    await d('tab.open', act('tab.open', ws, { source: 'e2e.multitab' }));
    let tabName = '';
    await expect.poll(async () => {
      const tabs = await listTabs(ep, ws);
      const created = tabs.filter((t) => !before.includes(t.tabName));
      if (created.length >= 1) tabName = created[0]!.tabName;
      return tabName;
    }, { timeout: 4_000 }).toBeTruthy();
    mustOk(await rs(ws, 'openTab switch', st(`open-${tabName}-switch`, 'browser.switch_tab', { tabName })), 'openTab switch');
    mustOk(await rs(ws, 'openTab goto', st(`open-${tabName}-goto`, 'browser.goto', { url })), 'openTab goto');
    return tabName;
  };

  const readWb = async (ws: string) => {
    const r = await runStep(ep, ws, st('wb-read', 'browser.evaluate', {
      expression: 'const b=document.querySelector("[data-testid=multi-status]");return{ticketStatus:b?.dataset.ticketStatus||"",usedRule:b?.dataset.usedRule||"",paymentStatus:b?.dataset.paymentStatus||"",customerSynced:b?.dataset.customerSynced||"",auditOpened:b?.dataset.auditOpened||"",customerTag:b?.dataset.customerTag||""};',
    }));
    return (r.data || {}) as Record<string, string>;
  };

  const closeTab = async (ws: string, tabName: string, stepId: string, label: string) => {
    mustOk(await rs(ws, label, st(stepId, 'browser.close_tab', { tabName })), label);
    await expect.poll(async () => {
      return (await listTabs(ep, ws)).some((t) => t.tabName === tabName);
    }, { timeout: 30_000 }).toBe(false);
  };

  const clickOpen = async (ws: string, clickStep: Extract<StepUnion, { name: 'browser.click' }>) => {
    const before = (await listTabs(ep, ws)).map((t) => t.tabName);
    mustOk(await rs(ws, clickStep.id, clickStep), clickStep.id);
    await expect.poll(async () => {
      const after = await listTabs(ep, ws);
      return after.filter((t) => !before.includes(t.tabName)).length;
    }, { timeout: 15_000 }).toBe(1);
    const after = await listTabs(ep, ws);
    const opened = after.filter((t) => !before.includes(t.tabName));
    expect(opened.length).toBe(1);
    const openedTab = opened[0]!;
    await expect.poll(async () => {
      const r = await sendControlEval(
        {
          source: 'const d=await ctx.deps.pageRegistry.debugPageBindings(input.n);return Array.isArray(d?.knownBindings)&&d.knownBindings.includes(input.n);',
          input: { n: openedTab.tabName },
          timeoutMs: 3000,
        },
        { endpoint: ep, timeoutMs: 3000 },
      );
      return r.ok ? r.result : false;
    }, { timeout: 20_000 }).toBe(true);
    return openedTab;
  };

  const ws = 'default';
  const wbUrl = `${baseURL}/multitab/workbench.html`;
  const kbUrl = `${baseURL}/multitab/knowledge_base.html`;

  const wbTab = await openTab(ws, wbUrl);

  const initial = await listTabs(ep, ws);
  expect(initial.some((t) => t.tabName === wbTab)).toBeTruthy();

  const recStart = await d('record.start', act('record.start', ws));
  expect(recStart.type).toBe('record.start.result');
  await awaitWsState(ws, 'recording');

  const kbCreate = await rs(ws, 'kb create', st('kb-create', 'browser.create_tab', {}));
  mustOk(kbCreate, 'kb create');
  const kbTab = String(((kbCreate.data as { tab_id?: string }) || {}).tab_id || '');
  expect(kbTab).toBeTruthy();
  expect((await listTabs(ep, ws)).map((t) => t.tabName)).toEqual(expect.arrayContaining([wbTab, kbTab]));

  mustOk(await rs(ws, 'switch kb', st('s-kb', 'browser.switch_tab', { tabName: kbTab })), 'switch kb');
  mustOk(await rs(ws, 'kb goto', st('kb-goto', 'browser.goto', { url: kbUrl })), 'kb goto');
  await expect.poll(async () => {
    const r = await rs(ws, 'kb ready', st('kb-ready', 'browser.evaluate', { expression: 'return!!document.querySelector("#kbSearch");' }));
    return r.ok ? r.data : false;
  }, { timeout: 15_000 }).toBe(true);
  mustOk(await rs(ws, 'kb goto2', st('kb-goto2', 'browser.goto', { url: kbUrl })), 'kb goto2');
  mustOk(await rs(ws, 'kb fill', st('kb-fill', 'browser.fill', { selector: '#kbSearch', value: '退款规则' })), 'kb fill');
  mustOk(await rs(ws, 'kb quote', st('kb-quote', 'browser.click', { selector: '#quoteRefundRule' })), 'kb quote');
  const kbRule = await rs(ws, 'kb rule', st('kb-rule', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=kb-root]")?.dataset.selectedRule||"";' }));
  mustOk(kbRule, 'kb rule');
  expect(kbRule.data).toBe('refund-policy');

  mustOk(await rs(ws, 'sw wb1', st('sw-wb1', 'browser.switch_tab', { tabName: wbTab })), 'sw wb1');
  mustOk(await rs(ws, 'goto wb1', st('goto-wb1', 'browser.goto', { url: wbUrl })), 'goto wb1');

  const payTab = await clickOpen(ws, st('open-pay', 'browser.click', { selector: '#openPaymentBtn' }));
  mustOk(await rs(ws, 'sw pay', st('sw-pay', 'browser.switch_tab', { tabName: payTab.tabName })), 'sw pay');
  mustOk(await rs(ws, 'approve', st('approve', 'browser.click', { selector: '#approvePayment' })), 'approve');
  await closeTab(ws, payTab.tabName, 'pay-close', 'close pay');

  mustOk(await rs(ws, 'sw wb2', st('sw-wb2', 'browser.switch_tab', { tabName: wbTab })), 'sw wb2');
  mustOk(await rs(ws, 'goto wb2', st('goto-wb2', 'browser.goto', { url: wbUrl })), 'goto wb2');

  const custTab = await clickOpen(ws, st('open-cust', 'browser.click', { selector: '#openCustomerBtn' }));
  mustOk(await rs(ws, 'sw cust', st('sw-cust', 'browser.switch_tab', { tabName: custTab.tabName })), 'sw cust');
  mustOk(await rs(ws, 'mark vip', st('mark-vip', 'browser.click', { selector: '#markVipRisk' })), 'mark vip');
  await closeTab(ws, custTab.tabName, 'cust-close', 'close cust');

  mustOk(await rs(ws, 'sw wb3', st('sw-wb3', 'browser.switch_tab', { tabName: wbTab })), 'sw wb3');
  mustOk(await rs(ws, 'goto wb3', st('goto-wb3', 'browser.goto', { url: wbUrl })), 'goto wb3');

  const auditTab = await clickOpen(ws, st('open-audit', 'browser.click', { selector: '#openAuditBtn' }));
  mustOk(await rs(ws, 'sw audit', st('sw-audit', 'browser.switch_tab', { tabName: auditTab.tabName })), 'sw audit');
  mustOk(await rs(ws, 'confirm', st('confirm', 'browser.click', { selector: '#confirmAuditReviewed' })), 'confirm');
  await closeTab(ws, auditTab.tabName, 'audit-close', 'close audit');

  mustOk(await rs(ws, 'sw wb4', st('sw-wb4', 'browser.switch_tab', { tabName: wbTab })), 'sw wb4');
  mustOk(await rs(ws, 'goto wb4', st('goto-wb4', 'browser.goto', { url: wbUrl })), 'goto wb4');
  mustOk(await rs(ws, 'sync', st('sync', 'browser.click', { selector: '#syncCustomerBtn' })), 'sync');
  mustOk(await rs(ws, 'done', st('done', 'browser.click', { selector: '#markDoneBtn' })), 'done');

  const recStop = await d('record.stop', act('record.stop', ws));
  expect(recStop.type).toBe('record.stop.result');
  await awaitWsState(ws, 'idle');

  const recGet = await d('record.get', act('record.get', ws));
  expect(recGet.type).toBe('record.get.result');
  const steps = (((recGet.payload || {}) as { steps?: Array<{ name: string; args?: Record<string, unknown>; meta?: Record<string, unknown> }> }).steps) || [];

  const names = steps.map((s) => s.name);
  const createSteps = steps.filter((s) => s.name === 'browser.create_tab');
  const switchSteps = steps.filter((s) => s.name === 'browser.switch_tab');
  const closeSteps = steps.filter((s) => s.name === 'browser.close_tab');

  expect(names).toContain('browser.create_tab');
  expect(names).toContain('browser.switch_tab');
  expect(names).toContain('browser.close_tab');
  expect(createSteps.length).toBeGreaterThanOrEqual(4);
  expect(switchSteps.length).toBeGreaterThanOrEqual(4);
  expect(closeSteps.length).toBe(3);

  for (const s of createSteps) { expect(typeof s.meta?.tabName).toBe('string'); expect(String(s.meta?.tabName)).toBeTruthy(); }
  for (const s of switchSteps) { expect(typeof s.args?.tabName).toBe('string'); expect(String(s.args?.tabName)).toBeTruthy(); }
  for (const s of closeSteps) { expect(typeof s.args?.tabName).toBe('string'); expect(String(s.args?.tabName)).toBeTruthy(); }

  steps.filter((s) => ['browser.goto', 'browser.click', 'browser.fill', 'browser.evaluate'].includes(s.name)).forEach((s) => {
    expect(Object.prototype.hasOwnProperty.call(s.args || {}, 'workspaceName')).toBeFalsy();
  });
  steps.forEach((s) => {
    expect(Object.prototype.hasOwnProperty.call(s as object, 'tabToken')).toBeFalsy();
    expect(Object.prototype.hasOwnProperty.call(s as object, 'scope')).toBeFalsy();
  });

  expect(createSteps.some((s) => String(s.meta?.tabName || '') === payTab.tabName)).toBeTruthy();
  expect(createSteps.some((s) => String(s.meta?.tabName || '') === custTab.tabName)).toBeTruthy();
  expect(createSteps.some((s) => String(s.meta?.tabName || '') === auditTab.tabName)).toBeTruthy();
  expect(closeSteps.some((s) => String(s.args?.tabName || '') === payTab.tabName)).toBeTruthy();
  expect(closeSteps.some((s) => String(s.args?.tabName || '') === custTab.tabName)).toBeTruthy();
  expect(closeSteps.some((s) => String(s.args?.tabName || '') === auditTab.tabName)).toBeTruthy();

  const recName = `mt-e2e-${Date.now()}`;
  const recSave = await d('record.save', act('record.save', ws, { recordingName: recName }));
  expect(recSave.type).toBe('record.save.result');

  await closeTab(ws, kbTab, 'kb-close-pre', 'close kb pre');

  mustOk(await rs(ws, 'sw pre', st('sw-pre', 'browser.switch_tab', { tabName: wbTab })), 'sw pre');
  mustOk(await rs(ws, 'clear', st('clear', 'browser.evaluate', { expression: 'localStorage.clear();return true;' })), 'clear');
  mustOk(await rs(ws, 'reload', st('reload', 'browser.goto', { url: `${wbUrl}?reset=${Date.now()}` })), 'reload');

  const resetTabs = await listTabs(ep, ws);
  expect(resetTabs.some((t) => t.tabName === wbTab)).toBeTruthy();
  expect(resetTabs.find((t) => t.tabName === wbTab)?.active).toBeTruthy();

  const resetState = await readWb(ws);
  expect(resetState.ticketStatus).toBe('pending');
  expect(resetState.usedRule).toBe('');
  expect(resetState.paymentStatus).toBe('pending');
  expect(resetState.customerSynced).toBe('false');
  expect(resetState.auditOpened).toBe('false');

  const playStart = await d('play.start', act('play.start', ws, { recordingName: recName, stopOnError: true }));
  expect(playStart.type).toBe('play.started');

  await expect.poll(async () => {
    const stateEval = await sendControlEval(
      { source: 'const w=ctx.workspaceRegistry.getWorkspace(input.n);return w?w.state:null;', input: { n: ws }, timeoutMs: 3000 },
      { endpoint: ep, timeoutMs: 3000 },
    );
    const state = stateEval.ok ? String(stateEval.result || '') : '';
    return state;
  }, { timeout: 120_000 }).toBe('idle');

  const replayTabs = await listTabs(ep, ws);
  expect(replayTabs.length).toBe(2);
  expect(replayTabs.filter((t) => t.active).length).toBe(1);
  expect(replayTabs.find((t) => t.active)?.tabName).toBe(wbTab);
  expect(replayTabs.some((t) => t.tabName === wbTab)).toBeTruthy();
  expect(replayTabs.some((t) => t.tabName === payTab.tabName)).toBeFalsy();
  expect(replayTabs.some((t) => t.tabName === custTab.tabName)).toBeFalsy();
  expect(replayTabs.some((t) => t.tabName === auditTab.tabName)).toBeFalsy();
  const secondaryTab = replayTabs.find((t) => t.tabName !== wbTab);
  expect(secondaryTab).toBeTruthy();

  mustOk(await rs(ws, 'sw wb post', st('sw-wb-post', 'browser.switch_tab', { tabName: wbTab })), 'sw wb post');
  mustOk(await rs(ws, 'goto wb post', st('goto-wb-post', 'browser.goto', { url: wbUrl })), 'goto wb post');
  const replayState = await readWb(ws);
  expect(replayState.ticketStatus).toBe('done');
  expect(replayState.usedRule).toBe('refund-policy');
  expect(replayState.paymentStatus).toBe('verified');
  expect(replayState.customerSynced).toBe('true');
  expect(replayState.auditOpened).toBe('true');
});

test.setTimeout(180_000);
