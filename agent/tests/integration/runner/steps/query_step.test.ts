import test from 'node:test';
import assert from 'node:assert/strict';
import type {RunStepsDeps} from '../../../../src/runner/run_steps';
import {executeBrowserQuery} from '../../../../src/runner/steps/executors/query';
import type {Step} from '../../../../src/runner/steps/types';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const createDeps = async (): Promise<{
    deps: RunStepsDeps;
    nodeIds: Record<string, string>;
    page: {url: () => string};
    refreshReasons: Array<string | undefined>;
}> => {
    const page = {url: () => 'https://example.test/orders'};
    const deps = completeRunStepsDeps({config: {} as never, pluginHost: {} as never}, {
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        page,
    });
    const fixture = createV2BusinessPage();
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: page.url(),
        capture: async () => fixture.capture,
    });
    const currentEntry = deps.pageSession.read(page as never);
    assert.ok(currentEntry);
    const refreshReasons: Array<string | undefined> = [];
    deps.pageSession.ensureFresh = async (input) => {
        refreshReasons.push(input.reason);
        return currentEntry;
    };
    return {deps, nodeIds: fixture.nodeIds, page, refreshReasons};
};

test('browser.query finds canonical rows from PageSession descendants', async () => {
    const {deps, nodeIds} = await createDeps();
    const step: Step<'browser.query'> = {
        id: 'q1',
        name: 'browser.query',
        args: {
            from: 'snapshot',
            where: {role: 'tr', tag: 'tr', attrs: {'data-row-key': 'SO-001'}},
        },
    };
    const result = await executeBrowserQuery(step, deps, 'ws-1');
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    assert.equal((result.data as any).kind, 'nodeIds');
    assert.deepEqual((result.data as any).nodeIds, [nodeIds['row-1']]);
    assert.equal((result.data as any).meta.captureRevision, 1);
});

test('browser.query supports from.nodeIds with child relation and descendant text', async () => {
    const {deps, nodeIds} = await createDeps();
    const step: Step<'browser.query'> = {
        id: 'q2',
        name: 'browser.query',
        args: {
            from: {nodeIds: [nodeIds['orders-table']]},
            relation: 'descendant',
            where: {text: {contains: 'SO-001'}},
            limit: 1,
        },
    };
    const result = await executeBrowserQuery(step, deps, 'ws-1');
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    assert.equal((result.data as any).count, 1);
    assert.equal((result.data as any).nodeIds[0], nodeIds.tbody);
});

test('browser.query executes business query and target through V2 EntityView', async () => {
    const {deps, nodeIds} = await createDeps();
    const rowCount = await executeBrowserQuery({
        id: 'q-business',
        name: 'browser.query',
        args: {op: 'entity', businessTag: 'order.table.main', query: 'table.rowCount'},
    }, deps, 'ws-1');
    assert.equal(rowCount.ok, true);
    if (rowCount.ok) {assert.equal((rowCount.data as any).value, 1);}

    const target = await executeBrowserQuery({
        id: 'q-target',
        name: 'browser.query',
        args: {
            op: 'entity.target',
            businessTag: 'order.table.main',
            target: {
                kind: 'table.row_action',
                primaryKey: {fieldKey: 'orderNo', value: 'SO-001'},
                actionIntent: 'approve',
            },
        },
    }, deps, 'ws-1');
    assert.equal(target.ok, true);
    if (target.ok) {assert.equal((target.data as any).nodeId, nodeIds.approve);}

    const filter = await executeBrowserQuery({
        id: 'q-table-filter',
        name: 'browser.query',
        args: {
            op: 'entity.target',
            businessTag: 'order.table.main',
            target: {kind: 'table.filter', fieldKey: 'orderNo'},
        },
    }, deps, 'ws-1');
    assert.equal(filter.ok, true);
    if (filter.ok) {assert.equal((filter.data as any).nodeId, nodeIds.buyer);}

    const moduleAction = await executeBrowserQuery({
        id: 'q-table-module-action',
        name: 'browser.query',
        args: {
            op: 'entity.target',
            businessTag: 'order.table.main',
            target: {kind: 'table.module_action', actionIntent: 'search'},
        },
    }, deps, 'ws-1');
    assert.equal(moduleAction.ok, true);
    if (moduleAction.ok) {assert.equal((moduleAction.data as any).nodeId, nodeIds.submit);}
});

test('business queries refresh rule selection instead of inheriting a prior explicit profile', async () => {
    const {deps, refreshReasons} = await createDeps();

    await executeBrowserQuery({
        id: 'q-explicit',
        name: 'browser.query',
        args: {op: 'entity', businessTag: 'order.table.main', query: 'table.rowCount'},
        entityRules: {selection: 'explicit', profiles: ['orders-table'], strict: true},
    }, deps, 'ws-1');
    await executeBrowserQuery({
        id: 'q-default',
        name: 'browser.query',
        args: {op: 'entity', businessTag: 'order.table.main', query: 'table.rowCount'},
    }, deps, 'ws-1');

    assert.deepEqual(refreshReasons, ['explicit', 'explicit']);
});

test('browser.query returns ERR_BAD_ARGS on invalid relation or unsupported from', async () => {
    const {deps} = await createDeps();
    const invalidRelation = await executeBrowserQuery({
        id: 'q3',
        name: 'browser.query',
        args: {from: 'snapshot', relation: 'invalid'},
    } as unknown as Step<'browser.query'>, deps, 'ws-1');
    assert.equal(invalidRelation.ok, false);
    assert.equal(invalidRelation.error?.code, 'ERR_BAD_ARGS');
    assert.deepEqual(invalidRelation.error?.details, {
        pageEpoch: 'v2-business',
        captureRevision: 1,
        scopeIds: ['main'],
        relation: 'invalid',
        from: 'snapshot',
    });

    const unsupportedFrom = await executeBrowserQuery({
        id: 'q4',
        name: 'browser.query',
        args: {from: 'x'},
    } as unknown as Step<'browser.query'>, deps, 'ws-1');
    assert.equal(unsupportedFrom.ok, false);
    assert.equal(unsupportedFrom.error?.code, 'ERR_BAD_ARGS');
    assert.deepEqual(unsupportedFrom.error?.details, {
        pageEpoch: 'v2-business',
        captureRevision: 1,
        scopeIds: ['main'],
        relation: 'descendant',
        from: 'x',
    });
});


test('browser.query business failures include page and semantic resolution diagnostics', async () => {
    const {deps} = await createDeps();
    const result = await executeBrowserQuery({
        id: 'q-business-missing',
        name: 'browser.query',
        args: {op: 'entity', businessTag: 'missing.entity', query: 'table.rowCount'},
    }, deps, 'ws-1');
    assert.equal(result.ok, false);
    if (result.ok) {return;}
    assert.equal(result.error?.code, 'ERR_NOT_FOUND');
    assert.deepEqual(result.error?.details, {
        pageEpoch: 'v2-business',
        captureRevision: 1,
        scopeIds: ['main'],
        operation: 'entity',
        businessTag: 'missing.entity',
        query: 'table.rowCount',
        semanticProfiles: ['orders-form', 'orders-table'],
        availableBusinessTags: ['order.form.main', 'order.table.main'],
    });
});
