import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ControlProtocolError,
    encodeControlResponse,
    parseControlRequest,
} from '../../src/control/protocol';

test('parseControlRequest parses a valid request', () => {
    const req = parseControlRequest('{"id":"1","method":"agent.ping","params":{}}');

    assert.deepEqual(req, {
        id: '1',
        method: 'agent.ping',
        params: {},
    });
});

test('parseControlRequest rejects bad json', () => {
    assert.throws(
        () => parseControlRequest('{'),
        (error: unknown) =>
            error instanceof ControlProtocolError && error.code === 'ERR_CONTROL_BAD_JSON',
    );
});

test('parseControlRequest rejects missing id or method', () => {
    assert.throws(
        () => parseControlRequest('{"method":"agent.ping"}'),
        (error: unknown) =>
            error instanceof ControlProtocolError && error.code === 'ERR_CONTROL_BAD_REQUEST',
    );

    assert.throws(
        () => parseControlRequest('{"id":"1"}'),
        (error: unknown) =>
            error instanceof ControlProtocolError &&
            error.code === 'ERR_CONTROL_BAD_REQUEST' &&
            error.requestId === '1',
    );
});

test('encodeControlResponse returns a json string without newline', () => {
    const encoded = encodeControlResponse({
        id: '1',
        ok: true,
        result: { pong: true },
    });

    assert.equal(encoded.includes('\n'), false);
    assert.deepEqual(JSON.parse(encoded), {
        id: '1',
        ok: true,
        result: { pong: true },
    });
});
