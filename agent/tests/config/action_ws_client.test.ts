import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startActionWsClient } from '../../src/actions/ws_client';
import type { Action } from '../../src/actions/action_protocol';

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

const randomPort = () => 20000 + Math.floor(Math.random() * 20000);

test('invalid json returns action.dispatch.failed', async () => {
    const port = randomPort();
    const server = startActionWsClient({
        port,
        dispatchAction: async () => ({ v: 1, id: 'n/a', type: 'workspace.list.result', payload: {} }),
        projectActionResult: () => [],
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
    const server = startActionWsClient({
        port,
        dispatchAction: async () => ({ v: 1, id: 'n/a', type: 'workspace.list.result', payload: {} }),
        projectActionResult: () => [],
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
    const projected: Action = { v: 1, id: 'evt1', type: 'workspace.changed', payload: { ok: true } };
    const wsServer = startActionWsClient({
        port,
        dispatchAction: async (action) => {
            calls.push(action);
            return { v: 1, id: 'r1', type: `${action.type}.result`, payload: { ok: true }, replyTo: action.id };
        },
        projectActionResult: () => [projected],
        onError: () => undefined,
    });
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws1);
    await waitOpen(ws2);

    const req = { v: 1 as const, id: 'req1', type: 'workspace.list', payload: {} };
    ws1.send(JSON.stringify(req));

    const reply = await waitMessage(ws1);
    assert.equal(reply.type, 'workspace.list.result');
    assert.equal(calls.length, 1);

    const eventOnWs2 = await waitMessage(ws2);
    assert.equal(eventOnWs2.type, 'workspace.changed');

    ws2.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    wsServer.broadcastAction({ v: 1, id: 'b1', type: 'workspace.sync', payload: {} });

    ws1.close();
    await wsServer.close();
});
