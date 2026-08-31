import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createPortAllocator} from '../../../../src/automation/runtime/service/ports';
import {createWorkspaceAgentService} from '../../../../src/agent/service/runtime';
import {createAgentControl} from '../../../../src/agent/service/control';
import type {AgentRunResult} from '../../../../src/agent/execution/types';

const baseTrace = {
    metrics: {
        turns: 1,
        toolCalls: 0,
        readCalls: 0,
        controlCalls: 0,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    },
    tools: [],
};

const portAllocator = createPortAllocator(24900);

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const pausedResult = (): AgentRunResult => ({
    provider: 'p',
    model: 'm',
    text: 'paused',
    trace: baseTrace,
    programs: [{
        source: 'output s = input.secret',
        input: {},
        status: 'paused',
        pause: {reason: 'barrier', continuationId: 'c-1', stepName: 'browser.submit', risk: 'irreversible'},
    }],
    continuation: {
        resume: async () => ({
            provider: 'p', model: 'm', text: 'resumed', trace: baseTrace,
            programs: [{source: 's', input: {}, status: 'completed' as const}],
        }),
    },
    control: {control: async () => ({provider: 'p', model: 'm', text: 'controlled', trace: baseTrace})},
});

type Plane = {
    baseUrl: string;
    handleProduct: (payload: unknown) => Promise<any>;
    stop: () => Promise<void>;
    workspaceName: string;
};

const makePlane = async (workspaceName: string): Promise<Plane> => {
    const service = createWorkspaceAgentService({
        workspaceName,
        portAllocator,
        runner: {run: async () => pausedResult()},
        productDefaults: {provider: 'p', model: 'm'},
    });
    const control = createAgentControl(service);
    assert.equal(control.product, service.product,
        'createAgentControl must operate on the one service-owned ProductController');
    const started = await service.start();
    return {
        workspaceName,
        baseUrl: `http://127.0.0.1:${String(started.port)}`,
        handleProduct: async (payload: unknown) => {
            const {reply} = await control.handle({
                action: {
                    v: 1,
                    id: crypto.randomUUID(),
                    type: 'agent.product',
                    workspaceName,
                    payload,
                    at: Date.now(),
                },
                workspace: {} as any,
                workspaceRegistry: {} as any,
            });
            return reply;
        },
        stop: async () => {
            await service.stop();
            portAllocator.release(workspaceName, 'agent');
        },
    };
};

const post = (url: string, body?: unknown) => fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});

const assertCoherentLog = (eventsBody: any): void => {
    assert.equal(eventsBody.gap, false);
    const seqs = eventsBody.events.map((event: any) => event.seq);
    assert.deepEqual(seqs, seqs.map((_unused: number, index: number) => index + 1),
        'sequences are dense from 1 with no resets or duplicates');
    const created = eventsBody.events.filter((event: any) => event.kind === 'task_created');
    assert.equal(created.length, 1, 'the shared event log emits task_created exactly once');
};

test('a task started over the agent.product Action is readable over HTTP with one coherent event log', async () => {
    const plane = await makePlane('product-plane-action-start');
    try {
        const started = await plane.handleProduct({verb: 'startTask', prompt: 'fill the order form'});
        assert.equal(started.type, 'agent.product.result');
        const taskId = started.payload.taskId as string;
        await flush();

        const viaAction = (await plane.handleProduct({verb: 'events', taskId, afterSeq: 0})).payload;
        const viaHttp = await (await fetch(`${plane.baseUrl}/agent/product/tasks/${taskId}/events?afterSeq=0`)).json();
        assert.deepEqual(viaAction, viaHttp, 'Action and HTTP readers see the identical log');
        assertCoherentLog(viaHttp);

        const httpTask = await (await fetch(`${plane.baseUrl}/agent/product/tasks/${taskId}`)).json();
        assert.equal(httpTask.lastSeq, viaHttp.nextSeq);

        const stopped = await post(`${plane.baseUrl}/agent/product/tasks/${taskId}/stop`);
        assert.equal(stopped.status, 200);

        const afterAction = (await plane.handleProduct({verb: 'events', taskId, afterSeq: 0})).payload;
        const afterHttp = await (await fetch(`${plane.baseUrl}/agent/product/tasks/${taskId}/events?afterSeq=0`)).json();
        assert.deepEqual(afterAction, afterHttp);
        assertCoherentLog(afterHttp);
        const kinds = afterHttp.events.map((event: any) => event.kind);
        assert.equal(kinds.filter((kind: string) => kind === 'task_created').length, 1,
            'HTTP stop must not re-emit or reset events seen through the Action plane');
        assert.ok(kinds.includes('interaction_requested'));
        assert.ok(kinds.includes('task_terminated'));
    } finally {
        await plane.stop();
    }
});

test('a task started over HTTP is readable over the agent.product Action with one coherent event log', async () => {
    const plane = await makePlane('product-plane-http-start');
    try {
        const started = await post(`${plane.baseUrl}/agent/product/tasks`, {prompt: 'download the invoice'});
        assert.equal(started.status, 202);
        const taskId = ((await started.json()) as any).taskId as string;
        await flush();

        const viaHttp = await (await fetch(`${plane.baseUrl}/agent/product/tasks/${taskId}/events?afterSeq=0`)).json();
        const viaAction = (await plane.handleProduct({verb: 'events', taskId, afterSeq: 0})).payload;
        assert.deepEqual(viaAction, viaHttp, 'Action and HTTP readers see the identical log');
        assertCoherentLog(viaHttp);

        const viaActionView = (await plane.handleProduct({verb: 'taskView', taskId})).payload;
        const viaHttpView = await (await fetch(`${plane.baseUrl}/agent/product/tasks/${taskId}`)).json();
        assert.deepEqual(viaActionView, viaHttpView);

        const stopped = (await plane.handleProduct({verb: 'stopTask', taskId})).payload;
        assert.equal(stopped.status, 'cancelled');
        const tailHttp = await (await fetch(`${plane.baseUrl}/agent/product/tasks/${taskId}/events?afterSeq=0`)).json();
        const tailAction = (await plane.handleProduct({verb: 'events', taskId, afterSeq: tailHttp.nextSeq - 1})).payload;
        assertCoherentLog(tailHttp);
        assert.equal(tailAction.events.length, 1, 'a cursor from one plane is valid on the other plane');
        assert.equal(tailAction.events[0].kind, 'task_terminated');
        assert.equal(tailAction.nextSeq, tailHttp.nextSeq);
    } finally {
        await plane.stop();
    }
});
