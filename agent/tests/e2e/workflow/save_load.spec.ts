import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import YAML from 'yaml';
import { sendControlEval } from '../../../src/control/client';
import type { Action } from '../../../src/actions/action_protocol';
import type { StepUnion } from '../../../src/runner/steps/types';
import { dispatch, runStep, startAgent } from '../../helpers/e2e_multitab_helper';
import { startFixtureServer } from '../../helpers/server';

const st = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args']): Extract<StepUnion, { name: T }> => ({ id, name, args });

const actWorkspace = (type: string, workspaceName: string, payload: Record<string, unknown> = {}): Action => ({
  v: 1,
  id: crypto.randomUUID(),
  type,
  workspaceName,
  payload,
  at: Date.now(),
});

const actControl = (type: string, payload: Record<string, unknown> = {}): Action => ({
  v: 1,
  id: crypto.randomUUID(),
  type,
  payload,
  at: Date.now(),
});

const expectStepOk = (result: { ok: boolean; error?: { code?: string; message?: string } }, label: string) => {
  expect(result.ok, `${label} failed: ${JSON.stringify(result.error || {})}`).toBeTruthy();
};

const readWorkspaceState = async (endpoint: string, workspaceName: string) => {
  const response = await sendControlEval(
    { source: 'const w=ctx.workspaceRegistry.getWorkspace(input.workspaceName);return w?w.state:null;', input: { workspaceName }, timeoutMs: 3000 },
    { endpoint, timeoutMs: 3000 },
  );
  expect(response.ok).toBeTruthy();
  return String(response.result);
};

const readPageState = async (endpoint: string, workspaceName: string) => {
  const result = await runStep(endpoint, workspaceName, st(`read-${workspaceName}-${Date.now()}`, 'browser.evaluate', {
    expression: `
      const node = document.querySelector('#result');
      return {
        customerName: node?.dataset.customerName || '',
        source: node?.dataset.source || '',
        owner: node?.dataset.owner || '',
        priority: node?.dataset.priority || '',
        note: node?.dataset.note || '',
        submitted: node?.dataset.submitted || 'false',
        text: node?.textContent || ''
      };
    `,
  }));
  expectStepOk(result, `read page state ${workspaceName}`);
  return result.data as {
    customerName: string;
    source: string;
    owner: string;
    priority: string;
    note: string;
    submitted: string;
    text: string;
  };
};

const listTabs = async (endpoint: string, workspaceName: string) => {
  const result = await dispatch(endpoint, actWorkspace('tab.list', workspaceName));
  expect(result.type).toBe('tab.list.result');
  return ((result.payload || {}) as { tabs?: Array<{ tabName: string; active: boolean }> }).tabs || [];
};

const openFixtureTab = async (endpoint: string, workspaceName: string, pageUrl: string) => {
  const before = await listTabs(endpoint, workspaceName);
  const beforeNames = before.map((tab) => tab.tabName);
  const open = await dispatch(endpoint, actWorkspace('tab.open', workspaceName, { source: 'e2e.workflow.save_load' }));
  expect(open.type).toBe('tab.open.result');

  let tabName = '';
  await expect.poll(async () => {
    const tabs = await listTabs(endpoint, workspaceName);
    const created = tabs.filter((tab) => beforeNames.includes(tab.tabName) === false);
    tabName = String(created[0]?.tabName || '');
    return tabName;
  }, { timeout: 10_000 }).toBeTruthy();

  const switchResult = await runStep(endpoint, workspaceName, st(`switch-${workspaceName}`, 'browser.switch_tab', { tabName }));
  expectStepOk(switchResult, `switch tab ${workspaceName}`);

  const gotoResult = await runStep(endpoint, workspaceName, st(`goto-${workspaceName}`, 'browser.goto', { url: pageUrl }));
  expectStepOk(gotoResult, `goto fixture ${workspaceName}`);

  await expect.poll(async () => {
    const state = await readPageState(endpoint, workspaceName);
    return state.submitted;
  }, { timeout: 10_000 }).toBe('false');

  return tabName;
};

const workflowStepsPath = (workflowName: string) =>
  path.resolve(process.cwd(), '.artifacts', 'workflows', workflowName, 'recordings', 'main', 'steps.yaml');

let endpoint = '';
let baseURL = '';
let closeAgent = async () => {};
let closeFixtureServer = async () => {};
const cleanupPaths: string[] = [];

test.beforeEach(async () => {
  const fixture = await startFixtureServer();
  baseURL = fixture.baseURL;
  closeFixtureServer = fixture.close;

  const agent = await startAgent();
  endpoint = agent.endpoint;
  closeAgent = agent.close;
});

test.afterEach(async () => {
  await closeAgent();
  await closeFixtureServer();
  await Promise.all(cleanupPaths.map(async (target) => fs.rm(target, { recursive: true, force: true })));
  cleanupPaths.length = 0;
});

test('saves and loads workflows across multiple workspaces without recording leakage', async ({}, testInfo) => {
  testInfo.setTimeout(150_000);
  const workspaceA = `ws-e2e-alpha-${Date.now()}`;
  const workspaceB = `ws-e2e-beta-${Date.now()}`;
  const workflowNameA = workspaceA;
  const workflowNameB = workspaceB;
  const recordingName = 'main';
  const pageUrl = `${baseURL}/workflow/customer_intake.html`;

  cleanupPaths.push(path.resolve(process.cwd(), '.artifacts', 'workflows', workflowNameA));
  cleanupPaths.push(path.resolve(process.cwd(), '.artifacts', 'workflows', workflowNameB));

  const createA = await dispatch(endpoint, actControl('workspace.create', { workspaceName: workspaceA }));
  expect(createA.type).toBe('workspace.create.result');

  const tabA = await openFixtureTab(endpoint, workspaceA, pageUrl);
  expect(tabA).toBeTruthy();

  const recStartA = await dispatch(endpoint, actWorkspace('record.start', workspaceA));
  expect(recStartA.type).toBe('record.start.result');
  await expect.poll(async () => readWorkspaceState(endpoint, workspaceA), { timeout: 10_000 }).toBe('recording');

  expectStepOk(await runStep(endpoint, workspaceA, st('a-fill-name', 'browser.fill', { selector: '#customerName', value: '上海智算科技' })), 'alpha fill name');
  expectStepOk(await runStep(endpoint, workspaceA, st('a-select-source', 'browser.select_option', { selector: '#source', kind: 'native_select', values: ['web'] })), 'alpha select source');
  expectStepOk(await runStep(endpoint, workspaceA, st('a-fill-owner', 'browser.fill', { selector: '#owner', value: 'Alice' })), 'alpha fill owner');
  expectStepOk(await runStep(endpoint, workspaceA, st('a-click-priority', 'browser.click', { selector: '#chooseHighPriority' })), 'alpha click priority');
  expectStepOk(await runStep(endpoint, workspaceA, st('a-fill-note', 'browser.fill', { selector: '#note', value: 'alpha workflow' })), 'alpha fill note');
  expectStepOk(await runStep(endpoint, workspaceA, st('a-submit', 'browser.click', { selector: '#submitBtn' })), 'alpha submit');

  const alphaState = await readPageState(endpoint, workspaceA);
  expect(alphaState.customerName).toBe('上海智算科技');
  expect(alphaState.source).toBe('web');
  expect(alphaState.owner).toBe('Alice');
  expect(alphaState.priority).toBe('high');
  expect(alphaState.note).toBe('alpha workflow');
  expect(alphaState.submitted).toBe('true');

  const recStopA = await dispatch(endpoint, actWorkspace('record.stop', workspaceA));
  expect(recStopA.type).toBe('record.stop.result');
  await expect.poll(async () => readWorkspaceState(endpoint, workspaceA), { timeout: 10_000 }).toBe('idle');

  const recGetA = await dispatch(endpoint, actWorkspace('record.get', workspaceA));
  expect(recGetA.type).toBe('record.get.result');
  const recSaveA = await dispatch(endpoint, actWorkspace('record.save', workspaceA, { recordingName }));
  expect(recSaveA.type).toBe('record.save.result');

  const createB = await dispatch(endpoint, actControl('workspace.create', { workspaceName: workspaceB }));
  expect(createB.type).toBe('workspace.create.result');

  const tabB = await openFixtureTab(endpoint, workspaceB, pageUrl);
  expect(tabB).toBeTruthy();

  const recStartB = await dispatch(endpoint, actWorkspace('record.start', workspaceB));
  expect(recStartB.type).toBe('record.start.result');
  await expect.poll(async () => readWorkspaceState(endpoint, workspaceB), { timeout: 10_000 }).toBe('recording');

  expectStepOk(await runStep(endpoint, workspaceB, st('b-fill-name', 'browser.fill', { selector: '#customerName', value: '南京云原生公司' })), 'beta fill name');
  expectStepOk(await runStep(endpoint, workspaceB, st('b-select-source', 'browser.select_option', { selector: '#source', kind: 'native_select', values: ['referral'] })), 'beta select source');
  expectStepOk(await runStep(endpoint, workspaceB, st('b-fill-owner', 'browser.fill', { selector: '#owner', value: 'Bob' })), 'beta fill owner');
  expectStepOk(await runStep(endpoint, workspaceB, st('b-click-priority', 'browser.click', { selector: '#chooseNormalPriority' })), 'beta click priority');
  expectStepOk(await runStep(endpoint, workspaceB, st('b-fill-note', 'browser.fill', { selector: '#note', value: 'beta workflow' })), 'beta fill note');
  expectStepOk(await runStep(endpoint, workspaceB, st('b-submit', 'browser.click', { selector: '#submitBtn' })), 'beta submit');

  const betaState = await readPageState(endpoint, workspaceB);
  expect(betaState.customerName).toBe('南京云原生公司');
  expect(betaState.source).toBe('referral');
  expect(betaState.owner).toBe('Bob');
  expect(betaState.priority).toBe('normal');
  expect(betaState.note).toBe('beta workflow');
  expect(betaState.submitted).toBe('true');

  const recStopB = await dispatch(endpoint, actWorkspace('record.stop', workspaceB));
  expect(recStopB.type).toBe('record.stop.result');
  await expect.poll(async () => readWorkspaceState(endpoint, workspaceB), { timeout: 10_000 }).toBe('idle');

  const recGetB = await dispatch(endpoint, actWorkspace('record.get', workspaceB));
  expect(recGetB.type).toBe('record.get.result');
  const recSaveB = await dispatch(endpoint, actWorkspace('record.save', workspaceB, { recordingName }));
  expect(recSaveB.type).toBe('record.save.result');

  const alphaStepsPath = workflowStepsPath(workflowNameA);
  const betaStepsPath = workflowStepsPath(workflowNameB);

  const alphaYaml = await fs.readFile(alphaStepsPath, 'utf8');
  const betaYaml = await fs.readFile(betaStepsPath, 'utf8');

  expect(alphaYaml.length).toBeGreaterThan(0);
  expect(betaYaml.length).toBeGreaterThan(0);

  expect(alphaYaml).toContain('上海智算科技');
  expect(alphaYaml).toContain('alpha workflow');
  expect(betaYaml).toContain('南京云原生公司');
  expect(betaYaml).toContain('beta workflow');
  expect(alphaYaml).not.toContain('南京云原生公司');
  expect(betaYaml).not.toContain('上海智算科技');

  const alphaParsed = YAML.parse(alphaYaml) as { version: number; steps: Array<Record<string, unknown>> };
  const betaParsed = YAML.parse(betaYaml) as { version: number; steps: Array<Record<string, unknown>> };

  expect(alphaParsed.version).toBe(1);
  expect(betaParsed.version).toBe(1);
  expect(alphaParsed.steps.length).toBeGreaterThan(0);
  expect(betaParsed.steps.length).toBeGreaterThan(0);

  alphaParsed.steps.forEach((step) => expect(Object.keys(step).sort()).toEqual(['args', 'id', 'name']));
  betaParsed.steps.forEach((step) => expect(Object.keys(step).sort()).toEqual(['args', 'id', 'name']));

  expect(alphaYaml).not.toContain('meta:');
  expect(betaYaml).not.toContain('meta:');
  expect(alphaYaml).not.toContain('resolve:');
  expect(betaYaml).not.toContain('resolve:');
  expect(alphaYaml).not.toContain('tabToken');
  expect(betaYaml).not.toContain('tabToken');
  expect(alphaYaml).not.toContain('scope:');
  expect(betaYaml).not.toContain('scope:');

  const alphaRecordingDir = path.resolve(process.cwd(), '.artifacts', 'workflows', workflowNameA, 'recordings');
  const betaRecordingDir = path.resolve(process.cwd(), '.artifacts', 'workflows', workflowNameB, 'recordings');
  const alphaRecordings = await fs.readdir(alphaRecordingDir);
  const betaRecordings = await fs.readdir(betaRecordingDir);
  expect(alphaRecordings).toContain('main');
  expect(betaRecordings).toContain('main');

  expectStepOk(await runStep(endpoint, workspaceA, st('a-switch-reset', 'browser.switch_tab', { tabName: tabA })), 'alpha switch before reset');
  expectStepOk(await runStep(endpoint, workspaceA, st('a-reset', 'browser.click', { selector: '#resetBtn' })), 'alpha reset');
  expectStepOk(await runStep(endpoint, workspaceB, st('b-switch-reset', 'browser.switch_tab', { tabName: tabB })), 'beta switch before reset');
  expectStepOk(await runStep(endpoint, workspaceB, st('b-reset', 'browser.click', { selector: '#resetBtn' })), 'beta reset');

  const alphaResetState = await readPageState(endpoint, workspaceA);
  const betaResetState = await readPageState(endpoint, workspaceB);
  expect(alphaResetState.submitted).toBe('false');
  expect(betaResetState.submitted).toBe('false');

  const loadA = await dispatch(endpoint, actControl('workflow.open', { workflowName: workflowNameA }));
  expect(loadA.type).toBe('workflow.open.result');
  expectStepOk(await runStep(endpoint, workspaceA, st('a-switch-replay', 'browser.switch_tab', { tabName: tabA })), 'alpha switch before replay');
  const playA = await dispatch(endpoint, actWorkspace('play.start', workspaceA, { recordingName, stopOnError: true }));
  expect(playA.type).toBe('play.started');
  await expect.poll(async () => readWorkspaceState(endpoint, workspaceA), { timeout: 120_000 }).toBe('idle');

  const alphaReplayed = await readPageState(endpoint, workspaceA);
  const betaUnchangedAfterAlpha = await readPageState(endpoint, workspaceB);
  expect(alphaReplayed.customerName).toBe('上海智算科技');
  expect(alphaReplayed.source).toBe('web');
  expect(alphaReplayed.owner).toBe('Alice');
  expect(alphaReplayed.priority).toBe('high');
  expect(alphaReplayed.note).toBe('alpha workflow');
  expect(alphaReplayed.submitted).toBe('true');

  expect(betaUnchangedAfterAlpha.customerName).toBe('');
  expect(betaUnchangedAfterAlpha.source).toBe('');
  expect(betaUnchangedAfterAlpha.owner).toBe('');
  expect(betaUnchangedAfterAlpha.priority).toBe('');
  expect(betaUnchangedAfterAlpha.note).toBe('');
  expect(betaUnchangedAfterAlpha.submitted).toBe('false');

  const loadB = await dispatch(endpoint, actControl('workflow.open', { workflowName: workflowNameB }));
  expect(loadB.type).toBe('workflow.open.result');
  expectStepOk(await runStep(endpoint, workspaceB, st('b-switch-replay', 'browser.switch_tab', { tabName: tabB })), 'beta switch before replay');
  const playB = await dispatch(endpoint, actWorkspace('play.start', workspaceB, { recordingName, stopOnError: true }));
  expect(playB.type).toBe('play.started');
  await expect.poll(async () => readWorkspaceState(endpoint, workspaceB), { timeout: 120_000 }).toBe('idle');

  const betaReplayed = await readPageState(endpoint, workspaceB);
  const alphaStillIsolated = await readPageState(endpoint, workspaceA);
  expect(betaReplayed.customerName).toBe('南京云原生公司');
  expect(betaReplayed.source).toBe('referral');
  expect(betaReplayed.owner).toBe('Bob');
  expect(betaReplayed.priority).toBe('normal');
  expect(betaReplayed.note).toBe('beta workflow');
  expect(betaReplayed.submitted).toBe('true');

  expect(alphaStillIsolated.customerName).toBe('上海智算科技');
  expect(alphaStillIsolated.source).toBe('web');
  expect(alphaStillIsolated.owner).toBe('Alice');
  expect(alphaStillIsolated.priority).toBe('high');
  expect(alphaStillIsolated.note).toBe('alpha workflow');
  expect(alphaStillIsolated.submitted).toBe('true');
});
