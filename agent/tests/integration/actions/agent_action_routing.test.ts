import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {classifyActionRoute, isWorkspaceAction} from '../../../src/actions/classify';
import {REQUEST_ACTION_TYPES, isRequestActionType} from '../../../src/actions/action_types';
import type {Action} from '../../../src/actions/action_protocol';

const action = (type: string, workspaceName?: string): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName,
});

test('agent endpoint actions are registered workspace commands', () => {
    assert.equal(REQUEST_ACTION_TYPES.AGENT_START, 'agent.start');
    assert.equal(REQUEST_ACTION_TYPES.AGENT_STOP, 'agent.stop');
    assert.equal(REQUEST_ACTION_TYPES.AGENT_STATUS, 'agent.status');
    assert.equal(REQUEST_ACTION_TYPES.AGENT_RUN, 'agent.run');
    for (const type of ['agent.start', 'agent.stop', 'agent.status', 'agent.run']) {
        assert.equal(isRequestActionType(type), true);
        assert.equal(isWorkspaceAction(action(type, 'ws')), true);
        assert.equal(classifyActionRoute(action(type, 'ws')), 'workspace');
        assert.equal(classifyActionRoute(action(type)), 'workspace');
    }
});
