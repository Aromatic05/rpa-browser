import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestWorkspaceRegistry } from '../helpers/workspace_registry';
import { createWorkflowOnFs } from '../../src/workflow';
import { createActionDispatcher } from '../../src/actions/dispatcher';

test('workspace gateway routes tab.list with workspaceName into workspace control', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', url: 'about:blank', title: '' });

    const dispatcher = createActionDispatcher({
        workspaceRegistry: registry,
        log: () => undefined,
    });

    const reply = await dispatcher.dispatch({
        v: 1,
        id: 'd1',
        type: 'tab.list',
        workspaceName: wsName,
    });

    assert.equal(reply.type, 'tab.list.result');
    assert.equal(Array.isArray((reply.payload as any).tabs), true);
});
