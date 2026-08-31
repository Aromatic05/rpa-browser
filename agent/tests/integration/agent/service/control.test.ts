import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {ActionError} from '../../../../src/interface/actions/results';
import {createAgentControl} from '../../../../src/agent/service/control';
import type {WorkspaceAgentService} from '../../../../src/agent/service/runtime';
import {createSessionManager} from '../../../../src/agent/service/session/manager';
import type {SessionManagerOptions} from '../../../../src/agent/service/session';
import {createProductController} from '../../../../src/agent/product';
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

const createHarness = (
    runner: AgentRunner = {run: async () => runResult},
    sessionOptions: Partial<SessionManagerOptions> = {},
    productDefaults?: Readonly<{provider: string; model: string}>,
) => {
    let status: 'stopped' | 'running' = 'stopped';
    const sessions = createSessionManager({runner, ...sessionOptions});
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
        sessions,
        product: createProductController({
            manager: sessions,
            workspace: 'ws',
            ...(productDefaults === undefined ? {} : {defaults: productDefaults}),
        }),
    };
    const control = createAgentControl(service);
    const workspace = {name: 'ws', agent: control} as any;
    const input = (type: string, payload?: unknown) => ({
        action: action(type, payload),
        workspace,
        workspaceRegistry: {} as any,
    });
    return {control, input, service};
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

const pausedRunResult = (onResume?: () => void): AgentRunResult => ({
    ...runResult,
    programs: [{
        source: 'output s = input.secret',
        input: {secret: 'do-not-leak'},
        status: 'paused',
        pause: {reason: 'barrier', continuationId: 'cont-1', stepName: 'effect.submit', risk: 'irreversible'},
    }],
    continuation: {
        resume: async () => {
            onResume?.();
            return {...runResult, text: 'resumed'};
        },
    },
    control: {
        control: async () => ({...runResult, text: 'controlled'}),
    },
});

const actionErrorCode = (fn: () => Promise<unknown>, code: string): Promise<void> =>
    assert.rejects(fn, (error: unknown) => error instanceof ActionError && error.code === code);

test('agent control lists, gets, and approves a session interaction and resumes the retained run', async () => {
    let resumeCalls = 0;
    const {control, input} = createHarness({run: async () => pausedRunResult(() => {resumeCalls += 1;})});
    await control.handle(input('agent.run', {prompt: 'go', provider: 'p', model: 'm'}));
    const sessions = await control.handle(input('agent.sessions.list'));
    const session = ((sessions.reply.payload as any).sessions as Array<any>)[0];
    assert.equal(session.state, 'paused');
    assert.equal(session.interactions.length, 1);

    const listed = await control.handle(input('agent.interactions.list', {sessionId: session.sessionId}));
    const records = (listed.reply.payload as any).interactions as Array<any>;
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'pending');
    assert.equal(records[0].payload.kind, 'approval');
    assert.equal(JSON.stringify(records[0]).includes('do-not-leak'), false);

    const got = await control.handle(input(
        'agent.interactions.get',
        {sessionId: session.sessionId, interactionId: records[0].id},
    ));
    assert.equal((got.reply.payload as any).id, records[0].id);

    const approved = await control.handle(input(
        'agent.interactions.approve',
        {sessionId: session.sessionId, interactionId: records[0].id, revision: 0, approvedBy: 'ops-1'},
    ));
    const decision = approved.reply.payload as any;
    assert.equal(decision.interaction.status, 'approved');
    assert.equal(decision.session.state, 'completed');
    assert.equal(resumeCalls, 1);
});

test('agent control rejects unknown session, wrong session binding, stale revision, and missing args', async () => {
    let runs = 0;
    const {control, input} = createHarness({run: async () => {
        runs += 1;
        return runs === 1 ? runResult : pausedRunResult();
    }});
    await control.handle(input('agent.run', {prompt: 'first', provider: 'p', model: 'm'}));
    await control.handle(input('agent.run', {prompt: 'second', provider: 'p', model: 'm'}));
    const sessions = await control.handle(input('agent.sessions.list'));
    const listedSessions = (sessions.reply.payload as any).sessions as Array<any>;
    const pausedSession = listedSessions.find((entry) => entry.state === 'paused');
    const listed = await control.handle(input('agent.interactions.list', {sessionId: pausedSession.sessionId}));
    const interaction = ((listed.reply.payload as any).interactions as Array<any>)[0];

    await actionErrorCode(
        () => control.handle(input('agent.interactions.list', {sessionId: 'missing'})),
        'ERR_NOT_FOUND',
    );
    await actionErrorCode(
        () => control.handle(input('agent.interactions.get', {sessionId: 'missing', interactionId: interaction.id})),
        'ERR_NOT_FOUND',
    );
    await actionErrorCode(
        () => control.handle(input(
            'agent.interactions.approve',
            {sessionId: pausedSession.sessionId, interactionId: 'missing', revision: 0, approvedBy: 'ops-1'},
        )),
        'ERR_NOT_FOUND',
    );
    await actionErrorCode(
        () => control.handle(input(
            'agent.interactions.approve',
            {sessionId: pausedSession.sessionId, interactionId: interaction.id, revision: 5, approvedBy: 'ops-1'},
        )),
        'ERR_STALE',
    );
    await actionErrorCode(
        () => control.handle(input('agent.interactions.approve', {sessionId: pausedSession.sessionId, interactionId: interaction.id})),
        'ERR_BAD_ARGS',
    );
    const stillPaused = await control.handle(input('agent.sessions.status', {sessionId: pausedSession.sessionId}));
    assert.equal((stillPaused.reply.payload as any).state, 'paused');
});

test('agent control deny never cancels and returns the denial through the retained control loop', async () => {
    const {control, input} = createHarness({run: async () => pausedRunResult()});
    await control.handle(input('agent.run', {prompt: 'go', provider: 'p', model: 'm'}));
    const sessions = await control.handle(input('agent.sessions.list'));
    const session = ((sessions.reply.payload as any).sessions as Array<any>)[0];
    const listed = await control.handle(input('agent.interactions.list', {sessionId: session.sessionId}));
    const interaction = ((listed.reply.payload as any).interactions as Array<any>)[0];

    const denied = await control.handle(input(
        'agent.interactions.deny',
        {sessionId: session.sessionId, interactionId: interaction.id, revision: 0, deniedBy: 'ops-2', reason: 'not safe'},
    ));
    const decision = denied.reply.payload as any;
    assert.equal(decision.interaction.status, 'denied');
    assert.notEqual(decision.session.state, 'cancelled', 'deny must never cancel the task');
    assert.notEqual(decision.session.error?.code, 'ERR_SESSION_INTERACTION_DENIED');
    await actionErrorCode(
        () => control.handle(input(
            'agent.interactions.deny',
            {sessionId: session.sessionId, interactionId: interaction.id, deniedBy: 'ops-2', reason: 'again'},
        )),
        'ERR_BAD_ARGS',
    );
});

test('agent control operates on the service-owned product controller itself', () => {
    const {control, service} = createHarness();
    assert.equal(control.product, service.product);
});

test('agent.product starts a task from workspace defaults and completes it through the same controller', async () => {
    let resumeCalls = 0;
    const {control, input} = createHarness(
        {run: async () => pausedRunResult(() => {resumeCalls += 1;})},
        {},
        {provider: 'p', model: 'm'},
    );
    const started = await control.handle(input('agent.product', {verb: 'startTask', prompt: 'fill the form'}));
    assert.equal(started.reply.type, 'agent.product.result');
    const taskId = (started.reply.payload as any).taskId;
    assert.equal(typeof taskId, 'string');

    await flush();
    const viewed = await control.handle(input('agent.product', {verb: 'taskView', taskId}));
    const task = viewed.reply.payload as any;
    assert.equal(task.status, 'waiting_for_user');
    assert.equal(task.interaction.kind, 'approval');

    const approved = await control.handle(input(
        'agent.product',
        {verb: 'approve', taskId, interactionToken: task.interaction.interactionToken},
    ));
    assert.equal((approved.reply.payload as any).status, 'completed');
    assert.equal(resumeCalls, 1, 'the product Action plane takes the same retained execution path');
});

test('agent.product failures preserve stale/not-found/conflict/bad-args semantics as Action codes', async () => {
    const {control, input} = createHarness(
        {run: async () => pausedRunResult()},
        {},
        {provider: 'p', model: 'm'},
    );
    const started = await control.handle(input('agent.product', {verb: 'startTask', prompt: 'fill'}));
    const taskId = (started.reply.payload as any).taskId;
    await flush();

    await actionErrorCode(
        () => control.handle(input('agent.product', {verb: 'approve', taskId, interactionToken: 'not-a-token'})),
        'ERR_STALE',
    );
    await actionErrorCode(
        () => control.handle(input('agent.product', {verb: 'taskView', taskId: 'missing'})),
        'ERR_NOT_FOUND',
    );
    await actionErrorCode(
        () => control.handle(input('agent.product', {verb: 'startTask', prompt: 'steal'})),
        'ERR_CONFLICT',
    );
    await actionErrorCode(
        () => control.handle(input('agent.product', {verb: 'startTask', prompt: 'x', provider: 'evil'})),
        'ERR_BAD_ARGS',
    );
    await actionErrorCode(
        () => control.handle(input('agent.product', {verb: 'explode'})),
        'ERR_BAD_ARGS',
    );
    await actionErrorCode(
        () => control.handle(input('agent.product', {verb: 'events', taskId: 'missing', afterSeq: -1})),
        'ERR_BAD_ARGS',
    );
});

test('agent.product startTask without configured workspace defaults fails as bad args', async () => {
    const {control, input} = createHarness({run: async () => runResult});
    await actionErrorCode(
        () => control.handle(input('agent.product', {verb: 'startTask', prompt: 'fill'})),
        'ERR_BAD_ARGS',
    );
});

test('agent.product authoring commands flow through the same reservation surface', async () => {
    const {control, input} = createHarness();
    const began = await control.handle(input('agent.product', {verb: 'beginAuthoring', activity: 'teach', teachKind: 'procedure'}));
    assert.equal((began.reply.payload as any).reservation.owner, 'standalone_teach');
    const ended = await control.handle(input('agent.product', {verb: 'endAuthoring', outcome: 'discarded'}));
    assert.equal((ended.reply.payload as any).reservation.owner, 'none');
});
