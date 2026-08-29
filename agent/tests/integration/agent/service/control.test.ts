import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createAgentControl} from '../../../../src/agent/service/control';
import type {WorkspaceAgentService} from '../../../../src/agent/service/runtime';
import {createSessionManager} from '../../../../src/agent/service/session/manager';
import type {AgentRunner, AgentRunResult} from '../../../../src/agent/execution/types';

const runResult: AgentRunResult = {
    provider: 'p',
    model: 'm',
    text: 'done',
    trace: {
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
    },
};

const action = (type: string, payload: unknown = {}) => ({
    v: 1 as const,
    id: crypto.randomUUID(),
    type,
    workspaceName: 'ws',
    payload,
});

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const createHarness = (runner: AgentRunner = {run: async () => runResult}) => {
    let status: 'stopped' | 'running' = 'stopped';
    const service: WorkspaceAgentService = {
        name: 'agent',
        workspaceName: 'ws',
        start: async () => {
            status = 'running';
            return {serviceName: 'agent', workspaceName: 'ws', port: 12345, status};
        },
        stop: async () => {
            status = 'stopped';
            return {serviceName: 'agent', workspaceName: 'ws', status};
        },
        status: () => ({
            serviceName: 'agent', workspaceName: 'ws', port: status === 'running' ? 12345 : null, status,
        }),
        run: (request) => service.sessions.run(request),
        sessions: createSessionManager({runner}),
    };
    const control = createAgentControl(service);
    const workspace = {name: 'ws', agent: control} as any;
    const input = (type: string, payload?: unknown) => ({
        action: action(type, payload),
        workspace,
        workspaceRegistry: {} as any,
    });
    return {control, input};
};

test('agent control delegates service lifecycle', async () => {
    const {control, input} = createHarness();
    const started = await control.handle(input('agent.start'));
    assert.equal((started.reply.payload as any).serviceName, 'agent');
    assert.equal((started.reply.payload as any).status, 'running');
    const status = await control.handle(input('agent.status'));
    assert.equal((status.reply.payload as any).port, 12345);
    const stopped = await control.handle(input('agent.stop'));
    assert.equal((stopped.reply.payload as any).status, 'stopped');
});

test('agent control validates and delegates run requests', async () => {
    const {control, input} = createHarness();
    const response = await control.handle(input('agent.run', {prompt: 'go', provider: 'p', model: 'm'}));
    assert.deepEqual(response.reply.payload, runResult);
    await assert.rejects(
        () => control.handle(input('agent.run', {provider: 'p', model: 'm'})),
        /prompt is required/,
    );
});

test('agent control starts, lists, and reads a session by stable id', async () => {
    const pending = deferred<AgentRunResult>();
    const {control, input} = createHarness({run: () => pending.promise});

    const started = await control.handle(input('agent.sessions.start', {prompt: 'go', provider: 'p', model: 'm'}));
    const startedPayload = started.reply.payload as any;
    assert.equal(started.reply.type, 'agent.sessions.start.result');
    assert.equal(startedPayload.state, 'running');
    assert.equal(typeof startedPayload.sessionId, 'string');

    const listed = await control.handle(input('agent.sessions.list'));
    const listPayload = listed.reply.payload as any;
    assert.equal(listPayload.sessions.length, 1);
    assert.equal(listPayload.sessions[0].sessionId, startedPayload.sessionId);

    pending.resolve(runResult);
    await flush();

    const status = await control.handle(input('agent.sessions.status', {sessionId: startedPayload.sessionId}));
    assert.equal((status.reply.payload as any).state, 'completed');
});

test('agent control cancels a running session by id', async () => {
    const pending = deferred<AgentRunResult>();
    const {control, input} = createHarness({run: () => pending.promise});

    const started = await control.handle(input('agent.sessions.start', {prompt: 'go', provider: 'p', model: 'm'}));
    const sessionId = (started.reply.payload as any).sessionId;

    const cancelled = await control.handle(input('agent.sessions.cancel', {sessionId}));
    assert.equal((cancelled.reply.payload as any).state, 'cancelled');
    await flush();
    const status = await control.handle(input('agent.sessions.status', {sessionId}));
    assert.equal((status.reply.payload as any).state, 'cancelled');
});

test('agent control rejects unknown session status and cancel', async () => {
    const {control, input} = createHarness();
    await assert.rejects(
        () => control.handle(input('agent.sessions.status', {sessionId: 'missing'})),
        /session not found/,
    );
    await assert.rejects(
        () => control.handle(input('agent.sessions.cancel', {sessionId: 'missing'})),
        /session not found/,
    );
});

test('agent control returns a persisted session report after completion', async () => {
    const {control, input} = createHarness();
    const run = await control.handle(input('agent.run', {prompt: 'go', provider: 'p', model: 'm'}));
    const sessions = await control.handle(input('agent.sessions.list'));
    const sessionId = ((sessions.reply.payload as any).sessions as Array<{sessionId: string}>)[0].sessionId;

    const report = await control.handle(input('agent.sessions.report', {sessionId}));
    const payload = report.reply.payload as any;
    assert.equal(payload.sessionId, sessionId);
    assert.equal(payload.report.run.provider, 'p');
    assert.equal(payload.report.terminal.status, 'completed');
});

test('agent control rejects a report for an unknown session', async () => {
    const {control, input} = createHarness();
    await assert.rejects(
        () => control.handle(input('agent.sessions.report', {sessionId: 'missing'})),
        /session report not found/,
    );
});

test('agent control prunes sessions by retention policy', async () => {
    const {control, input} = createHarness();
    for (let index = 0; index < 3; index++) {
        await control.handle(input('agent.run', {prompt: `go-${index}`, provider: 'p', model: 'm'}));
    }
    const before = await control.handle(input('agent.sessions.list'));
    assert.equal(((before.reply.payload as any).sessions as unknown[]).length, 3);

    const pruned = await control.handle(input('agent.sessions.prune', {maxCount: 1}));
    assert.equal((pruned.reply.payload as any).pruned, 2);

    const after = await control.handle(input('agent.sessions.list'));
    assert.equal(((after.reply.payload as any).sessions as unknown[]).length, 1);
});
