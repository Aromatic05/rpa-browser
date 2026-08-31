import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortAllocator} from '../../../../src/automation/runtime/service/ports';
import {createWorkspaceAgentService} from '../../../../src/agent/service/runtime';
import type {AgentRunRequest, AgentRunResult, AgentRunner} from '../../../../src/agent/execution/types';
import {createBearerAuthenticator, type BearerAuthenticator} from '../../../../src/security/auth';
import {createRedactionPolicy} from '../../../../src/security/redaction';
import {makeResult} from './session/helpers';

const VALID_TOKEN = 'valid-service-token';
const LIMITED_TOKEN = 'read-only-service-token';
const WRONG_TOKEN = 'wrong-service-token';

const VERIFY = async (token: string) => {
    if (token === VALID_TOKEN) {
        return {id: 'svc-agent', kind: 'service' as const, scopes: ['agent.run']};
    }
    if (token === LIMITED_TOKEN) {
        return {id: 'svc-reader', kind: 'service' as const, scopes: ['browser.read']};
    }
    return null;
};

const authenticator: BearerAuthenticator = createBearerAuthenticator({verify: VERIFY});

const countingRunner = (): {runner: AgentRunner; calls: () => number} => {
    let calls = 0;
    return {
        runner: {run: async (): Promise<AgentRunResult> => {
            calls += 1;
            return makeResult();
        }},
        calls: () => calls,
    };
};

test('agent run endpoint rejects missing or invalid bearer before reaching the runner', async () => {
    const counter = countingRunner();
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-auth-run',
        portAllocator: createPortAllocator(24000),
        runner: counter.runner,
        security: {authenticator, redactionPolicy: createRedactionPolicy()},
    });
    const started = await service.start();
    try {
        const base = `http://127.0.0.1:${String(started.port)}/agent`;
        const requestBody = {prompt: 'hello', provider: 'test', model: 'model'};

        const missing = await fetch(base, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(requestBody),
        });
        assert.equal(missing.status, 401);
        assert.deepEqual(await missing.json(), {
            error: 'authentication required',
            code: 'ERR_AGENT_AUTH_REQUIRED',
        });

        const bad = await fetch(base, {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: `Bearer ${WRONG_TOKEN}`},
            body: JSON.stringify(requestBody),
        });
        assert.equal(bad.status, 401);
        assert.deepEqual(await bad.json(), {
            error: 'authentication required',
            code: 'ERR_AGENT_AUTH_REQUIRED',
        });

        assert.equal(counter.calls(), 0, 'runner must never be reached for unauthenticated requests');
    } finally {
        await service.stop();
    }
});

test('session and report endpoints are protected before the session manager', async () => {
    const counter = countingRunner();
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-auth-sessions',
        portAllocator: createPortAllocator(24100),
        runner: counter.runner,
        security: {authenticator, redactionPolicy: createRedactionPolicy()},
    });
    const started = await service.start();
    try {
        const base = `http://127.0.0.1:${String(started.port)}/agent/sessions`;
        const cases: ReadonlyArray<{path: string; init: RequestInit}> = [
            {path: base, init: {method: 'GET'}},
            {
                path: base,
                init: {
                    method: 'POST',
                    headers: {'content-type': 'application/json'},
                    body: JSON.stringify({prompt: 'hello', provider: 'test', model: 'model'}),
                },
            },
            {path: `${base}/missing/report`, init: {method: 'GET'}},
            {path: `${base}/missing`, init: {method: 'GET'}},
            {path: `${base}/missing/cancel`, init: {method: 'POST'}},
            {path: `${base}/prune`, init: {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}},
        ];
        for (const {path, init} of cases) {
            const response = await fetch(path, init);
            assert.equal(response.status, 401, `expected 401 for ${String(init.method)} ${path}`);
            const body = await response.json() as {code: string};
            assert.equal(body.code, 'ERR_AGENT_AUTH_REQUIRED');
        }
        assert.equal(counter.calls(), 0, 'no session run must reach the runner');
    } finally {
        await service.stop();
    }
});

test('authenticated principal without the required capability is blocked with 403', async () => {
    const counter = countingRunner();
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-auth-capability',
        portAllocator: createPortAllocator(24200),
        runner: counter.runner,
        security: {authenticator, redactionPolicy: createRedactionPolicy()},
    });
    const started = await service.start();
    try {
        const response = await fetch(`http://127.0.0.1:${String(started.port)}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: `Bearer ${LIMITED_TOKEN}`},
            body: JSON.stringify({prompt: 'hello', provider: 'test', model: 'model'}),
        });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), {
            error: 'forbidden',
            code: 'ERR_AGENT_FORBIDDEN',
        });
        assert.equal(counter.calls(), 0, 'runner must not run when the capability is missing');
    } finally {
        await service.stop();
    }
});

test('authorized principal is admitted and the run succeeds', async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
        run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
            calls.push(request.prompt);
            return makeResult({text: `done: ${request.prompt}`});
        },
    };
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-auth-ok',
        portAllocator: createPortAllocator(24300),
        runner,
        security: {authenticator, redactionPolicy: createRedactionPolicy()},
    });
    const started = await service.start();
    try {
        const base = `http://127.0.0.1:${String(started.port)}`;
        const response = await fetch(`${base}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: `Bearer ${VALID_TOKEN}`},
            body: JSON.stringify({prompt: 'hello', provider: 'test', model: 'model'}),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(calls, ['hello']);

        const sessionId = response.headers.get('x-session-id');
        assert.ok(sessionId);
        const status = await fetch(`${base}/agent/sessions/${sessionId}`, {
            headers: {authorization: `Bearer ${VALID_TOKEN}`},
        });
        assert.equal(status.status, 200);
        assert.equal(((await status.json()) as {state: string}).state, 'completed');

        const health = await fetch(`${base}/health`);
        assert.equal(health.status, 200, 'health must stay unsecured in secured mode');
    } finally {
        await service.stop();
    }
});

test('auth failures and sanitized handler errors never leak secrets or tokens', async () => {
    const SECRET = 'super-secret-db-password';
    const runner: AgentRunner = {
        run: async (): Promise<AgentRunResult> => {
            throw new Error(`connection failed (secret=${SECRET})`);
        },
    };
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-auth-leak',
        portAllocator: createPortAllocator(24400),
        runner,
        security: {
            authenticator,
            redactionPolicy: createRedactionPolicy({secrets: [SECRET]}),
        },
    });
    const started = await service.start();
    try {
        const base = `http://127.0.0.1:${String(started.port)}/agent`;
        const body = JSON.stringify({prompt: 'hello', provider: 'test', model: 'model'});

        const failedRun = await fetch(base, {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: `Bearer ${VALID_TOKEN}`},
            body,
        });
        assert.equal(failedRun.status, 500);
        const failedText = await failedRun.text();
        assert.ok(!failedText.includes(SECRET), 'registered secret must be redacted from the 500 error');
        assert.ok(failedText.includes('[redacted]'));

        const rejected = await fetch(base, {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: `Bearer ${WRONG_TOKEN}`},
            body,
        });
        assert.equal(rejected.status, 401);
        const rejectedText = await rejected.text();
        assert.ok(!rejectedText.includes(WRONG_TOKEN), '401 body must not echo the bearer token');
        assert.ok(!rejectedText.includes(VALID_TOKEN));
    } finally {
        await service.stop();
    }
});

test('legacy unsecured mode still serves requests without credentials', async () => {
    const counter = countingRunner();
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-auth-legacy',
        portAllocator: createPortAllocator(24500),
        runner: counter.runner,
    });
    const started = await service.start();
    try {
        const response = await fetch(`http://127.0.0.1:${String(started.port)}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({prompt: 'hello', provider: 'test', model: 'model'}),
        });
        assert.equal(response.status, 200);
        assert.equal(counter.calls(), 1, 'the runner must run in unsecured mode');
    } finally {
        await service.stop();
    }
});