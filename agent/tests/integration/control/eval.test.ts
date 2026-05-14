import test from 'node:test';
import assert from 'node:assert/strict';
import type { Action } from '../../src/actions/action_protocol';
import { runControlEval } from '../../src/control/eval';
import { parseControlEvalCli } from '../../src/control_cli';

const createContext = () => ({
    deps: {} as any,
    workspaceRegistry: {
        getWorkspace: (name: string) => ({ name }),
    } as any,
    config: {} as any,
    dispatch: async (action: Action) => action,
    resolveWorkspace: (workspaceName: string) => ({ name: workspaceName }),
    checkpointProvider: () => undefined,
});

test('returns ERR_CONTROL_EVAL_DISABLED when gate is off', async () => {
    const prev = process.env.RPA_CONTROL_EVAL;
    delete process.env.RPA_CONTROL_EVAL;
    try {
        const response = await runControlEval({ id: '1', source: 'return 1' }, createContext());
        assert.equal(response.ok, false);
        if (response.ok) {
            assert.fail('expected failed response');
        }
        assert.equal(response.error?.code, 'ERR_CONTROL_EVAL_DISABLED');
    } finally {
        if (typeof prev === 'string') {
            process.env.RPA_CONTROL_EVAL = prev;
        } else {
            delete process.env.RPA_CONTROL_EVAL;
        }
    }
});

test('executes simple expression when gate is on', async () => {
    const prev = process.env.RPA_CONTROL_EVAL;
    process.env.RPA_CONTROL_EVAL = '1';
    try {
        const response = await runControlEval({ id: '2', source: 'return 1 + 2' }, createContext());
        assert.equal(response.ok, true);
        assert.equal(response.result, 3);
    } finally {
        if (typeof prev === 'string') {
            process.env.RPA_CONTROL_EVAL = prev;
        } else {
            delete process.env.RPA_CONTROL_EVAL;
        }
    }
});

test('ctx.log writes into logs', async () => {
    const prev = process.env.RPA_CONTROL_EVAL;
    process.env.RPA_CONTROL_EVAL = '1';
    try {
        const response = await runControlEval({ id: '3', source: 'ctx.log("hello", { a: 1 }); return null;' }, createContext());
        assert.equal(response.ok, true);
        assert.equal(response.logs.length > 0, true);
        assert.equal(response.logs[0]?.includes('hello'), true);
    } finally {
        if (typeof prev === 'string') {
            process.env.RPA_CONTROL_EVAL = prev;
        } else {
            delete process.env.RPA_CONTROL_EVAL;
        }
    }
});

test('supports async source await', async () => {
    const prev = process.env.RPA_CONTROL_EVAL;
    process.env.RPA_CONTROL_EVAL = '1';
    try {
        const response = await runControlEval({ id: '4', source: 'await ctx.sleep(1); return "ok";' }, createContext());
        assert.equal(response.ok, true);
        assert.equal(response.result, 'ok');
    } finally {
        if (typeof prev === 'string') {
            process.env.RPA_CONTROL_EVAL = prev;
        } else {
            delete process.env.RPA_CONTROL_EVAL;
        }
    }
});

test('wraps thrown error with name/message/stack', async () => {
    const prev = process.env.RPA_CONTROL_EVAL;
    process.env.RPA_CONTROL_EVAL = '1';
    try {
        const response = await runControlEval({ id: '5', source: 'throw new TypeError("boom")' }, createContext());
        assert.equal(response.ok, false);
        if (response.ok) {
            assert.fail('expected failed response');
        }
        assert.equal(response.error?.name, 'TypeError');
        assert.equal(response.error?.message, 'boom');
        assert.equal(typeof response.error?.stack, 'string');
    } finally {
        if (typeof prev === 'string') {
            process.env.RPA_CONTROL_EVAL = prev;
        } else {
            delete process.env.RPA_CONTROL_EVAL;
        }
    }
});

test('cli core path builds eval request', async () => {
    const parsed = await parseControlEvalCli([
        '--source',
        'return input.x',
        '--workspace',
        'ws-1',
        '--input',
        '{"x":7}',
        '--endpoint',
        '/tmp/control.sock',
        '--timeout-ms',
        '1500',
    ]);

    assert.equal(parsed.help, false);
    if (parsed.help) {
        assert.fail('unexpected help');
    }
    assert.deepEqual(parsed.request, {
        source: 'return input.x',
        workspaceName: 'ws-1',
        input: { x: 7 },
        timeoutMs: 1500,
    });
    assert.deepEqual(parsed.options, {
        endpoint: '/tmp/control.sock',
        timeoutMs: 1500,
    });
});
