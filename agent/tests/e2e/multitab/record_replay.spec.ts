import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { startAgent, runStep, dispatch } from '../../helpers/e2e_multitab_helper';
import { startFixtureServer } from '../../helpers/server';
import { sendControlEval } from '../../../src/interface/control/client';
import type { StepUnion } from '../../../src/automation/runner/steps/types';
import type { Action } from '../../../src/interface/actions/action_protocol';

const st = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args']): Extract<StepUnion, { name: T }> => ({ id, name, args } as unknown as Extract<StepUnion, { name: T }>);
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
          source: 'const w=ctx.workspaceRegistry.getWorkspace(input.w);const d=await w.browserSession.pageRegistry.debugPageBindings(input.n);return Array.isArray(d?.knownBindings)&&d.knownBindings.includes(input.n);',
          input: { w: ws, n: openedTab.tabName },
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
  const kbTab = String((((kbCreate.data as { tabName?: string; tab_id?: string }) || {}).tabName) || ((kbCreate.data as { tab_id?: string }) || {}).tab_id || '');
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

  for (const s of createSteps) { expect(typeof s.args?.tabName).toBe('string'); expect(String(s.args?.tabName)).toBeTruthy(); }
  for (const s of switchSteps) { expect(typeof s.args?.tabName).toBe('string'); expect(String(s.args?.tabName)).toBeTruthy(); }
  for (const s of closeSteps) { expect(typeof s.args?.tabName).toBe('string'); expect(String(s.args?.tabName)).toBeTruthy(); }

  steps.filter((s) => ['browser.goto', 'browser.click', 'browser.fill', 'browser.evaluate'].includes(s.name)).forEach((s) => {
    expect(Object.prototype.hasOwnProperty.call(s.args || {}, 'workspaceName')).toBeFalsy();
  });
  steps.forEach((s) => {
    expect(Object.prototype.hasOwnProperty.call(s as object, 'tabToken')).toBeFalsy();
    expect(Object.prototype.hasOwnProperty.call(s as object, 'scope')).toBeFalsy();
  });

  expect(createSteps.some((s) => String(s.args?.tabName || '') === payTab.tabName)).toBeTruthy();
  expect(createSteps.some((s) => String(s.args?.tabName || '') === custTab.tabName)).toBeTruthy();
  expect(createSteps.some((s) => String(s.args?.tabName || '') === auditTab.tabName)).toBeTruthy();
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
  const resetTabCount = resetTabs.length;

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
  expect(replayTabs.length).toBe(resetTabCount + 1);
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

test('product Library replays a renamed button and explains an ambiguous target', async () => {
  const ws = 'default';
  const send = (type: string, payload?: Record<string, unknown>) => dispatch(ep, act(type, ws, payload));
  const evaluate = async (id: string, expression: string) => {
    const result = await runStep(ep, ws, st(id, 'browser.evaluate', {expression}));
    mustOk(result, id);
    return result.data;
  };
  const clickReplay = async () => {
    await expect.poll(() => evaluate('click-library-replay', `
      const root = document.querySelector('#rpa-product-panel')?.shadowRoot;
      const replay = root?.querySelector('[aria-label="Replay renamed-save"]');
      if (!replay || replay.disabled) return false;
      replay.click();
      return true;
    `), {timeout: 15_000}).toBe(true);
  };
  const playbackText = (phase: 'completed' | 'failed') => evaluate('library-playback-result', `
    return document.querySelector('#rpa-product-panel')?.shadowRoot
      ?.querySelector('[data-rpa-product-playback="${phase}"]')?.textContent || '';
  `);
  const goto = await runStep(ep, ws, st('open-fixture', 'browser.goto', {
    url: `${baseURL}/step_actions/customer_profile.html`,
  }));
  mustOk(goto, 'open fixture');
  expect((await send('record.start')).type).toBe('record.start.result');
  mustOk(await runStep(ep, ws, st('record-click', 'browser.click', {selector: '#saveBtn'})), 'record save click');
  expect((await send('record.stop')).type).toBe('record.stop.result');
  const recordingName = 'renamed-save';
  expect((await send('record.save', {recordingName, includeStepResolve: true})).type).toBe('record.save.result');
  mustOk(await runStep(ep, ws, st('reload-fixture', 'browser.reload', {})), 'reload fixture after saving');
  await expect.poll(() => evaluate('open-library', `
    const root = document.querySelector('#rpa-product-panel')?.shadowRoot;
    const launcher = root?.querySelector('[data-rpa-product-launcher]');
    const library = root?.querySelector('[data-rpa-product-nav="library"]');
    if (!launcher || !library) return false;
    launcher.click();
    library.click();
    return true;
  `), {timeout: 15_000}).toBe(true);

  await evaluate('rename-button', `
    const button = document.querySelector('#saveBtn');
    button.id = 'new-save';
    button.removeAttribute('data-testid');
    button.addEventListener('click', () => { button.dataset.replayed = 'true'; });
    return true;
  `);
  await clickReplay();
  await expect.poll(() => playbackText('completed'), {timeout: 15_000}).toMatch(/Replay completed/);
  expect(await evaluate('check-replayed', "return document.querySelector('#new-save')?.dataset.replayed === 'true';")).toBe(true);

  await evaluate('add-duplicate', `
    const button = document.querySelector('#new-save');
    delete button.dataset.replayed;
    const other = button.cloneNode(true);
    other.id = 'duplicate-save';
    other.addEventListener('click', () => { other.dataset.replayed = 'true'; });
    button.after(other);
    return true;
  `);
  await clickReplay();
  await expect.poll(() => playbackText('failed'), {timeout: 15_000})
    .toMatch(/Action \d+: The backup clues matched more than one element/);
  expect(await evaluate('check-neither-clicked', "return document.querySelectorAll('[data-replayed=true]').length;")).toBe(0);
});

test('saved iframe recording stays in its original frame after a selector changes', async () => {
  const ws = 'default';
  const send = (type: string, payload?: Record<string, unknown>) => dispatch(ep, act(type, ws, payload));
  const control = async (source: string) => {
    const result = await sendControlEval({source}, {endpoint: ep, timeoutMs: 10_000});
    expect(result.ok, result.error?.message).toBe(true);
    return result.result;
  };
  mustOk(await runStep(ep, ws, st('frame-fixture', 'browser.goto', {
    url: `${baseURL}/step_actions/customer_profile.html`,
  })), 'open fixture');
  expect((await send('record.start')).type).toBe('record.start.result');
  await control(`
    const page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
    await page.evaluate(() => {
      const html = '<button id="confirm" onclick="this.dataset.clicked = true">Confirm order</button>';
      document.body.insertAdjacentHTML('beforeend', html);
      for (const id of ['payment', 'other-frame']) {
        const frame = document.createElement('iframe');
        frame.id = id;
        frame.srcdoc = html;
        document.body.append(frame);
      }
    });
    await page.frameLocator('#payment').locator('#confirm').waitFor();
    await page.frameLocator('#other-frame').locator('#confirm').waitFor();
  `);
  await control(`
    const page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
    await page.frameLocator('#payment').locator('#confirm').click();
  `);
  expect((await send('record.stop')).type).toBe('record.stop.result');
  const recordingName = 'payment-frame';
  const captured = (await send('record.get')).payload as {
    steps: Array<{name: string; args: {selector?: string}; resolve?: {hint?: {raw?: {framePath?: unknown}}}}>;
  };
  expect(captured.steps.filter((step) => step.name === 'browser.click').map((step) => ({
    selector: step.args.selector, path: step.resolve?.hint?.raw?.framePath,
  }))).toContainEqual({selector: '#confirm', path: [{id: 'payment', origin: 'about:srcdoc'}]});
  // Frame scope is necessary even when optional target enrichment is disabled.
  expect((await send('record.save', {recordingName, includeStepResolve: false})).type).toBe('record.save.result');
  const savedScope = await control(`
    const artifact = ctx.resolveWorkspace('default').workflow.get('payment-frame', {kind: 'recording'});
    return Object.values(artifact.stepResolves).find(resolve => resolve.hint?.raw?.framePath)?.hint.raw.framePath;
  `);
  expect(savedScope).toEqual([{id: 'payment', origin: 'about:srcdoc'}]);

  await control(`
    const page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
    await page.frameLocator('#payment').locator('#confirm').evaluate(button => {
      button.id = 'new-confirm';
      delete button.dataset.clicked;
    });
  `);
  const playback = async () => (await send('agent.product', {verb: 'workspaceView'})).payload as {
    playback?: {phase: string; failure?: {frameIssue?: string; fallbackConflict?: boolean}};
  };
  expect((await send('play.start', {recordingName})).type).toBe('play.started');
  await expect.poll(async () => (await playback()).playback?.phase).toBe('completed');
  const clicked = () => control(`
    const page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
    return [
      await page.locator('#confirm').getAttribute('data-clicked'),
      await page.frameLocator('#payment').locator('#new-confirm').getAttribute('data-clicked'),
      await page.frameLocator('#other-frame').locator('#confirm').getAttribute('data-clicked'),
    ];
  `);
  expect(await clicked()).toEqual([null, 'true', null]);

  await control(`
    const page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
    await page.frameLocator('#payment').locator('#new-confirm').evaluate(button => {
      delete button.dataset.clicked;
      const duplicate = button.cloneNode(true);
      duplicate.id = 'duplicate-confirm';
      button.after(duplicate);
    });
  `);
  expect((await send('play.start', {recordingName})).type).toBe('play.started');
  await expect.poll(async () => (await playback()).playback?.failure?.fallbackConflict).toBe(true);
  expect(await clicked()).toEqual([null, null, null]);
  await control(`
    const page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
    const duplicate = page.frameLocator('#payment').locator('#duplicate-confirm');
    const hit = await duplicate.getAttribute('data-clicked');
    await duplicate.evaluate(button => button.remove());
    return hit;
  `).then((hit) => expect(hit).toBeNull());

  await control(`
    const page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
    await page.evaluate(() => {
      const frame = document.getElementById('payment');
      delete frame.contentDocument.querySelector('#new-confirm').dataset.clicked;
      const duplicate = frame.cloneNode();
      document.body.append(duplicate);
    });
  `);
  expect((await send('play.start', {recordingName})).type).toBe('play.started');
  await expect.poll(async () => (await playback()).playback?.failure?.frameIssue).toBe('ambiguous');
  await control(`
    const page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
    await page.locator('iframe#payment').nth(1).evaluate(frame => frame.remove());
  `);
  expect(await clicked()).toEqual([null, null, null]);
});

test.setTimeout(180_000);
