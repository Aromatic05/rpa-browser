import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ControlProtocolError,
    encodeControlEvalResponse,
    parseControlEvalRequest,
} from '../../src/control/protocol';

test('parseControlEvalRequest parses a valid request', () => {
    const req = parseControlEvalRequest('{"id":"1","source":"return 1 + 1","workspaceName":"ws","timeoutMs":1200,"input":{"a":1}}');

    assert.deepEqual(req, {
        id: '1',
        source: 'return 1 + 1',
        workspaceName: 'ws',
        timeoutMs: 1200,
        input: { a: 1 },
    });
});

test('parseControlEvalRequest rejects bad json', () => {
    assert.throws(
        () => parseControlEvalRequest('{'),
        (error: unknown) =>
            error instanceof ControlProtocolError && error.code === 'ERR_CONTROL_BAD_JSON',
    );
});

test('parseControlEvalRequest rejects missing id or source', () => {
    assert.throws(
        () => parseControlEvalRequest('{"source":"return 1"}'),
        (error: unknown) =>
            error instanceof ControlProtocolError && error.code === 'ERR_CONTROL_BAD_REQUEST',
    );

    assert.throws(
        () => parseControlEvalRequest('{"id":"1"}'),
        (error: unknown) =>
            error instanceof ControlProtocolError &&
            error.code === 'ERR_CONTROL_BAD_REQUEST' &&
            error.requestId === '1',
    );
});

test('encodeControlEvalResponse returns a json string without newline', () => {
    const encoded = encodeControlEvalResponse({
        id: '1',
        ok: true,
        result: { pong: true },
        logs: [],
    });

    assert.equal(encoded.includes('\n'), false);
    assert.deepEqual(JSON.parse(encoded), {
        id: '1',
        ok: true,
        result: { pong: true },
        logs: [],
    });
});
