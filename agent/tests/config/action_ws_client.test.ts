import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startActionWsClient } from '../../src/actions/ws_client';
import type { Action } from '../../src/actions/action_protocol';
import { createTestWorkspaceRegistry } from '../helpers/workspace/registry';
import { createWorkflowOnFs } from '../../src/workflow';

const waitOpen = async (ws: WebSocket) => {
    await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (err) => reject(err));
    });
};

const waitMessage = async (ws: WebSocket): Promise<Action> => {
    return await new Promise<Action>((resolve, reject) => {
        ws.once('message', (data) => {
            try {
                resolve(JSON.parse(String(data)) as Action);
            } catch (error) {
                reject(error);
            }
        });
        ws.once('error', (err) => reject(err));
    });
};

const waitForType = async (ws: WebSocket, type: string, timeoutMs = 2000): Promise<Action> => {
    return await new Promise<Action>((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.off('message', onMessage);
            reject(new Error(`timeout waiting for ${type}`));
        }, timeoutMs);
        const onMessage = (data: unknown) => {
            try {
                const action = JSON.parse(String(data)) as Action;
                if (action.type === type) {
                    clearTimeout(timer);
                    ws.off('message', onMessage);
                    resolve(action);
                }
            } catch {}
        };
        ws.on('message', onMessage);
        ws.once('error', (err) => {
            clearTimeout(timer);
            ws.off('message', onMessage);
            reject(err);
        });
    });
};

const randomPort = () => 20000 + Math.floor(Math.random() * 20000);

test('invalid json returns action.dispatch.failed', async () => {
    const port = randomPort();
    const { registry } = createTestWorkspaceRegistry();
    const server = startActionWsClient({
        port,
        workspaceRegistry: registry,
        dispatchAction: async () => ({ v: 1, id: 'n/a', type: 'workspace.list.result', payload: {} }),
        onError: () => undefined,
    });
    void server;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws);
    ws.send('{bad-json');
    const reply = await waitMessage(ws);
    assert.equal(reply.type, 'action.dispatch.failed');
    assert.equal((reply.payload as any).code, 'ERR_BAD_JSON');
    ws.close();
    await server.close();
});

test('invalid action envelope returns failed action', async () => {
    const port = randomPort();
    const { registry } = createTestWorkspaceRegistry();
    const server = startActionWsClient({
        port,
        workspaceRegistry: registry,
        dispatchAction: async () => ({ v: 1, id: 'n/a', type: 'workspace.list.result', payload: {} }),
        onError: () => undefined,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws);
    ws.send(JSON.stringify({ v: 1, id: 'a1', type: 'invalid.type', payload: {} }));
    const reply = await waitMessage(ws);
    assert.equal(reply.type, 'action.dispatch.failed');
    ws.close();
    await server.close();
});

test('dispatchAction reply and projection broadcast', async () => {
    const port = randomPort();
    const calls: Action[] = [];
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${Date.now()}`;
    registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    const wsServer = startActionWsClient({
        port,
        workspaceRegistry: registry,
        dispatchAction: async (action) => {
            calls.push(action);
            return {
                v: 1,
                id: 'r1',
                type: `${action.type}.result`,
                payload: { ok: true, workspaceName: wsName, tabName: 'tab-1' },
                replyTo: action.id,
            };
        },
        onError: () => undefined,
    });
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws1);
    await waitOpen(ws2);

    const req = {
        v: 1 as const,
        id: 'req1',
        type: 'tab.reassign',
        workspaceName: wsName,
        payload: { tabName: 'tab-1', source: 'test' },
    };
    const changedOnWs2Promise = waitForType(ws2, 'workspace.changed');
    const syncOnWs2Promise = waitForType(ws2, 'workspace.sync');
    ws1.send(JSON.stringify(req));

    const reply = await waitMessage(ws1);
    assert.equal(reply.type, 'tab.reassign.result');
    assert.equal(calls.length, 1);

    const eventOnWs2 = await changedOnWs2Promise;
    assert.equal(eventOnWs2.type, 'workspace.changed');

    const syncEventOnWs2 = await syncOnWs2Promise;
    assert.equal(syncEventOnWs2.type, 'workspace.sync');

    const listOnWs1Promise = waitForType(ws1, 'workspace.list');
    wsServer.broadcastAction({ v: 1, id: 'b1', type: 'workspace.sync', payload: { reason: 'manual' } });
    const listEventOnWs1 = await listOnWs1Promise;
    assert.equal(listEventOnWs1.type, 'workspace.list');
    assert.equal((listEventOnWs1.payload as any).reason, 'manual');

    ws2.close();
    ws1.close();
    await wsServer.close();
});
