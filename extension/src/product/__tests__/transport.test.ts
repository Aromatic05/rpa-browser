import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductHttpClient, ProductTransportError } from '../../shared/product_transport.js';
import type { ProductBackendClient, ProductRequest } from '../../shared/product_transport.js';

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type CapturedCall = { url: string; method: string; body: string | undefined };

const captureFetch = (respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) => {
    const calls: CapturedCall[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init && typeof init.body === 'string' ? init.body : undefined });
        return await respond(url, init);
    };
    return { calls, fetcher };
};

test('http client maps product intents to the real /agent/product routes', async () => {
    const { calls, fetcher } = captureFetch((url) => {
        if (url.endsWith('/events')) {
            return json({ events: [], nextSeq: 0, gap: false });
        }
        if (url.includes('/stop') || url.includes('/approve') || url.includes('/deny')
            || url.includes('/answer') || url.includes('/recovery') || url.includes('/takeover')
            || url.includes('/return-control')) {
            return json({ taskId: 'task-1', status: 'running', title: 't', promptSummary: 't' });
        }
        return json({});
    });
    const client = createProductHttpClient({ baseUrl: 'http://127.0.0.1:7432', fetch: fetcher });

    await client.startTask('fill the form');
    await client.workspaceView();
    await client.listTasks();
    await client.taskView('task-1');
    await client.events('task-1', 3);
    await client.stopTask('task-1');
    await client.approve('task-1', 'tok-1');
    await client.deny('task-1', 'tok-1', 'not that');
    await client.answer('task-1', 'tok-1', '42');
    await client.chooseRecovery('task-1', 'tok-1', 'retry');
    await client.beginGuidance('task-1', 'tok-1', 'teach');
    await client.returnControl('task-1', 'tok-1', 'manual');
    await client.beginAuthoring({ activity: 'teach', teachKind: 'procedure' });
    await client.beginAuthoring({ activity: 'annotate' });
    await client.endAuthoring('saved');
    await client.librarySummary();

    const expected: Array<[string, string, string | undefined]> = [
        ['POST', '/agent/product/tasks', '{"prompt":"fill the form"}'],
        ['GET', '/agent/product', undefined],
        ['GET', '/agent/product/tasks', undefined],
        ['GET', '/agent/product/tasks/task-1', undefined],
        ['GET', '/agent/product/tasks/task-1/events?afterSeq=3', undefined],
        ['POST', '/agent/product/tasks/task-1/stop', '{}'],
        ['POST', '/agent/product/tasks/task-1/approve', '{"interactionToken":"tok-1"}'],
        ['POST', '/agent/product/tasks/task-1/deny', '{"interactionToken":"tok-1","reason":"not that"}'],
        ['POST', '/agent/product/tasks/task-1/answer', '{"interactionToken":"tok-1","value":"42"}'],
        ['POST', '/agent/product/tasks/task-1/recovery', '{"interactionToken":"tok-1","optionId":"retry"}'],
        ['POST', '/agent/product/tasks/task-1/takeover', '{"interactionToken":"tok-1","mode":"teach"}'],
        ['POST', '/agent/product/tasks/task-1/return-control', '{"interactionToken":"tok-1","mode":"manual"}'],
        ['POST', '/agent/product/authoring/begin', '{"activity":"teach","teachKind":"procedure"}'],
        ['POST', '/agent/product/authoring/begin', '{"activity":"annotate"}'],
        ['POST', '/agent/product/authoring/end', '{"outcome":"saved"}'],
        ['GET', '/agent/product/library', undefined],
    ];
    assert.equal(calls.length, expected.length, 'one request per product command');
    calls.forEach((call, index) => {
        const [method, route, body] = expected[index];
        assert.equal(call.method, method, `method for ${route}`);
        assert.equal(call.url, `http://127.0.0.1:7432${route}`, `route for ${route}`);
        assert.equal(call.body, body, `body for ${route}`);
    });
});

test('deny carries an optional requestedAlternative without inventing one', async () => {
    const { calls, fetcher } = captureFetch(() => json({ taskId: 't', status: 'running', title: '', promptSummary: '' }));
    const client = createProductHttpClient({ baseUrl: 'http://127.0.0.1:7433', fetch: fetcher });
    await client.deny('t', 'tok', 'reason');
    assert.equal(calls[0].body, '{"interactionToken":"tok","reason":"reason"}');
});

test('http client maps backend error responses to typed transport errors', async () => {
    const cases: Array<[number, Record<string, unknown>, string]> = [
        [409, { code: 'ERR_STALE', error: 'stale' }, 'stale'],
        [409, { code: 'ERR_ACTIVITY_CONFLICT', error: 'busy' }, 'conflict'],
        [401, { code: 'ERR_AUTH', error: 'denied' }, 'auth'],
        [400, { code: 'ERR_BAD_ARGS', error: 'prompt required' }, 'bad_args'],
        [500, { error: 'boom' }, 'http'],
    ];
    for (const [status, body, code] of cases) {
        const { fetcher } = captureFetch(() => json(body, status));
        const client = createProductHttpClient({ baseUrl: 'http://127.0.0.1:7434', fetch: fetcher });
        await assert.rejects(
            client.workspaceView(),
            (error: unknown) => error instanceof ProductTransportError && error.code === code,
        );
    }
});

test('http client classifies a network failure as unreachable', async () => {
    const { fetcher } = captureFetch(() => {
        throw new TypeError('Failed to fetch');
    });
    const client = createProductHttpClient({ baseUrl: 'http://127.0.0.1:7435', fetch: fetcher });
    await assert.rejects(
        client.workspaceView(),
        (error: unknown) => error instanceof ProductTransportError && error.code === 'unreachable',
    );
});

test('http client rejects a non-http base URL', () => {
    assert.throws(
        () => createProductHttpClient({ baseUrl: 'agentservice' }),
        (error: unknown) => error instanceof ProductTransportError && error.code === 'unreachable',
    );
});

test('dispatchProductRequest forwards every product verb to the backend client', async () => {
    const dispatched: string[] = [];
    const client: ProductBackendClient = {
        workspaceView: () => { dispatched.push('workspaceView'); return Promise.resolve({}); },
        listTasks: () => { dispatched.push('listTasks'); return Promise.resolve({ active: [], history: [] }); },
        startTask: () => { dispatched.push('startTask'); return Promise.resolve({}); },
        taskView: () => { dispatched.push('taskView'); return Promise.resolve({}); },
        events: () => { dispatched.push('events'); return Promise.resolve({ events: [], nextSeq: 0, gap: false }); },
        stopTask: () => { dispatched.push('stopTask'); return Promise.resolve({}); },
        approve: () => { dispatched.push('approve'); return Promise.resolve({}); },
        deny: () => { dispatched.push('deny'); return Promise.resolve({}); },
        answer: () => { dispatched.push('answer'); return Promise.resolve({}); },
        chooseRecovery: () => { dispatched.push('recovery'); return Promise.resolve({}); },
        beginGuidance: () => { dispatched.push('takeover'); return Promise.resolve({}); },
        returnControl: () => { dispatched.push('returnControl'); return Promise.resolve({}); },
        beginAuthoring: () => { dispatched.push('beginAuthoring'); return Promise.resolve({}); },
        endAuthoring: () => { dispatched.push('endAuthoring'); return Promise.resolve({}); },
        librarySummary: () => { dispatched.push('librarySummary'); return Promise.resolve({}); },
    };
    const { dispatchProductRequest } = await import('../../shared/product_transport.js');
    const verbs: Array<{ request: ProductRequest; name: string }> = [
        { request: { verb: 'workspaceView' }, name: 'workspaceView' },
        { request: { verb: 'listTasks' }, name: 'listTasks' },
        { request: { verb: 'startTask', prompt: 'p' }, name: 'startTask' },
        { request: { verb: 'taskView', taskId: 't' }, name: 'taskView' },
        { request: { verb: 'events', taskId: 't', afterSeq: 0 }, name: 'events' },
        { request: { verb: 'stopTask', taskId: 't' }, name: 'stopTask' },
        { request: { verb: 'approve', taskId: 't', interactionToken: 'tok' }, name: 'approve' },
        { request: { verb: 'deny', taskId: 't', interactionToken: 'tok', reason: 'r' }, name: 'deny' },
        { request: { verb: 'answer', taskId: 't', interactionToken: 'tok', value: 1 }, name: 'answer' },
        { request: { verb: 'recovery', taskId: 't', interactionToken: 'tok', optionId: 'o' }, name: 'recovery' },
        { request: { verb: 'takeover', taskId: 't', interactionToken: 'tok', mode: 'manual' }, name: 'takeover' },
        { request: { verb: 'returnControl', taskId: 't', interactionToken: 'tok', mode: 'manual' }, name: 'returnControl' },
        { request: { verb: 'beginAuthoring', activity: 'teach', teachKind: 'recovery' }, name: 'beginAuthoring' },
        { request: { verb: 'beginAuthoring', activity: 'annotate' }, name: 'beginAuthoring' },
        { request: { verb: 'endAuthoring', outcome: 'discarded' }, name: 'endAuthoring' },
        { request: { verb: 'librarySummary' }, name: 'librarySummary' },
    ];
    for (const entry of verbs) {
        await dispatchProductRequest(client, entry.request);
    }
    assert.deepEqual(dispatched, verbs.map((entry) => entry.name));
});