import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionDispatcher } from '../../src/actions/dispatcher';
import type { Action } from '../../src/actions/action_protocol';
import { createRecordingState } from '../../src/record/recording';

const createDispatcher = () => {
    let ensureActivePageCalls = 0;
    const dispatcher = createActionDispatcher({
        pageRegistry: {
            getActiveWorkspace: () => ({ workspaceId: 'active-ws' }),
        } as any,
        runtime: {
            ensureActivePage: async (workspaceId: string) => {
                ensureActivePageCalls += 1;
                return {
                    workspaceId,
                    tabId: 'tab-1',
                    tabToken: 'token-1',
                    page: {
                        url: () => 'https://example.com',
                    },
                };
            },
        } as any,
        recordingState: createRecordingState(),
        log: () => undefined,
        replayOptions: {} as any,
        navDedupeWindowMs: 0,
    });
    return { dispatcher, getEnsureActivePageCalls: () => ensureActivePageCalls };
};

test('action without workspaceName goes to control gateway path (no runtime page resolution)', async () => {
    const { dispatcher, getEnsureActivePageCalls } = createDispatcher();
    const action: Action = { v: 1, id: 'a1', type: 'workflow.list', payload: {} };
    const reply = await dispatcher.dispatch(action);
    assert.equal(reply.type, 'workflow.list.result');
    assert.equal(getEnsureActivePageCalls(), 0);
});

test('action with workspaceName goes to workspace gateway path', async () => {
    const { dispatcher, getEnsureActivePageCalls } = createDispatcher();
    const action: Action = { v: 1, id: 'a2', type: 'record.get', workspaceName: 'ws-1', payload: {} };
    await dispatcher.dispatch(action);
    assert.equal(getEnsureActivePageCalls(), 1);
});

test('dispatcher rejects legacy envelope fields', async () => {
    const { dispatcher } = createDispatcher();
    await assert.rejects(
        async () => await dispatcher.dispatch({ v: 1, id: 'a3', type: 'workflow.list', scope: {} } as unknown as Action),
        /legacy action address fields are not allowed/,
    );
});

test('dispatcher rejects payload workspaceName duplication', async () => {
    const { dispatcher } = createDispatcher();
    await assert.rejects(
        async () =>
            await dispatcher.dispatch({
                v: 1,
                id: 'a4',
                type: 'workflow.list',
                workspaceName: 'ws-1',
                payload: { workspaceName: 'ws-1' },
            }),
        /legacy payload address fields are not allowed/,
    );
});
