import test from 'node:test';
import assert from 'node:assert/strict';
import {createAnnotatorClient} from '../protocol/annotator_client.js';

const draft = {
    version: 1,
    profileName: 'orders',
    page: {kind: 'table' as const},
    entities: [],
    preserved: {},
};

test('canvas annotator client marks every request with the explicit canvas protocol', async () => {
    const sent: Array<{type: string; payload?: Record<string, unknown>}> = [];
    const client = createAnnotatorClient(async (type, payload) => {
        sent.push({type, payload});
        return {type: `${type}.result`, payload: {}};
    });

    await client.open({tabName: 'tab-1', url: 'https://example.test', profileName: 'orders'});
    await client.pick({fingerprint: {point: {x: 1, y: 2}, tagName: 'button', classTokens: [], rect: {x: 0, y: 0, width: 2, height: 2}, ancestors: []}, purpose: 'entity'});
    await client.recognize({canvasDraft: draft});
    await client.visualize({canvasDraft: draft});
    await client.check({canvasDraft: draft});
    await client.save({canvasDraft: draft, profileName: 'orders', expectedRevision: null});

    assert.equal(sent.length, 6);
    assert.equal(sent.every(({payload}) => payload?.annotatorProtocol === 'canvas-v1'), true);
});
