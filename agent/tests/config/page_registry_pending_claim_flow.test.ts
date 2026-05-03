import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createWorkspaceRegistry } from '../../src/runtime/workspace/registry';
import { createWorkflowOnFs } from '../../src/workflow';
import { createActionDispatcher } from '../../src/actions/dispatcher';
import { setWorkspaceRouterServices } from '../../src/runtime/workspace/router';

test('workspace gateway routes tab.list with workspaceName into workspace control', async () => {
    const registry = createWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabRegistry.createTab({ tabName: 'tab-1', url: 'about:blank', title: '' });

    setWorkspaceRouterServices({
        pageRegistry: {
            getPage: async () => ({ url: () => 'about:blank' } as any),
        },
    });

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
