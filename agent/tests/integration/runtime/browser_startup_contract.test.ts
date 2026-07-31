import assert from 'node:assert/strict';
import {hostname} from 'node:os';
import {mkdtemp, rm, symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import net from 'node:net';

import {startActionWsClient} from '../../../src/actions/ws_client';
import {readBrowserProfileOwner} from '../../../src/runtime/browser/cdp_launcher';
import {
    buildStartExtensionUrl,
    resolveInteractiveStartUrl,
} from '../../../src/runtime/browser/browser_session';

const reservePort = async (): Promise<number> => await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
            server.close();
            reject(new Error('ephemeral port unavailable'));
            return;
        }
        const port = address.port;
        server.close((error) => error ? reject(error) : resolve(port));
    });
});

test('workspace browser starts through the dedicated start extension', async () => {
    const port = await reservePort();
    const server = startActionWsClient({
        port,
        workspaceRegistry: {
            getActiveWorkspace: () => null,
            listWorkspaces: () => [],
        } as never,
        dispatchAction: async (action) => action,
        onError: (error) => {throw error;},
    });
    try {
        await server.waitForListening();
        const response = await fetch(`http://127.0.0.1:${String(port)}/rpa-start`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /text\/html/);
        assert.match(await response.text(), /data-rpa-start-page/);
        assert.equal(
            buildStartExtensionUrl('workspace-a', port),
            `chrome://newtab/?rpaWorkspaceName=workspace-a&rpaWsPort=${String(port)}`,
        );
        assert.equal(
            resolveInteractiveStartUrl('workspace-a', port),
            `chrome://newtab/?rpaWorkspaceName=workspace-a&rpaWsPort=${String(port)}`,
        );
    } finally {
        await server.close();
    }
});

test('CDP profile owner reports the live Chromium singleton pid', {
    skip: process.platform === 'win32',
}, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rpa-cdp-profile-'));
    try {
        await symlink(`${hostname()}-${String(process.pid)}`, path.join(directory, 'SingletonLock'));
        assert.deepEqual(readBrowserProfileOwner(directory), {
            pid: process.pid,
            alive: true,
            lockTarget: `${hostname()}-${String(process.pid)}`,
        });
    } finally {
        await rm(directory, {recursive: true, force: true});
    }
});

test('workspace action server force-closes an unresponsive websocket client', async () => {
    const port = await reservePort();
    const server = startActionWsClient({
        port,
        workspaceRegistry: {
            getActiveWorkspace: () => null,
            listWorkspaces: () => [],
        } as never,
        dispatchAction: async (action) => action,
        onError: (error) => {throw error;},
    });
    const socket = new net.Socket();
    try {
        await server.waitForListening();
        await new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            socket.connect(port, '127.0.0.1', resolve);
        });
        socket.write([
            'GET / HTTP/1.1',
            `Host: 127.0.0.1:${String(port)}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            '',
            '',
        ].join('\r\n'));
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('websocket upgrade timeout')), 1000);
            socket.once('data', () => {
                clearTimeout(timer);
                resolve();
            });
        });

        const startedAt = Date.now();
        const closed = server.close();
        const result = await Promise.race([
            closed.then(() => 'closed' as const),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
        ]);
        assert.equal(result, 'closed');
        assert.ok(Date.now() - startedAt < 500);
    } finally {
        socket.destroy();
        await server.close().catch(() => undefined);
    }
});
