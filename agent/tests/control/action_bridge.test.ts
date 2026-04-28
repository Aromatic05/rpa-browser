import test from 'node:test';
import assert from 'node:assert/strict';
import {
    callActionFromControl,
    clearControlActionDispatcher,
    setControlActionDispatcher,
} from '../../src/control/action_bridge';
import type { ControlRouterContext } from '../../src/control/router';
import type { RunStepsDeps } from '../../src/runner/run_steps';

const ctx: ControlRouterContext = {
    deps:
        ({
            runtime: {},
            config: {} as any,
            pluginHost: {} as any,
        }) as RunStepsDeps,
};

test('action.call dispatches existing action handlers without rpc wrapping changes', async () => {
    let received: Record<string, unknown> | null = null;
    setControlActionDispatcher({
        dispatch: async (action) => {
            received = action as unknown as Record<string, unknown>;
            return {
                v: 1,
                id: 'reply-1',
                type: `${action.type}.result`,
                payload: { accepted: true },
                replyTo: action.id,
            };
        },
    });

    const result = await callActionFromControl(
        {
            type: 'workspace.list',
            scope: { workspaceId: 'ws-1' },
            payload: { sample: true },
            tabToken: 'tk-1',
            traceId: 'trace-1',
        },
        ctx,
    );

    assert.equal((result as { type: string }).type, 'workspace.list.result');
    assert.equal(received?.type, 'workspace.list');
    assert.deepEqual(received?.scope, { workspaceId: 'ws-1' });
    assert.equal(received?.tabToken, 'tk-1');
    assert.equal(received?.traceId, 'trace-1');

    clearControlActionDispatcher();
});
