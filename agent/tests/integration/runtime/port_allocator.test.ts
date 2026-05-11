import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortAllocator } from '../../src/runtime/service/ports';

test('allocates a port for workspaceName + serviceName', async () => {
    const allocator = createPortAllocator(19000);
    const port = await allocator.allocate('test-ws', 'mcp');
    assert.ok(typeof port === 'number');
    assert.ok(port >= 19000);
    allocator.release('test-ws', 'mcp');
});

test('returns same port for repeated allocate of same workspace + service', async () => {
    const allocator = createPortAllocator(19000);
    const port1 = await allocator.allocate('test-ws', 'mcp');
    const port2 = await allocator.allocate('test-ws', 'mcp');
    assert.equal(port1, port2);
    allocator.release('test-ws', 'mcp');
});

test('allocates different ports for different services', async () => {
    const allocator = createPortAllocator(19000);
    const portA = await allocator.allocate('test-ws', 'mcp');
    const portB = await allocator.allocate('test-ws', 'other');
    assert.notEqual(portA, portB);
    allocator.release('test-ws', 'mcp');
    allocator.release('test-ws', 'other');
});

test('allocates different ports for different workspaces with same service', async () => {
    const allocator = createPortAllocator(19000);
    const portA = await allocator.allocate('ws-a', 'mcp');
    const portB = await allocator.allocate('ws-b', 'mcp');
    assert.notEqual(portA, portB);
    allocator.release('ws-a', 'mcp');
    allocator.release('ws-b', 'mcp');
});

test('getPort returns null for unallocated service', () => {
    const allocator = createPortAllocator(19000);
    assert.equal(allocator.getPort('unknown', 'mcp'), null);
});

test('getPort returns allocated port', async () => {
    const allocator = createPortAllocator(19000);
    const port = await allocator.allocate('test-ws', 'mcp');
    assert.equal(allocator.getPort('test-ws', 'mcp'), port);
    allocator.release('test-ws', 'mcp');
});

test('release frees the port so next allocate may reuse it', async () => {
    const allocator = createPortAllocator(19000);
    const port1 = await allocator.allocate('test-ws', 'mcp');
    allocator.release('test-ws', 'mcp');
    const port2 = await allocator.allocate('test-ws', 'mcp');
    assert.ok(typeof port2 === 'number');
    allocator.release('test-ws', 'mcp');
});

test('getPort returns null after release', async () => {
    const allocator = createPortAllocator(19000);
    await allocator.allocate('test-ws', 'mcp');
    allocator.release('test-ws', 'mcp');
    assert.equal(allocator.getPort('test-ws', 'mcp'), null);
});

test('increments port on conflict', async () => {
    const allocator = createPortAllocator(19000);
    const port1 = await allocator.allocate('ws-a', 'mcp');
    const port2 = await allocator.allocate('ws-b', 'mcp');
    assert.ok(port2 > port1);
    allocator.release('ws-a', 'mcp');
    allocator.release('ws-b', 'mcp');
});

test('listAllocations returns all current allocations', async () => {
    const allocator = createPortAllocator(19000);
    await allocator.allocate('ws-a', 'mcp');
    await allocator.allocate('ws-b', 'mcp');
    const list = allocator.listAllocations();
    assert.equal(list.length, 2);
    const names = list.map((a) => `${a.workspaceName}/${a.serviceName}`).sort();
    assert.deepEqual(names, ['ws-a/mcp', 'ws-b/mcp']);
    allocator.release('ws-a', 'mcp');
    allocator.release('ws-b', 'mcp');
});
