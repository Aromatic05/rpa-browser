import assert from 'node:assert/strict';
import { dispatchActionRequest } from '../../dist/actions/index.js';
import { projectInboundAction } from '../../dist/background/projection.js';
import { ACTION_TYPES } from '../../dist/actions/action_types.js';

const log = async (name, fn) => {
    try {
        await fn();
        console.warn(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

const mkWsClient = (handler = async (action) => ({
    v: 1,
    id: `reply-${action.id}`,
    type: `${action.type}.result`,
    replyTo: action.id,
    payload: {},
})) => ({ sendAction: handler });

await log('control action without workspaceName passes', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-1', type: 'workspace.list', payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'workspace.list.result');
});

await log('control action with workspaceName fails', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-2', type: 'workspace.list', workspaceName: 'ws-1', payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'workspace.list.failed');
});

await log('workspace action with workspaceName passes', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-3', type: 'tab.list', workspaceName: 'ws-1', payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'tab.list.result');
});

await log('workspace action without workspaceName fails', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-4', type: 'tab.list', payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'tab.list.failed');
});

await log('payload.workspaceName is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-5', type: 'workspace.list', payload: { workspaceName: 'ws-1' } },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
    assert.equal(reply.payload.code, 'ERR_BAD_ARGS');
});

await log('missing v fails envelope', async () => {
    const reply = await dispatchActionRequest(
        { id: 'req-v0', type: 'workspace.list', payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('v not equal to 1 fails envelope', async () => {
    const reply = await dispatchActionRequest(
        { v: 2, id: 'req-v2', type: 'workspace.list', payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('top-level scope is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-scope', type: 'workspace.list', scope: { workspaceName: 'ws-1' }, payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('top-level workspaceId is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-wsid', type: 'workspace.list', workspaceId: 'legacy-1', payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('top-level tabToken is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-tabtoken', type: 'workspace.list', tabToken: 'tok-1', payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('top-level tabName is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-6', type: 'workspace.list', tabName: 'tab-1', payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('top-level tabId is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-tabid', type: 'workspace.list', tabId: 11, payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('top-level windowId is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-windowid', type: 'workspace.list', windowId: 7, payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('top-level chromeTabNo is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-ctn', type: 'workspace.list', chromeTabNo: 11, payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('payload.scope is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-pscope', type: 'workspace.list', payload: { scope: { workspaceName: 'ws-1' } } },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('payload.workspaceId is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-pwsid', type: 'workspace.list', payload: { workspaceId: 'legacy-1' } },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('payload.tabToken is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-ptabtoken', type: 'workspace.list', payload: { tabToken: 'tok-1' } },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('payload.tabName is allowed', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-ptabname', type: 'workspace.list', payload: { tabName: 'tab-1' } },
        mkWsClient(),
    );
    assert.equal(reply.type, 'workspace.list.result');
});

await log('tab.setActive with top-level workspaceName and payload.tabName passes', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-tabsetactive', type: 'tab.setActive', workspaceName: 'ws-1', payload: { tabName: 'tab-1' } },
        mkWsClient(),
    );
    assert.equal(reply.type, 'tab.setActive.result');
});

await log('payload.tabId is rejected', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-ptabid', type: 'workspace.list', payload: { tabId: 11 } },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('removed workflow init action is rejected', async () => {
    const removed = ['workflow', 'init'].join('.');
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-7', type: removed, payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('removed workflow record save action is rejected', async () => {
    const removed = ['workflow', 'record', 'save'].join('.');
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-8', type: removed, payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'action.dispatch.failed');
});

await log('workflow.create is accepted', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-9', type: 'workflow.create', payload: {} },
        mkWsClient(),
    );
    assert.equal(reply.type, 'workflow.create.result');
});

await log('workflow.rename is accepted', async () => {
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-10', type: 'workflow.rename', payload: { from: 'a', to: 'b' } },
        mkWsClient(),
    );
    assert.equal(reply.type, 'workflow.rename.result');
});

await log('dispatchActionRequest does not need lifecycle or router state', async () => {
    const calls = [];
    const wsClient = mkWsClient(async (action) => {
        calls.push(action.type);
        return { v: 1, id: 'reply-11', type: `${action.type}.result`, replyTo: action.id, payload: {} };
    });
    const reply = await dispatchActionRequest(
        { v: 1, id: 'req-11', type: 'workspace.list', payload: {} },
        wsClient,
    );
    assert.equal(reply.type, 'workspace.list.result');
    assert.deepEqual(calls, ['workspace.list']);
});

await log('projection updates router state for workspace.changed', async () => {
    globalThis.chrome = { windows: { WINDOW_ID_NONE: -1 } };
    const calls = [];
    const state = {
        setActiveWorkspaceName: (name) => calls.push(['setActiveWorkspaceName', name]),
        getActiveWindowId: () => 7,
        setWindowWorkspace: (windowId, name) => calls.push(['setWindowWorkspace', windowId, name]),
        getActiveChromeTabNo: () => null,
        getTabState: () => undefined,
        upsertBindingWorkspaceTab: () => undefined,
        bindWorkspaceToWindowIfKnown: () => undefined,
    };
    let refreshed = 0;
    projectInboundAction(
        { v: 1, id: 'evt-1', type: ACTION_TYPES.WORKSPACE_CHANGED, payload: { workspaceName: 'ws-1' } },
        state,
        () => { refreshed += 1; },
    );
    assert.equal(refreshed, 1);
    assert.deepEqual(calls[0], ['setActiveWorkspaceName', 'ws-1']);
    assert.deepEqual(calls[1], ['setWindowWorkspace', 7, 'ws-1']);
});
