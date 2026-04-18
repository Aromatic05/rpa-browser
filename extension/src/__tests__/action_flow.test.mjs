import assert from 'node:assert/strict';
import { createActionBus } from '../../dist/background/action_bus.js';
import { createWsClient } from '../../dist/background/ws_client.js';
import { send } from '../../dist/shared/send.js';
import { classifyActionType } from '../../dist/shared/action_types.js';

const log = async (name, fn) => {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

await log('action bus dispatches by patterns', async () => {
    const bus = createActionBus();
    const hits = [];
    bus.subscribe(['play.step.*'], (action) => hits.push(`step:${action.type}`));
    bus.subscribe(['workspace.*'], (action) => hits.push(`ws:${action.type}`));
    bus.publish({ v: 1, id: '1', type: 'play.step.finished', payload: {} });
    bus.publish({ v: 1, id: '2', type: 'workspace.changed', payload: {} });
    bus.publish({ v: 1, id: '3', type: 'play.completed', payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(hits, ['step:play.step.finished', 'ws:workspace.changed']);
});

await log('action type classifier separates command/reply/event', async () => {
    assert.equal(classifyActionType('workspace.list'), 'command');
    assert.equal(classifyActionType('workspace.list.result'), 'reply');
    assert.equal(classifyActionType('workspace.list.failed'), 'reply');
    assert.equal(classifyActionType('play.failed'), 'event');
    assert.equal(classifyActionType('play.step.finished'), 'event');
});

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor() {
        this.readyState = FakeWebSocket.CONNECTING;
        this.OPEN = FakeWebSocket.OPEN;
        this.listeners = new Map();
        this.sent = [];
        FakeWebSocket.instances.push(this);
        queueMicrotask(() => {
            this.readyState = FakeWebSocket.OPEN;
            this.emit('open');
        });
    }

    addEventListener(name, cb) {
        const list = this.listeners.get(name) || [];
        list.push(cb);
        this.listeners.set(name, list);
    }

    send(payload) {
        this.sent.push(payload);
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.emit('close');
    }

    emit(name, event) {
        const list = this.listeners.get(name) || [];
        for (const cb of list) cb(event);
    }
}

await log('ws client resolves pending only on reply actions', async () => {
    const OriginalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket;
    try {
        const received = [];
        const client = createWsClient({
            onAction: (action) => {
                received.push(action.type);
            },
        });
        const request = { v: 1, id: 'req-1', type: 'play.start', payload: {} };
        const promise = client.sendAction(request);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const ws = FakeWebSocket.instances.at(-1);
        assert.ok(ws, 'websocket instance should be created');
        assert.equal(ws.sent.length, 1);

        ws.emit('message', {
            data: JSON.stringify({
                v: 1,
                id: 'evt-1',
                type: 'play.step.started',
                replyTo: 'req-1',
                payload: { stepId: 's1' },
            }),
        });
        let settled = false;
        void promise.then(() => {
            settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(settled, false, 'event with replyTo should not resolve request');

        ws.emit('message', {
            data: JSON.stringify({
                v: 1,
                id: 'reply-1',
                type: 'play.start.result',
                replyTo: 'req-1',
                payload: { started: true },
            }),
        });
        const reply = await promise;
        assert.equal(reply.type, 'play.start.result');
        assert.equal(received.includes('play.step.started'), true);
    } finally {
        globalThis.WebSocket = OriginalWebSocket;
        FakeWebSocket.instances.length = 0;
    }
});

await log('send.action returns failed action for transport errors', async () => {
    const originalChrome = globalThis.chrome;
    const runtime = {
        lastError: null,
        sendMessage: (_req, cb) => {
            runtime.lastError = { message: 'Receiving end does not exist.' };
            cb(undefined);
            runtime.lastError = null;
        },
    };
    globalThis.chrome = {
        runtime,
        tabs: { sendMessage: () => undefined },
    };
    try {
        const action = { v: 1, id: 'req-err', type: 'workspace.list', payload: {} };
        const reply = await send.action(action);
        assert.equal(reply.type, 'workspace.list.failed');
        assert.equal(reply.replyTo, 'req-err');
        assert.equal(reply.payload.code, 'NO_RECEIVER');
    } finally {
        globalThis.chrome = originalChrome;
    }
});
