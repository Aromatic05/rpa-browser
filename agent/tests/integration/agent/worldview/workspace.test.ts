import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceWorldViewSource} from '../../../../src/agent/worldview/workspace';
import {queryPageSessionEntry} from '../../../../src/automation/runner/session/query';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';

const createDeps = async () => {
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
    return {deps, page, fixture};
};

test('Workspace WorldView pins one PageSession revision while live session advances', async () => {
    const {deps, page, fixture} = await createDeps();
    const source = createWorkspaceWorldViewSource({workspaceName: 'ws-1', deps});
    const view = await source.pin();

    assert.equal(view.workspaceName, 'ws-1');
    assert.equal(view.tabName, 'tab-1');
    assert.equal(view.revision.pageEpoch, 'v2-business');
    assert.equal(view.revision.captureRevision, 1);
    assert.equal(view.entry.identity.captureRevision, 1);

    const nextCapture = structuredClone(fixture.capture);
    nextCapture.control.observation.identity.captureRevision = 2;
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: page.url(),
        reason: 'explicit',
        capture: async () => nextCapture,
    });
    assert.equal(deps.pageSession.read(page as never)?.identity.captureRevision, 2);

    const result = queryPageSessionEntry(view.entry, {
        from: 'snapshot.latest',
        where: {attrs: {'data-row-key': 'SO-001'}},
    });
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    assert.equal((result.data.meta as any).captureRevision, 1);
});

test('Workspace WorldView is a frozen value descriptor around an immutable session entry', async () => {
    const {deps} = await createDeps();
    const view = await createWorkspaceWorldViewSource({workspaceName: 'ws-1', deps}).pin();

    assert.equal(Object.isFrozen(view), true);
    assert.equal(Object.isFrozen(view.revision), true);
    assert.equal(Object.isFrozen(view.entry), true);
});
