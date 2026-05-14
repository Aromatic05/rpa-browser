import { test, expect } from '@playwright/test';
import { startAgent, runStep, dispatch } from '../../helpers/e2e_multitab_helper';
import { startFixtureServer } from '../../helpers/server';
import type { StepUnion } from '../../../src/runner/steps/types';

const st = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args']): Extract<StepUnion, { name: T }> => ({ id, name, args });
const log = (m: string) => console.log(`[e2e-mt][${new Date().toISOString()}] ${m}`);

let ep = '';
let fixtureUrl = '';
let closeAgent = async () => {};
let closeFixture = async () => {};

test.beforeEach(async () => {
  const fixture = await startFixtureServer();
  fixtureUrl = `${fixture.baseURL}/step_actions/customer_profile.html`;
  closeFixture = fixture.close;
  const agent = await startAgent();
  ep = agent.endpoint;
  closeAgent = agent.close;
});

test.afterEach(async () => {
  await closeAgent();
  await closeFixture();
});

test('E2E-1 step actions should work via agent + extension + workspace on real fixture page', async () => {
  const ws = 'default';
  const d = async (label: string, action: Parameters<typeof dispatch>[1]) => { const r = await dispatch(ep, action); log(`${label} -> ${r.type}`); return r; };
  const rs = async (label: string, s: StepUnion) => { const r = await runStep(ep, ws, s); log(`${label} -> ok=${String(r.ok)}`); return r; };

  const openReply = await d('tab.open', { v: 1, id: crypto.randomUUID(), type: 'tab.open', workspaceName: ws, payload: { startUrl: fixtureUrl, source: 'e2e.step_actions' }, at: Date.now() });
  expect(openReply.type).toBe('tab.open.result');

  const gotoResult = await rs('s1-goto', st('s1-goto', 'browser.goto', { url: fixtureUrl }));
  expect(gotoResult.ok).toBeTruthy();

  const fillResult = await rs('s2-fill', st('s2-fill', 'browser.fill', { selector: '[data-testid="customer-name"]', value: '上海智算科技' }));
  expect(fillResult.ok).toBeTruthy();
  const fillState = await rs('s2-check', st('s2-check', 'browser.evaluate', { expression: 'return {v: document.querySelector("[data-testid=live-status]")?.dataset.customerName, text: document.querySelector("[data-testid=live-status]")?.textContent};' }));
  expect(fillState.ok).toBeTruthy();
  expect((fillState.data as any).v).toBe('上海智算科技');
  expect(String((fillState.data as any).text)).toContain('客户名(上海智算科技)');

  const typeResult = await rs('s3-type', st('s3-type', 'browser.type', { selector: '[data-testid="notes"]', text: '首访客户，已完成需求初访。' }));
  expect(typeResult.ok).toBeTruthy();
  const typeState = await rs('s3-check', st('s3-check', 'browser.evaluate', { expression: 'return (document.querySelector("[data-testid=notes]") || { value: "" }).value;' }));
  expect(typeState.ok).toBeTruthy();
  expect(String(typeState.data)).toContain('首访客户');

  const selectResult = await rs('s4-select', st('s4-select', 'browser.select_option', { selector: '#customerLevel', kind: 'native_select', values: ['gold'] }));
  expect(selectResult.ok, `select_option failed: ${JSON.stringify(selectResult.error)}`).toBeTruthy();
  const selectState = await rs('s4-check', st('s4-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=live-status]")?.dataset.level;' }));
  expect(selectState.ok).toBeTruthy();
  expect(selectState.data).toBe('gold');

  const checkboxResult = await rs('s5-checkbox', st('s5-checkbox', 'browser.click', { selector: '[data-testid="mail-notify"]' }));
  expect(checkboxResult.ok).toBeTruthy();
  const checkboxState = await rs('s5-check', st('s5-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=live-status]")?.dataset.mailNotify;' }));
  expect(checkboxState.ok).toBeTruthy();
  expect(checkboxState.data).toBe('true');

  const radioResult = await rs('s6-radio', st('s6-radio', 'browser.click', { selector: '[data-testid="status-paused"]' }));
  expect(radioResult.ok).toBeTruthy();
  const radioState = await rs('s6-check', st('s6-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=live-status]")?.dataset.status;' }));
  expect(radioState.ok).toBeTruthy();
  expect(radioState.data).toBe('paused');

  await rs('s7-focus-search', st('s7-focus-search', 'browser.click', { selector: '[data-testid="search-box"]' }));
  const pressResult = await rs('s7-press', st('s7-press', 'browser.press_key', { selector: '[data-testid="search-box"]', key: 'Enter' }));
  expect(pressResult.ok).toBeTruthy();
  const pressState = await rs('s7-check', st('s7-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=live-status]")?.dataset.lastKey;' }));
  expect(pressState.ok).toBeTruthy();
  expect(pressState.data).toBe('Enter');

  const hoverResult = await rs('s8-hover', st('s8-hover', 'browser.hover', { selector: '[data-testid="help-zone"]' }));
  expect(hoverResult.ok).toBeTruthy();
  const hoverState = await rs('s8-check', st('s8-check', 'browser.evaluate', { expression: 'return document.querySelector("[data-testid=live-status]")?.dataset.helpVisible;' }));
  expect(hoverState.ok).toBeTruthy();
  expect(hoverState.data).toBe('true');

  const scrollResult = await rs('s9-scroll', st('s9-scroll', 'browser.scroll', { selector: '#logContainer', direction: 'down', amount: 600 }));
  expect(scrollResult.ok).toBeTruthy();
  const scrollState = await rs('s9-check', st('s9-check', 'browser.evaluate', { expression: 'return Number(document.querySelector("[data-testid=live-status]")?.dataset.scrollTop || 0);' }));
  expect(scrollState.ok).toBeTruthy();
  expect(Number(scrollState.data)).toBeGreaterThan(0);

  const saveResult = await rs('s10-save', st('s10-save', 'browser.click', { selector: '[data-testid="save-btn"]' }));
  expect(saveResult.ok).toBeTruthy();
  const saveState = await rs('s10-check', st('s10-check', 'browser.evaluate', {
    expression: 'const zone=document.querySelector("[data-testid=result-zone]"); return {saved: zone?.dataset.saved, summary: zone?.dataset.summary, text: zone?.textContent};',
  }));
  expect(saveState.ok).toBeTruthy();
  expect((saveState.data as any).saved).toBe('true');
  expect(String((saveState.data as any).summary)).toContain('name=上海智算科技');
  expect(String((saveState.data as any).summary)).toContain('level=gold');
  expect(String((saveState.data as any).summary)).toContain('mail=true');
  expect(String((saveState.data as any).summary)).toContain('status=paused');
  expect(String((saveState.data as any).summary)).toContain('notes=首访客户');

  const snapshotResult = await rs('s11-snapshot', st('s11-snapshot', 'browser.snapshot', {}));
  expect(snapshotResult.ok).toBeTruthy();
  expect(snapshotResult.data).toBeTruthy();
  expect((snapshotResult.data as any).id).toBeTruthy();
  expect(Array.isArray((snapshotResult.data as any).children)).toBeTruthy();

  const screenshotResult = await rs('s12-screenshot', st('s12-screenshot', 'browser.take_screenshot', { inline: true }));
  expect(screenshotResult.ok).toBeTruthy();
  expect((screenshotResult.data as any)?.mime).toBe('image/png');
  expect(typeof (screenshotResult.data as any)?.base64).toBe('string');
  expect((screenshotResult.data as any)?.base64.length).toBeGreaterThan(100);

  const notFoundResult = await rs('s13-not-found', st('s13-not-found', 'browser.click', { selector: '#not-exist-selector-e2e' }));
  expect(notFoundResult.ok).toBeFalsy();
  expect(notFoundResult.error).toBeTruthy();
  expect(notFoundResult.error?.code).toBeTruthy();
});

test.setTimeout(120_000);
