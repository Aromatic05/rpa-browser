import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWorkflowOnFs, deleteWorkflowFromFs } from '../../src/workflow';
import { createTestWorkspaceRegistry } from '../helpers/workspace_registry';

const unique = (prefix: string) => `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const cleanup = (name: string) => { try { deleteWorkflowFromFs(name); } catch {} };

test('createWorkspace binds controls on RuntimeWorkspace', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = unique('ws-bind');
    cleanup(wsName);
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    assert.ok(ws.router);
    assert.ok(ws.router);
    assert.ok(ws.record);
    assert.ok(ws.dsl);
    assert.ok(ws.runner);
    cleanup(wsName);
});

test('workspace controls route tab.list via bound workspace control', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = unique('ws-tab-list');
    cleanup(wsName);
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', url: 'about:blank', title: '' });
    const reply = await ws.router.handle({ v: 1, id: '1', type: 'tab.list', workspaceName: wsName } as any, ws as any, registry as any);
    assert.equal(reply.reply.type, 'tab.list.result');
    cleanup(wsName);
});

test('domain controls are bound and invokable', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = unique('ws-domain');
    cleanup(wsName);
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', url: 'about:blank', title: '' });
    ws.tabs.setActiveTab('tab-1');

    const recordGet = await ws.record.handle({ action: { v: 1, id: 'r1', type: 'record.get', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(recordGet.reply.type, 'record.get.result');

    ws.workflow.save({ kind: 'dsl', name: 'main', content: '' } as any);
    const dslGet = await ws.dsl.handle({ action: { v: 1, id: 'd1', type: 'dsl.get', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(dslGet.reply.type, 'dsl.get.result');

    const runStart = await ws.runner.handle({ action: { v: 1, id: 't1', type: 'task.run.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(runStart.reply.type, 'task.run.start.result');
    cleanup(wsName);
});

test('bootstrap and gateway files keep boundary constraints', () => {
    const indexSource = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
    const mcpSource = fs.readFileSync(path.resolve(process.cwd(), 'src/mcp_main.ts'), 'utf8');
    assert.equal(indexSource.includes('setWorkspaceRouterServices'), false);
    assert.equal(indexSource.includes('setWorkflowControlServices'), false);
    assert.equal(indexSource.includes('setRecordControlServices'), false);
    assert.equal(indexSource.includes('setDslControlServices'), false);
    assert.equal(mcpSource.includes('setWorkspaceRouterServices'), false);
    assert.equal(mcpSource.includes('setWorkflowControlServices'), false);
    assert.equal(mcpSource.includes('setRecordControlServices'), false);
    assert.equal(mcpSource.includes('setDslControlServices'), false);

    const dispatcherSource = fs.readFileSync(path.resolve(process.cwd(), 'src/actions/dispatcher.ts'), 'utf8');
    const controlGatewaySource = fs.readFileSync(path.resolve(process.cwd(), 'src/actions/control_gateway.ts'), 'utf8');
    const workspaceGatewaySource = fs.readFileSync(path.resolve(process.cwd(), 'src/actions/workspace_gateway.ts'), 'utf8');
    for (const source of [dispatcherSource, controlGatewaySource, workspaceGatewaySource]) {
        assert.equal(source.includes('recordingState'), false);
        assert.equal(source.includes('replayOptions'), false);
        assert.equal(source.includes('navDedupeWindowMs'), false);
        assert.equal(source.includes('runStepsDeps'), false);
        assert.equal(source.includes('runnerConfig'), false);
    }
});
