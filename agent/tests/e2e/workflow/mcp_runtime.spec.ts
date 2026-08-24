import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import type { Action } from '../../../src/interface/actions/action_protocol';
import { dispatch, startAgent } from '../../helpers/e2e_multitab_helper';
import { deleteWorkflowFromFs } from '../../../src/automation/workflow';

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

const expectAction = (action: Action, type: string) => {
  expect(action.type, JSON.stringify(action.payload || {})).toBe(type);
  return (action.payload || {}) as Record<string, unknown>;
};

const postMcp = async (port: number, payload: unknown) => {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as any : null };
};

const initializeMcp = async (port: number) => {
  const initialized = await postMcp(port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'workflow-mcp-e2e', version: '1.0.0' },
    },
  });
  expect(initialized.status).toBe(200);
  expect(initialized.body?.result?.serverInfo?.name).toBe('rpa-agent');
  const notice = await postMcp(port, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  });
  expect(notice.status).toBe(202);
};

const listTools = async (port: number) => {
  const reply = await postMcp(port, { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/list', params: {} });
  expect(reply.status).toBe(200);
  return (reply.body?.result?.tools || []) as Array<{ name: string }>;
};

const callTool = async (port: number, name: string, args: Record<string, unknown> = {}) => {
  const reply = await postMcp(port, {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'tools/call',
    params: { name, arguments: args },
  });
  expect(reply.status).toBe(200);
  const text = reply.body?.result?.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text) as { ok: boolean; data?: any; error?: { code?: string; message?: string } };
};

const healthIsUp = async (port: number) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.status === 200;
  } catch {
    return false;
  }
};

const startMcp = async (endpoint: string, workspaceName: string) => {
  const payload = expectAction(await dispatch(endpoint, workspaceAction('mcp.start', workspaceName)), 'mcp.start.result');
  expect(payload.status).toBe('running');
  const port = Number(payload.port);
  expect(port).toBeGreaterThan(0);
  await initializeMcp(port);
  return port;
};

test('workflow MCP serves real tools, isolates workspaces and follows workflow lifecycle', async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  const agent = await startAgent();
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const workflowA = `workflow-mcp-a-${suffix}`;
  const workflowB = `workflow-mcp-b-${suffix}`;
  const workflowC = `workflow-mcp-c-${suffix}`;
  const workflowD = `workflow-mcp-d-${suffix}`;

  try {
    expectAction(await dispatch(agent.endpoint, controlAction('workflow.create', { workflowName: workflowA })), 'workflow.create.result');
    expectAction(await dispatch(agent.endpoint, controlAction('workflow.create', { workflowName: workflowB })), 'workflow.create.result');

    const portA = await startMcp(agent.endpoint, workflowA);
    const portB = await startMcp(agent.endpoint, workflowB);
    expect(portA).not.toBe(portB);

    const tools = await listTools(portA);
    expect(tools.some((tool) => tool.name === 'browser.create_tab')).toBeTruthy();
    expect(tools.some((tool) => tool.name === 'browser.list_tabs')).toBeTruthy();

    const emptyA = await callTool(portA, 'browser.list_tabs');
    const emptyB = await callTool(portB, 'browser.list_tabs');
    expect(emptyA.ok, JSON.stringify(emptyA.error || {})).toBeTruthy();
    expect(emptyB.ok, JSON.stringify(emptyB.error || {})).toBeTruthy();
    expect(emptyA.data?.tabs).toEqual([]);
    expect(emptyB.data?.tabs).toEqual([]);

    const goto = await callTool(portA, 'browser.goto', {
      url: 'data:text/html,<title>MCP Workflow A</title><h1>MCP Workflow A</h1>',
    });
    expect(goto.ok, JSON.stringify(goto.error || {})).toBeTruthy();

    const tabsA = await callTool(portA, 'browser.list_tabs');
    const tabsB = await callTool(portB, 'browser.list_tabs');
    expect(tabsA.data?.tabs).toHaveLength(1);
    expect(tabsA.data?.tabs[0]?.active).toBeTruthy();
    expect(tabsB.data?.tabs).toHaveLength(0);

    const pageInfo = await callTool(portA, 'browser.get_page_info');
    expect(pageInfo.ok, JSON.stringify(pageInfo.error || {})).toBeTruthy();
    expect(pageInfo.data?.title).toBe('MCP Workflow A');

    expectAction(await dispatch(agent.endpoint, controlAction('workspace.close', { workspaceName: workflowA })), 'workspace.close.result');
    await expect.poll(() => healthIsUp(portA), { timeout: 10_000 }).toBeFalsy();
    expect(await healthIsUp(portB)).toBeTruthy();

    expectAction(await dispatch(agent.endpoint, controlAction('workflow.open', { workflowName: workflowA })), 'workflow.open.result');
    const reopenedStatus = expectAction(await dispatch(agent.endpoint, workspaceAction('mcp.status', workflowA)), 'mcp.status.result');
    expect(reopenedStatus.status).toBe('stopped');
    const reopenedPort = await startMcp(agent.endpoint, workflowA);
    const reopenedTabs = await callTool(reopenedPort, 'browser.list_tabs');
    expect(reopenedTabs.ok, JSON.stringify(reopenedTabs.error || {})).toBeTruthy();
    expect(reopenedTabs.data?.tabs.length).toBeGreaterThanOrEqual(1);

    expectAction(
      await dispatch(agent.endpoint, controlAction('workflow.saveAs', { sourceName: workflowB, targetName: workflowC })),
      'workflow.saveAs.result',
    );
    const copiedStatus = expectAction(await dispatch(agent.endpoint, workspaceAction('mcp.status', workflowC)), 'mcp.status.result');
    expect(copiedStatus.status).toBe('stopped');
    expect(await healthIsUp(portB)).toBeTruthy();

    expectAction(await dispatch(agent.endpoint, controlAction('workflow.rename', { fromName: workflowB, toName: workflowD })), 'workflow.rename.result');
    await expect.poll(() => healthIsUp(portB), { timeout: 10_000 }).toBeFalsy();
    const renamedStatus = expectAction(await dispatch(agent.endpoint, workspaceAction('mcp.status', workflowD)), 'mcp.status.result');
    expect(renamedStatus.status).toBe('stopped');

    const renamedPort = await startMcp(agent.endpoint, workflowD);
    expectAction(await dispatch(agent.endpoint, workspaceAction('mcp.stop', workflowD)), 'mcp.stop.result');
    await expect.poll(() => healthIsUp(renamedPort), { timeout: 10_000 }).toBeFalsy();
    const stoppedStatus = expectAction(await dispatch(agent.endpoint, workspaceAction('mcp.status', workflowD)), 'mcp.status.result');
    expect(stoppedStatus.status).toBe('stopped');

    expectAction(await dispatch(agent.endpoint, controlAction('workspace.close', { workspaceName: workflowA })), 'workspace.close.result');
    await expect.poll(() => healthIsUp(reopenedPort), { timeout: 10_000 }).toBeFalsy();
    expectAction(await dispatch(agent.endpoint, controlAction('workspace.close', { workspaceName: workflowC })), 'workspace.close.result');
    expectAction(await dispatch(agent.endpoint, controlAction('workspace.close', { workspaceName: workflowD })), 'workspace.close.result');
  } finally {
    await agent.close();
    for (const workflowName of [workflowA, workflowB, workflowC, workflowD]) {
      try { deleteWorkflowFromFs(workflowName); } catch {}
    }
  }
});
