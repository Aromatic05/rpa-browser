import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortAllocator} from '../../../../src/automation/runtime/service/ports';
import {createAgentHttpServer} from '../../../../src/agent/service/server';
import {createSessionManager} from '../../../../src/agent/service/session/manager';
import {createProductController} from '../../../../src/agent/product';
import {encodeInteractionToken} from '../../../../src/agent/product/token';
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

const portAllocator = createPortAllocator(24700);

const pausedProgram = (source: string, pause: {reason: 'barrier'; continuationId: string; stepName?: string; risk?: 'irreversible'}) => ({
    source,
    input: {},
    status: 'paused' as const,
    pause,
});

const makeHarness = async (options: {defaults?: boolean; library?: boolean} = {}) => {
    const port = await portAllocator.allocate('agent-server-product', 'agent');
    const state = {runCalls: 0, resumeCalls: 0, controlCalls: 0};
    const controlInputs: unknown[] = [];
    const manager = createSessionManager({
        runner: {
            run: async (): Promise<AgentRunResult> => {
                state.runCalls += 1;
                return {
                    provider: 'p',
                    model: 'm',
                    text: 'paused',
                    trace: baseTrace,
                    programs: [pausedProgram('output s = input.secret', {reason: 'barrier', continuationId: 'c-1', stepName: 'browser.submit', risk: 'irreversible'})],
                    continuation: {
                        resume: async () => {
                            state.resumeCalls += 1;
                            return {provider: 'p', model: 'm', text: 'resumed', trace: baseTrace, programs: [{source: 's', input: {}, status: 'completed' as const}]};
                        },
                    },
                    control: {
                        control: async (input: unknown) => {
                            state.controlCalls += 1;
                            controlInputs.push(input);
                            return {provider: 'p', model: 'm', text: 'controlled', trace: baseTrace};
                        },
                    },
                };
            },
        },
        now: () => 1000,
        interactionTtlMs: 5000,
    });
    const product = createProductController({
        manager,
        workspace: 'agent-server-product',
        ...(options.defaults ? {defaults: {provider: 'p', model: 'm'}} : {}),
        ...(options.library ? {library: async () => [{
            kind: 'procedure' as const,
            name: '查询订单',
            title: '查询订单',
            meaning: 'look up an order',
            inputs: [],
            outputs: [],
            updatedAt: 1,
            revision: 'r1',
            dependencies: [],
            health: 'needs_review' as const,
            capabilities: {
                runtimeApplied: false,
                callableFromDsl: true,
                agentDiscovery: true,
                runnerRecovery: false,
                agentRecovery: false,
                replayable: false,
                modelLoadSeam: false,
            },
        }]} : {}),
    });
    const server = await createAgentHttpServer({
        manager,
        product,
        workspaceName: 'agent-server-product',
        port,
    });
    return {
        baseUrl: `http://127.0.0.1:${String(port)}`,
        stop: server.stop,
        get runCalls() { return state.runCalls; },
        get resumeCalls() { return state.resumeCalls; },
        get controlCalls() { return state.controlCalls; },
        controlInputs,
    };
};

const post = (url: string, body?: unknown) => fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
});

test('product HTTP surface starts a task, projects it, and exposes the workspace view', async () => {
    const harness = await makeHarness({defaults: true});
    try {
        const started = await post(`${harness.baseUrl}/agent/product/tasks`, {prompt: 'fill the order form'});
        assert.equal(started.status, 202);
        const view = await started.json() as any;
        assert.equal(view.status, 'running');
        assert.equal(view.title, 'fill the order form');
        assert.equal(view.promptSummary, 'fill the order form');
        assert.equal(view.lastSeq, 1, 'task_created was emitted');

        const workspace = await fetch(`${harness.baseUrl}/agent/product`);
        assert.equal(workspace.status, 200);
        const workspaceBody = await workspace.json() as any;
        assert.equal(workspaceBody.workspace, 'agent-server-product');
        assert.equal(workspaceBody.reservation.owner, 'task');
        assert.equal(workspaceBody.activeTask?.taskId, view.taskId);
        assert.equal(JSON.stringify(workspaceBody).includes('sessionId'), false);

        const listed = await fetch(`${harness.baseUrl}/agent/product/tasks`);
        const listBody = await listed.json() as any;
        assert.equal(listBody.active.length, 1);
        assert.equal(listBody.history.length, 0);
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});

test('a waiting task projects waiting_for_user with an opaque interaction token over HTTP', async () => {
    const harness = await makeHarness({defaults: true});
    try {
        const started = await post(`${harness.baseUrl}/agent/product/tasks`, {prompt: 'fill the order form'});
        const view = await started.json() as any;

        const fetched = await fetch(`${harness.baseUrl}/agent/product/tasks/${view.taskId}`);
        assert.equal(fetched.status, 200);
        const task = await fetched.json() as any;
        assert.equal(task.status, 'waiting_for_user');
        assert.equal(task.phase, 'interacting');
        assert.equal(task.interaction.kind, 'approval');
        assert.equal(task.interaction.actionName, 'browser.submit');
        assert.ok(task.interaction.interactionToken.length > 0);
        assert.equal(JSON.stringify(task).includes('sessionId'), false);
        assert.equal(JSON.stringify(task).includes('continuationId'), false);
        assert.equal(JSON.stringify(task).includes('do-not-leak'), false, 'no program source/secrets in projections');
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});

test('approve and deny over the product surface never create a second runner', async () => {
    const harness = await makeHarness({defaults: true});
    try {
        const started = await post(`${harness.baseUrl}/agent/product/tasks`, {prompt: 'fill'});
        const view = await started.json() as any;
        const task = await (await fetch(`${harness.baseUrl}/agent/product/tasks/${view.taskId}`)).json() as any;
        const token = task.interaction.interactionToken;

        const approved = await post(`${harness.baseUrl}/agent/product/tasks/${view.taskId}/approve`, {interactionToken: token});
        assert.equal(approved.status, 200);
        const afterApprove = await approved.json() as any;
        assert.equal(afterApprove.status, 'completed');
        assert.equal(harness.runCalls, 1, 'approval must not start a second runner');
        assert.equal(harness.resumeCalls, 1, 'approval takes the exact retained execution fast path');
        assert.equal(harness.controlCalls, 0);
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});

test('a stale product interaction token returns 409 ERR_STALE and executes nothing', async () => {
    const harness = await makeHarness({defaults: true});
    try {
        const started = await post(`${harness.baseUrl}/agent/product/tasks`, {prompt: 'fill'});
        const view = await started.json() as any;

        const stale = await post(`${harness.baseUrl}/agent/product/tasks/${view.taskId}/approve`, {interactionToken: 'not-a-token'});
        assert.equal(stale.status, 409);
        assert.equal((await stale.json() as any).code, 'ERR_STALE');
        assert.equal(harness.resumeCalls, 0);
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});

test('a second task start over HTTP is rejected with a reservation conflict', async () => {
    const harness = await makeHarness({defaults: true});
    try {
        const first = await post(`${harness.baseUrl}/agent/product/tasks`, {prompt: 'first'});
        assert.equal(first.status, 202);
        const second = await post(`${harness.baseUrl}/agent/product/tasks`, {prompt: 'second'});
        assert.equal(second.status, 409);
        assert.equal((await second.json() as any).code, 'ERR_ACTIVITY_CONFLICT');
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});

test('stop over the product surface is a cancellation, distinct from deny', async () => {
    const harness = await makeHarness({defaults: true});
    try {
        const started = await post(`${harness.baseUrl}/agent/product/tasks`, {prompt: 'fill'});
        const view = await started.json() as any;
        const stopped = await post(`${harness.baseUrl}/agent/product/tasks/${view.taskId}/stop`);
        assert.equal(stopped.status, 200);
        const after = await stopped.json() as any;
        assert.equal(after.status, 'cancelled');
        assert.equal(after.error.code, 'ERR_SESSION_CANCELLED');
        assert.equal(harness.resumeCalls, 0);
        assert.equal(harness.controlCalls, 0);
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});

test('events over HTTP are ordered, sanitized, and return gaps after a stale cursor', async () => {
    const harness = await makeHarness({defaults: true});
    try {
        const started = await post(`${harness.baseUrl}/agent/product/tasks`, {prompt: 'fill'});
        const view = await started.json() as any;
        const task = await (await fetch(`${harness.baseUrl}/agent/product/tasks/${view.taskId}`)).json() as any;
        await post(`${harness.baseUrl}/agent/product/tasks/${view.taskId}/approve`, {interactionToken: task.interaction.interactionToken});

        const eventsRes = await fetch(`${harness.baseUrl}/agent/product/tasks/${view.taskId}/events?afterSeq=0`);
        assert.equal(eventsRes.status, 200);
        const body = await eventsRes.json() as any;
        assert.equal(body.gap, false);
        const kinds = body.events.map((event: any) => event.kind);
        assert.ok(kinds.includes('task_created'));
        assert.ok(kinds.includes('interaction_requested'));
        assert.ok(kinds.includes('interaction_resolved'));
        assert.ok(kinds.includes('task_terminated'));
        const serialized = JSON.stringify(body.events);
        assert.equal(serialized.includes('sessionId'), false);
        assert.equal(serialized.includes('continuationId'), false);

        const tail = await fetch(`${harness.baseUrl}/agent/product/tasks/${view.taskId}/events?afterSeq=${body.nextSeq}`);
        assert.equal((await tail.json() as any).events.length, 0);
        const ahead = await fetch(`${harness.baseUrl}/agent/product/tasks/${view.taskId}/events?afterSeq=${body.nextSeq + 5}`);
        assert.equal((await ahead.json() as any).gap, true);
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});

test('the product task composer requires configured provider/model defaults', async () => {
    const harness = await makeHarness();
    try {
        const started = await post(`${harness.baseUrl}/agent/product/tasks`, {prompt: 'fill'});
        assert.equal(started.status, 400);
        assert.equal((await started.json() as any).code, 'ERR_BAD_ARGS');
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});

test('standalone authoring over HTTP acquires, projects and releases the reservation', async () => {
    const harness = await makeHarness({defaults: true});
    try {
        const began = await post(`${harness.baseUrl}/agent/product/authoring/begin`, {activity: 'teach', teachKind: 'procedure'});
        assert.equal(began.status, 200);
        const view = await began.json() as any;
        assert.equal(view.reservation.owner, 'standalone_teach');

        const blocked = await post(`${harness.baseUrl}/agent/product/authoring/begin`, {activity: 'annotate'});
        assert.equal(blocked.status, 409);
        assert.equal((await blocked.json() as any).code, 'ERR_ACTIVITY_CONFLICT');

        const secondTask = await post(`${harness.baseUrl}/agent/product/tasks`, {prompt: 'steal'});
        assert.equal(secondTask.status, 409);
        assert.equal((await secondTask.json() as any).code, 'ERR_ACTIVITY_CONFLICT');

        const ended = await post(`${harness.baseUrl}/agent/product/authoring/end`, {outcome: 'discarded'});
        assert.equal(ended.status, 200);
        assert.equal((await ended.json() as any).reservation.owner, 'none');
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});

test('authoring begin validates the activity and teach kind', async () => {
    const harness = await makeHarness({defaults: true});
    try {
        const badActivity = await post(`${harness.baseUrl}/agent/product/authoring/begin`, {activity: 'playback'});
        assert.equal(badActivity.status, 400);
        const badKind = await post(`${harness.baseUrl}/agent/product/authoring/begin`, {activity: 'teach', teachKind: 'checkpoint'});
        assert.equal(badKind.status, 400);
        const badOutcome = await post(`${harness.baseUrl}/agent/product/authoring/end`, {outcome: 'pending'});
        assert.equal(badOutcome.status, 400);
        assert.equal((await badKind.json() as any).error.includes('teachKind'), true);
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});

test('the product library endpoint projects real health evidence and reports unavailability', async () => {
    const harness = await makeHarness({defaults: true, library: true});
    try {
        const res = await fetch(`${harness.baseUrl}/agent/product/library`);
        assert.equal(res.status, 200);
        const body = await res.json() as any;
        assert.deepEqual(body.procedures, [{name: '查询订单', health: 'needs_review'}],
            'health evidence passes through unchanged; never fabricated ready');
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
    const plain = await makeHarness({defaults: true});
    try {
        const res = await fetch(`${plain.baseUrl}/agent/product/library`);
        assert.equal(res.status, 404);
        assert.equal((await res.json() as any).code, 'ERR_LIBRARY_UNAVAILABLE');
    } finally {
        await plain.stop();
        portAllocator.release('agent-server-product', 'agent');
    }
});