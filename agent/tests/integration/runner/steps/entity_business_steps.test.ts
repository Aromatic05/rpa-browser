import test from 'node:test';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import type {RunStepsDeps} from '../../../../src/runner/run_steps';
import {executeBrowserEntity} from '../../../../src/runner/steps/executors/entity';
import type {Step} from '../../../../src/runner/steps/types';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const createDeps = async (): Promise<{
    deps: RunStepsDeps;
    nodeIds: Record<string, string>;
}> => {
    const page = {url: () => 'https://example.test/orders'};
    const deps = completeRunStepsDeps({pluginHost: {} as never}, {
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
    return {deps, nodeIds: fixture.nodeIds};
};

const entityStep = (id: string, args: Step<'browser.entity'>['args']): Step<'browser.entity'> => ({
    id,
    name: 'browser.entity',
    args,
});

test('browser.entity list/find/get reads V2 canonical components and SemanticBindings', async () => {
    const {deps, nodeIds} = await createDeps();
    const listed = await executeBrowserEntity(entityStep('list', {op: 'list'}), deps, 'ws-1');
    assert.equal(listed.ok, true);
    if (!listed.ok) {return;}
    assert.equal((listed.data as any).total, 2);

    const found = await executeBrowserEntity(entityStep('find', {
        op: 'find',
        kind: 'table',
        businessTag: 'order.table.main',
        query: 'order table',
    }), deps, 'ws-1');
    assert.equal(found.ok, true);
    if (found.ok) {assert.equal((found.data as any).total, 1);}

    const got = await executeBrowserEntity(entityStep('get', {
        op: 'get',
        nodeId: nodeIds['orders-table'],
    }), deps, 'ws-1');
    assert.equal(got.ok, true);
    if (!got.ok) {return;}
    assert.equal((got.data as any).total, 1);
    assert.equal((got.data as any).table_meta.rowCount, 1);
});

test('browser.entity add/rename/delete uses manual SemanticBindings without overlays', async () => {
    const {deps, nodeIds} = await createDeps();
    const panelNodeId = nodeIds.panel;

    const added = await executeBrowserEntity(entityStep('add', {
        op: 'add',
        nodeId: panelNodeId,
        kind: 'panel',
        name: '人工面板',
        businessTag: 'manual.panel',
    }), deps, 'ws-1');
    assert.equal(added.ok, true);
    if (!added.ok) {return;}
    assert.equal((added.data as any).entity.source, 'manual');
    assert.equal((added.data as any).semantic_summary.active_count, 1);

    const renamed = await executeBrowserEntity(entityStep('rename', {
        op: 'rename',
        nodeId: panelNodeId,
        name: '重命名面板',
    }), deps, 'ws-1');
    assert.equal(renamed.ok, true);
    if (!renamed.ok) {return;}
    assert.equal((renamed.data as any).node.name, '重命名面板');

    const got = await executeBrowserEntity(entityStep('get-panel', {
        op: 'get',
        nodeId: panelNodeId,
    }), deps, 'ws-1');
    assert.equal(got.ok, true);
    if (!got.ok) {return;}
    assert.equal((got.data as any).entities[0].name, '重命名面板');
    assert.equal((got.data as any).entities[0].businessTag, 'manual.panel');

    const deleted = await executeBrowserEntity(entityStep('delete', {
        op: 'delete',
        nodeId: panelNodeId,
        kind: 'panel',
        businessTag: 'manual.panel',
    }), deps, 'ws-1');
    assert.equal(deleted.ok, true);
    if (!deleted.ok) {return;}
    assert.equal((deleted.data as any).deleted_count, 1);
    assert.equal((deleted.data as any).matched_after, 0);
    assert.equal((deleted.data as any).semantic_summary.ignored_count, 1);
});

test('browser.entity delete suppresses a structural entity through a semantic tombstone', async () => {
    const {deps, nodeIds} = await createDeps();
    const deleted = await executeBrowserEntity(entityStep('delete-table', {
        op: 'delete',
        nodeId: nodeIds['orders-table'],
        kind: 'table',
        businessTag: 'order.table.main',
    }), deps, 'ws-1');
    assert.equal(deleted.ok, true);
    if (!deleted.ok) {return;}
    assert.equal((deleted.data as any).deleted_count, 1);

    const listed = await executeBrowserEntity(entityStep('list-table', {
        op: 'list',
        kind: 'table',
    }), deps, 'ws-1');
    assert.equal(listed.ok, true);
    if (listed.ok) {assert.equal((listed.data as any).total, 0);}
});

test('browser.entity rejects unknown canonical node ids', async () => {
    const {deps} = await createDeps();
    const result = await executeBrowserEntity(entityStep('missing', {
        op: 'add',
        nodeId: 'missing-node',
        kind: 'panel',
    }), deps, 'ws-1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_NOT_FOUND');
});


test('browser.entity exposes explicit generic structures and canonical list/KV members', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <dialog id="ConfirmDialog" open aria-label="Confirm"></dialog>
          <ul id="TaskList" aria-label="Tasks"><li id="TaskA">A</li><li id="TaskB">B</li></ul>
          <section id="Summary" role="region" aria-label="Summary">Summary content</section>
          <div id="Actions" role="toolbar" aria-label="Actions"><button>Save</button></div>
          <dl id="Details"><dt id="NameKey">Name</dt><dd>Alice</dd><dt id="StatusKey">Status</dt><dd>Open</dd></dl>
        `);
        const deps = completeRunStepsDeps({pluginHost: {} as never}, {
            workspaceName: 'ws-1',
            tabName: 'tab-1',
            page,
        });
        const listed = await executeBrowserEntity(entityStep('generic-list', {op: 'list'}), deps, 'ws-1');
        assert.equal(listed.ok, true);
        if (!listed.ok) {return;}
        const entities = (listed.data as {entities: Array<{
            kind: string;
            itemNodeIds?: string[];
            keySlot?: number;
        }>}).entities;
        assert.deepEqual(
            entities.map((entity) => entity.kind).sort(),
            ['dialog', 'kv', 'list', 'panel', 'toolbar'],
        );
        const list = entities.find((entity) => entity.kind === 'list');
        const kv = entities.find((entity) => entity.kind === 'kv');
        assert.equal(list?.itemNodeIds?.length, 2);
        assert.equal(list?.keySlot, 0);
        assert.equal(kv?.itemNodeIds?.length, 2);
        assert.equal(kv?.keySlot, 0);
    } finally {
        await browser.close();
    }
});
