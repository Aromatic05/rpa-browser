import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { executeBrowserAssert } from '../../../src/runner/steps/executors/assert';
import type { Step } from '../../../src/runner/steps/types';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import { getRunnerConfig } from '../../../src/config';
import { RunnerPluginHost } from '../../../src/runner/hotreload/plugin_host';

const createDeps = (options: {
    url?: string;
    textVisibleResult?: boolean;
    entityCount?: number;
}): RunStepsDeps => {
    const workspaceName = 'ws-1';
    const tabId = 'tab-1';
    const tabName = 'tab-token-1';
    const currentUrl = options.url || 'https://example.test/page';
    const traceTools = {
        'trace.page.getInfo': async () => ({ ok: true, data: { url: currentUrl } }),
        'trace.page.evaluate': async () => ({ ok: true, data: options.textVisibleResult ?? true }),
    };

    const minimalSnapshot = {
        root: { id: 'root', role: 'root', children: [] },
        nodeIndex: {},
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {},
        bboxIndex: {},
        attrIndex: {},
        contentStore: {},
    } as any;

    const entityCount = options.entityCount ?? 0;
    const snapshotSessionStore = {
        version: 1,
        entries: {
            [`${workspaceName}:${tabName}`]: {
                pageIdentity: {
                    workspaceName,
                    tabId,
                    tabName,
                    url: currentUrl,
                },
                baseSnapshot: minimalSnapshot,
                finalSnapshot: minimalSnapshot,
                finalEntityView: {
                    entities: Array.from({ length: entityCount }, (_, idx) => ({
                        id: `e-${idx}`,
                        nodeId: `node-${idx}`,
                        kind: 'form',
                        type: 'region',
                        name: `Entity ${idx}`,
                        source: 'auto',
                    })),
                    byNodeId: {},
                    bindingIndex: {
                        fieldsByEntity: {},
                        actionsByEntity: {},
                        columnsByEntity: {},
                    },
                },
                overlays: {
                    renamedNodes: {},
                    addedEntities: [],
                    deletedEntities: [],
                },
                diffBaselines: {},
                dirty: false,
                lastRefreshAt: Date.now(),
                version: 1,
            },
        },
    };

    const binding = {
        workspaceName,
        tabId,
        tabName,
        page: { url: () => currentUrl },
        traceTools,
        traceCtx: {
            cache: {
                snapshotSessionStore,
            },
        },
    };

    return {
        runtime: {
            ensureActivePage: async () => binding,
        } as any,
        config: getRunnerConfig(),
        pluginHost: new RunnerPluginHost(path.resolve(process.cwd(), 'src/runner/plugin_entry.ts')),
    };
};

const createAssertStep = (args: Step<'browser.assert'>['args']): Step<'browser.assert'> => ({
    id: 'assert-1',
    name: 'browser.assert',
    args,
});

test('assert urlIncludes success', async () => {
    const deps = createDeps({ url: 'https://example.test/ok' });
    const result = await executeBrowserAssert(createAssertStep({ urlIncludes: '/ok' }), deps, 'ws-1');
    assert.equal(result.ok, true);
});

test('assert urlIncludes failure', async () => {
    const deps = createDeps({ url: 'https://example.test/nope' });
    const result = await executeBrowserAssert(createAssertStep({ urlIncludes: '/ok' }), deps, 'ws-1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_CHECKPOINT_ASSERT_FAILED');
});

test('assert textVisible success', async () => {
    const deps = createDeps({ textVisibleResult: true });
    const result = await executeBrowserAssert(createAssertStep({ textVisible: 'Hello' }), deps, 'ws-1');
    assert.equal(result.ok, true);
});

test('assert textVisible failure', async () => {
    const deps = createDeps({ textVisibleResult: false });
    const result = await executeBrowserAssert(createAssertStep({ textVisible: 'Hello' }), deps, 'ws-1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_CHECKPOINT_ASSERT_FAILED');
});

test('assert entityExists success', async () => {
    const deps = createDeps({ entityCount: 1 });
    const result = await executeBrowserAssert(createAssertStep({ entityExists: { query: 'Entity' } }), deps, 'ws-1');
    assert.equal(result.ok, true);
});

test('assert entityExists failure', async () => {
    const deps = createDeps({ entityCount: 0 });
    const result = await executeBrowserAssert(createAssertStep({ entityExists: { query: 'Entity' } }), deps, 'ws-1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_CHECKPOINT_ASSERT_FAILED');
});
