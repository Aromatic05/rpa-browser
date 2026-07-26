import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Action } from '../../../src/actions/action_protocol';
import type { StepUnion } from '../../../src/runner/steps/types';
import { dispatch, runStep, startAgent } from '../../helpers/e2e_multitab_helper';
import { startFixtureServer } from '../../helpers/server';

const st = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args']): Extract<StepUnion, { name: T }> =>
  ({ id, name, args } as unknown as Extract<StepUnion, { name: T }>);

const controlAction = (type: string, payload: Record<string, unknown> = {}): Action => ({
  v: 1,
  id: crypto.randomUUID(),
  type,
  payload,
  at: Date.now(),
});

const workspaceAction = (type: string, workspaceName: string, payload: Record<string, unknown> = {}): Action => ({
  v: 1,
  id: crypto.randomUUID(),
  type,
  workspaceName,
  payload,
  at: Date.now(),
});

const expectActionOk = (action: Action, type: string) => {
  expect(action.type, JSON.stringify(action.payload || {})).toBe(type);
};

const listTabs = async (endpoint: string, workspaceName: string) => {
  const reply = await dispatch(endpoint, workspaceAction('tab.list', workspaceName));
  expectActionOk(reply, 'tab.list.result');
  return ((reply.payload || {}) as { tabs?: Array<{ tabName: string }> }).tabs || [];
};

const openFixture = async (endpoint: string, workspaceName: string, url: string) => {
  const before = new Set((await listTabs(endpoint, workspaceName)).map((tab) => tab.tabName));
  expectActionOk(await dispatch(endpoint, workspaceAction('tab.open', workspaceName)), 'tab.open.result');
  let tabName = '';
  await expect.poll(async () => {
    const created = (await listTabs(endpoint, workspaceName)).find((tab) => !before.has(tab.tabName));
    tabName = created?.tabName || '';
    return tabName;
  }, { timeout: 15_000 }).toBeTruthy();
  const switched = await runStep(endpoint, workspaceName, st(`switch-${workspaceName}`, 'browser.switch_tab', { tabName }));
  expect(switched.ok, JSON.stringify(switched.error || {})).toBeTruthy();
  const navigated = await runStep(endpoint, workspaceName, st(`goto-${workspaceName}`, 'browser.goto', { url }));
  expect(navigated.ok, JSON.stringify(navigated.error || {})).toBeTruthy();
  return tabName;
};

const readCustomerName = async (endpoint: string, workspaceName: string) => {
  const result = await runStep(endpoint, workspaceName, st(`read-${workspaceName}-${Date.now()}`, 'browser.evaluate', {
    expression: `document.querySelector('#customerName')?.value || ''`,
  }));
  expect(result.ok, JSON.stringify(result.error || {})).toBeTruthy();
  return String(result.data || '');
};


const readEntities = async (endpoint: string, workspaceName: string) => {
  const result = await runStep(endpoint, workspaceName, st(`entities-${workspaceName}-${Date.now()}`, 'browser.entity', { op: 'list' }));
  expect(result.ok, JSON.stringify(result.error || {})).toBeTruthy();
  return result.data as { total: number; entities: Array<Record<string, unknown>>; diagnostics?: unknown };
};

const makeRules = (profileName: string, businessTag: string, urlPattern: string) => ({
  kind: 'entity_rules',
  name: profileName,
  match: {
    version: 1,
    page: { kind: 'form', urlPattern },
    entities: [
      { ruleId: 'main_form', source: 'region', expect: 'unique', match: { kind: 'form' } },
      { ruleId: 'customer_input', source: 'node', expect: 'unique', within: 'main_form', match: { ariaContains: '客户名称' } },
    ],
  },
  annotation: {
    version: 1,
    page: { kind: 'form' },
    annotations: [
      {
        ruleId: 'main_form',
        businessTag,
        businessName: businessTag,
        fields: [
          { fieldKey: 'customerName', name: '客户名称', kind: 'input', controlRuleId: 'customer_input' },
        ],
      },
    ],
  },
});

const makeDsl = (businessTag: string) => `
use checkpoint "shared-checkpoint"

let customer = query entity.target "${businessTag}" {
  kind: "form.field"
  fieldKey: "customerName"
}

fill customer with input.value
`;

test('workflow reopens DSL, checkpoint and entity rules as isolated executable artifacts', async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  const fixture = await startFixtureServer();
  const agent = await startAgent();
  const workflowA = `workflow-artifacts-a-${Date.now()}`;
  const workflowB = `workflow-artifacts-b-${Date.now()}`;
  const cleanup = [workflowA, workflowB].map((name) => path.resolve(process.cwd(), '.artifacts', 'workflows', name));
  const pageUrl = `${fixture.baseURL}/workflow/artifact_runtime.html`;
  const urlPattern = '/workflow/artifact_runtime\\.html$';

  try {
    for (const [workflowName, source] of [[workflowA, 'alpha'], [workflowB, 'beta']] as const) {
      expectActionOk(
        await dispatch(agent.endpoint, controlAction('workflow.create', { workflowName })),
        'workflow.create.result',
      );
      await openFixture(agent.endpoint, workflowName, pageUrl);

      expectActionOk(
        await dispatch(agent.endpoint, workspaceAction('checkpoint.save', workflowName, {
          checkpoint: {
            id: 'shared-checkpoint',
            trigger: { matchRules: [{ errorCode: 'ERR_UNUSED' }] },
            output: { checkpointSource: source },
          },
        })),
        'checkpoint.save.result',
      );

      expectActionOk(
        await dispatch(agent.endpoint, workspaceAction('entity_rules.save', workflowName, {
          entityRules: makeRules('shared-profile', `workflow.form.${source}`, urlPattern),
        })),
        'entity_rules.save.result',
      );

      expectActionOk(
        await dispatch(agent.endpoint, workspaceAction('dsl.save', workflowName, {
          dslName: 'main',
          content: makeDsl(`workflow.form.${source}`),
        })),
        'dsl.save.result',
      );
    }

    expectActionOk(await dispatch(agent.endpoint, controlAction('workspace.close', { workspaceName: workflowA })), 'workspace.close.result');
    expectActionOk(await dispatch(agent.endpoint, controlAction('workspace.close', { workspaceName: workflowB })), 'workspace.close.result');

    expectActionOk(await dispatch(agent.endpoint, controlAction('workflow.open', { workflowName: workflowA })), 'workflow.open.result');
    await openFixture(agent.endpoint, workflowA, pageUrl);
    const entitiesA = await readEntities(agent.endpoint, workflowA);
    expect(entitiesA.total).toBe(1);
    expect(entitiesA.entities[0]?.business_tag).toBe('workflow.form.alpha');
    const targetA = await runStep(agent.endpoint, workflowA, st(`target-${workflowA}`, 'browser.query', {
      op: 'entity.target',
      businessTag: 'workflow.form.alpha',
      target: { kind: 'form.field', fieldKey: 'customerName' },
    }));
    expect(targetA.ok, JSON.stringify(targetA.error || {})).toBeTruthy();
    const runA = await dispatch(agent.endpoint, workspaceAction('dsl.run', workflowA, { dslName: 'main', input: { value: 'Alice Workflow' } }));
    expectActionOk(runA, 'dsl.run.result');
    expect((runA.payload as { output?: { checkpointSource?: string } }).output?.checkpointSource).toBe('alpha');
    expect(await readCustomerName(agent.endpoint, workflowA)).toBe('Alice Workflow');

    expectActionOk(await dispatch(agent.endpoint, controlAction('workflow.open', { workflowName: workflowB })), 'workflow.open.result');
    await openFixture(agent.endpoint, workflowB, pageUrl);
    expect(await readCustomerName(agent.endpoint, workflowB)).toBe('');
    const entitiesB = await readEntities(agent.endpoint, workflowB);
    expect(entitiesB.total).toBe(1);
    expect(entitiesB.entities[0]?.business_tag).toBe('workflow.form.beta');
    const runB = await dispatch(agent.endpoint, workspaceAction('dsl.run', workflowB, { dslName: 'main', input: { value: 'Bob Workflow' } }));
    expectActionOk(runB, 'dsl.run.result');
    expect((runB.payload as { output?: { checkpointSource?: string } }).output?.checkpointSource).toBe('beta');
    expect(await readCustomerName(agent.endpoint, workflowB)).toBe('Bob Workflow');
    expect(await readCustomerName(agent.endpoint, workflowA)).toBe('Alice Workflow');
  } finally {
    await agent.close();
    await fixture.close();
    await Promise.all(cleanup.map((target) => fs.rm(target, { recursive: true, force: true })));
  }
});
