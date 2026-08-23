import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createDebugQueryAgentRunner} from '../../../../src/agent/execution/debug_query_runner';
import type {WorldView, WorldViewSource} from '../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../src/snapshot';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const createWorldView = async (): Promise<WorldView> => {
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    return Object.freeze({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

test('debug query runner pins once and records only pure reads on one revision', async () => {
    const faux = createFauxCore({provider: 'faux-debug', models: [{id: 'debug'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('debug.world', {})),
        fauxAssistantMessage(fauxToolCall('debug.query', {
            op: 'entity',
            businessTag: 'order.table.main',
            query: 'table.rowCount',
        })),
        fauxAssistantMessage('Pinned revision inspected.'),
    ]);
    let pinCalls = 0;
    const view = await createWorldView();
    const source: WorldViewSource = {
        pin: async () => {
            pinCalls += 1;
            return view;
        },
    };
    const runner = createDebugQueryAgentRunner({
        worldViewSource: source,
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-debug' && model === 'debug'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const output = await runner.run({
        prompt: 'Inspect the pinned order table.',
        provider: 'faux-debug',
        model: 'debug',
    });

    assert.equal(pinCalls, 1);
    assert.equal(output.text, 'Pinned revision inspected.');
    assert.deepEqual(output.trace.metrics, {
        turns: 3,
        toolCalls: 2,
        readCalls: 2,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    });
    for (const tool of output.trace.tools) {
        assert.deepEqual(tool.worldBefore, {
            pageEpoch: 'v2-business',
            captureRevision: 1,
            freshness: 'fresh',
        });
        assert.deepEqual(tool.worldAfter, tool.worldBefore);
    }
});
