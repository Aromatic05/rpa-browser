import test from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultControlEndpoint } from '../../src/control/transport';

const withPlatform = async (platform: NodeJS.Platform, fn: () => void | Promise<void>) => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
        value: platform,
        configurable: true,
    });
    try {
        await fn();
    } finally {
        Object.defineProperty(process, 'platform', {
            value: original,
            configurable: true,
        });
    }
};

test('getDefaultControlEndpoint returns a non-empty string', () => {
    const endpoint = getDefaultControlEndpoint();

    assert.equal(typeof endpoint, 'string');
    assert.ok(endpoint.length > 0);
});

test('getDefaultControlEndpoint returns named pipe path on windows', async () => {
    await withPlatform('win32', () => {
        const endpoint = getDefaultControlEndpoint();
        assert.equal(endpoint.includes('\\\\.\\pipe\\'), true);
    });
});

test('getDefaultControlEndpoint returns .sock path on posix', async () => {
    await withPlatform('linux', () => {
        const endpoint = getDefaultControlEndpoint();
        assert.equal(endpoint.endsWith('.sock'), true);
    });
});
