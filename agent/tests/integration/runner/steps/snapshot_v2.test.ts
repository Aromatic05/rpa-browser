import test from 'node:test';
import assert from 'node:assert/strict';
import {executeBrowserSnapshot} from '../../../../src/runner/steps/executors/snapshot';
import {executeBrowserGetContent} from '../../../../src/runner/steps/executors/get_content';
import type {Step} from '../../../../src/runner/steps/types';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';
import type {PageSnapshotCapture} from '../../../../src/snapshot';

const createFixture = async () => {
    const url = {value: 'https://example.test/orders'};
    const page = {url: () => url.value};
    const deps = completeRunStepsDeps({config: {} as never, pluginHost: {} as never}, {
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        page,
    });
    const fixture = createV2BusinessPage();
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: url.value,
        capture: async () => fixture.capture,
    });
    return {deps, page, url, fixture};
};

const step = (id: string, args: Step<'browser.snapshot'>['args']): Step<'browser.snapshot'> => ({
    id,
    name: 'browser.snapshot',
    args,
});

test('browser.snapshot returns V2 projection and explicit contain errors', async () => {
    const {deps, fixture} = await createFixture();
    const result = await executeBrowserSnapshot(step('snapshot-full', {}), deps, 'ws-1');
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    const data = result.data as any;
    assert.equal(data.schemaVersion, 2);
    assert.equal(data.meta.mode, 'full');
    assert.equal(data.components.forms.length, 1);
    assert.equal(data.components.tables.length, 1);

    const scoped = await executeBrowserSnapshot(step('snapshot-scoped', {
        contain: fixture.nodeIds['orders-table'],
        depth: 0,
    }), deps, 'ws-1');
    assert.equal(scoped.ok, true);
    if (scoped.ok) {
        assert.deepEqual((scoped.data as any).roots.map((root: any) => root.nodeId), [fixture.nodeIds['orders-table']]);
    }

    const missing = await executeBrowserSnapshot(step('snapshot-missing', {contain: 'missing-node'}), deps, 'ws-1');
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, 'ERR_NOT_FOUND');
});

test('browser.snapshot stores scoped baselines and emits same-epoch semantic diff', async () => {
    const {deps, page, fixture} = await createFixture();
    const first = await executeBrowserSnapshot(step('snapshot-diff-first', {diff: true}), deps, 'ws-1');
    assert.equal(first.ok, true);
    if (!first.ok) {return;}
    assert.equal((first.data as any).meta.mode, 'full');
    assert.equal((first.data as any).meta.diffSkipped, 'no_baseline');

    const unchanged = await executeBrowserSnapshot(step('snapshot-diff-unchanged', {diff: true}), deps, 'ws-1');
    assert.equal(unchanged.ok, true);
    if (unchanged.ok) {
        assert.equal((unchanged.data as any).meta.mode, 'diff');
        assert.equal((unchanged.data as any).meta.changedNodeCount, 0);
    }

    const next = structuredClone(fixture.capture) as PageSnapshotCapture;
    const submitNodeId = fixture.nodeIds.submit;
    (next.control.observation.identity as any).captureRevision = 2;
    (next.form.observation.identity as any).captureRevision = 2;
    (next.table.observation.identity as any).captureRevision = 2;
    (next.control.observation.text as any)[submitNodeId] = '已提交';
    deps.pageSession.markDirty(page as never, 'interaction');
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: page.url(),
        capture: async () => next,
    });

    const changed = await executeBrowserSnapshot(step('snapshot-diff-changed', {diff: true}), deps, 'ws-1');
    assert.equal(changed.ok, true);
    if (!changed.ok) {return;}
    assert.equal((changed.data as any).meta.mode, 'diff');
    assert.equal((changed.data as any).meta.changedNodeCount, 1);
    const roots = (changed.data as any).roots as any[];
    const containsSubmit = (nodes: any[]): boolean => nodes.some((node) =>
        node.nodeId === submitNodeId || containsSubmit(node.children || []));
    assert.equal(containsSubmit(roots), true);
});

test('browser.snapshot diff falls back to full after navigation', async () => {
    const {deps, page, url, fixture} = await createFixture();
    const first = await executeBrowserSnapshot(step('snapshot-navigation-first', {}), deps, 'ws-1');
    assert.equal(first.ok, true);

    const next = structuredClone(fixture.capture) as PageSnapshotCapture;
    (next.control.observation.identity as any).pageEpoch = 'new-page';
    (next.form.observation.identity as any).pageEpoch = 'new-page';
    (next.table.observation.identity as any).pageEpoch = 'new-page';
    url.value = 'https://example.test/orders/2';
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: url.value,
        capture: async () => next,
    });

    const result = await executeBrowserSnapshot(step('snapshot-navigation-diff', {diff: true}), deps, 'ws-1');
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    assert.equal((result.data as any).meta.mode, 'full');
    assert.equal((result.data as any).meta.diffSkipped, 'navigation');
});


test('browser.get_content resolves epoch-bound V2 projection refs and rejects stale refs', async () => {
    const {deps, page, url, fixture} = await createFixture();
    const snapshot = await executeBrowserSnapshot(step('snapshot-content', {}), deps, 'ws-1');
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) {return;}
    const submitNodeId = fixture.nodeIds.submit;
    const findNode = (nodes: any[]): any => {
        for (const node of nodes) {
            if (node.nodeId === submitNodeId) {return node;}
            const found = findNode(node.children || []);
            if (found) {return found;}
        }
        return undefined;
    };
    const submit = findNode((snapshot.data as any).roots);
    assert.equal(typeof submit?.contentRef, 'string');

    const content = await executeBrowserGetContent({
        id: 'content-current',
        name: 'browser.get_content',
        args: {ref: submit.contentRef},
    }, deps, 'ws-1');
    assert.equal(content.ok, true);
    if (content.ok) {assert.match((content.data as any).content, /提交/);}

    const next = structuredClone(fixture.capture) as PageSnapshotCapture;
    (next.control.observation.identity as any).pageEpoch = 'content-next-page';
    (next.form.observation.identity as any).pageEpoch = 'content-next-page';
    (next.table.observation.identity as any).pageEpoch = 'content-next-page';
    url.value = 'https://example.test/orders/next';
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: url.value,
        capture: async () => next,
    });

    const stale = await executeBrowserGetContent({
        id: 'content-stale',
        name: 'browser.get_content',
        args: {ref: submit.contentRef},
    }, deps, 'ws-1');
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, 'ERR_STALE');
});

test('browser.snapshot isolates diff baselines by projection mode', async () => {
    const {deps} = await createFixture();
    const overview = await executeBrowserSnapshot(step('snapshot-overview-diff', {
        mode: 'overview',
        diff: true,
    }), deps, 'ws-1');
    assert.equal(overview.ok, true);
    if (!overview.ok) {return;}
    assert.equal((overview.data as any).meta.viewMode, 'overview');
    assert.equal((overview.data as any).meta.diffSkipped, 'no_baseline');

    const full = await executeBrowserSnapshot(step('snapshot-full-diff', {
        mode: 'full',
        diff: true,
    }), deps, 'ws-1');
    assert.equal(full.ok, true);
    if (!full.ok) {return;}
    assert.equal((full.data as any).meta.viewMode, 'full');
    assert.equal((full.data as any).meta.diffSkipped, 'no_baseline');

    const secondOverview = await executeBrowserSnapshot(step('snapshot-overview-diff-2', {
        mode: 'overview',
        diff: true,
    }), deps, 'ws-1');
    assert.equal(secondOverview.ok, true);
    if (secondOverview.ok) {
        assert.equal((secondOverview.data as any).meta.mode, 'diff');
        assert.equal((secondOverview.data as any).meta.viewMode, 'overview');
    }
});
