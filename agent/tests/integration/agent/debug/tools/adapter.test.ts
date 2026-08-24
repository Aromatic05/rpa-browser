import test from 'node:test';
import assert from 'node:assert/strict';
import {createDebugQuerySession} from '../../../../../src/agent/debug/query/session';
import {createDebugQueryAgentTools} from '../../../../../src/agent/debug/tools/adapter';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const createSession = async () => {
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const view: WorldView = Object.freeze({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return createDebugQuerySession(view);
};

test('debug Agent tools expose only the pure WorldView query plane', async () => {
    const tools = createDebugQueryAgentTools(await createSession());
    assert.deepEqual(tools.map((tool) => tool.name), [
        'debug.world',
        'debug.query',
        'debug.compute',
    ]);
    assert.equal(tools.some((tool) => /click|fill|goto|evaluate/.test(tool.name)), false);
});

test('debug Agent tools keep repeated reads on the same pinned revision', async () => {
    const tools = createDebugQueryAgentTools(await createSession());
    const worldTool = tools.find((tool) => tool.name === 'debug.world')!;
    const queryTool = tools.find((tool) => tool.name === 'debug.query')!;
    const computeTool = tools.find((tool) => tool.name === 'debug.compute')!;

    const world = await worldTool.execute('world-1', {});
    const rows = await queryTool.execute('query-1', {
        op: 'filter',
        predicate: {active: true, attrsEqual: {'data-row-key': 'SO-001'}},
        input: {
            op: 'traverse',
            relation: 'descendant',
            input: {op: 'scan', source: {kind: 'roots'}},
        },
    });
    const count = await computeTool.execute('compute-1', {
        expr: {op: 'len', args: [{ref: {path: 'local.rows'}}]},
        scope: {local: {rows: ['n1']}},
    });

    const worldRevision = (world.details as any).world.revision;
    assert.deepEqual((rows.details as any).world.revision, worldRevision);
    assert.deepEqual((count.details as any).world.revision, worldRevision);
    assert.equal((count.details as any).value, 1);
});
