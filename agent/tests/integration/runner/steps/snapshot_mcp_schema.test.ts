import test from 'node:test';
import assert from 'node:assert/strict';
import { browserBatchInputSchema, browserSnapshotInputSchema, toolInputJsonSchemas } from '../../../../src/mcp/schemas';

test('browser.snapshot MCP schema accepts scoped diff args', () => {
    const parsed = browserSnapshotInputSchema.safeParse({
        tabName: 'tab-1',
        contain: 'node-1',
        depth: 2,
        filter: {
            role: ['button', 'link'],
            text: 'save',
            interactive: true,
        },
        diff: true,
        refresh: true,
        mode: 'interaction',
    });

    assert.equal(parsed.success, true);
});

test('browser.snapshot MCP schema accepts every V2 projection mode', () => {
    for (const mode of ['overview', 'interaction', 'annotation', 'debug', 'full']) {
        assert.equal(browserSnapshotInputSchema.safeParse({mode}).success, true);
    }
    assert.equal(browserSnapshotInputSchema.safeParse({mode: 'legacy'}).success, false);
});

test('browser.snapshot MCP schema rejects invalid depth', () => {
    const parsed = browserSnapshotInputSchema.safeParse({ depth: -2 });
    assert.equal(parsed.success, false);
});

test('browser.snapshot tool json schema exposes contain/depth/filter/diff/mode', () => {
    const schema = toolInputJsonSchemas['browser.snapshot'] as {
        properties?: Record<string, unknown>;
    };

    const properties = schema.properties || {};
    assert.ok('contain' in properties);
    assert.ok('depth' in properties);
    assert.ok('filter' in properties);
    assert.ok('diff' in properties);
    assert.deepEqual((properties.mode as {enum?: string[]}).enum, ['overview', 'interaction', 'annotation', 'debug', 'full']);
});

test('browser.batch schema accepts label-driven form actions', () => {
    const parsed = browserBatchInputSchema.safeParse({
        actions: [
            { op: 'fill', label: '报销人', value: '李明' },
            { op: 'select_option', label: '报销状态', values: ['审批中'] },
            { op: 'click', label: '提 交' },
        ],
        stopOnError: true,
    });
    assert.equal(parsed.success, true);
});

test('browser.batch tool json schema is exposed', () => {
    const schema = toolInputJsonSchemas['browser.batch'] as { properties?: Record<string, unknown> };
    const properties = schema.properties || {};
    assert.ok('actions' in properties);
    assert.ok('stopOnError' in properties);
});
