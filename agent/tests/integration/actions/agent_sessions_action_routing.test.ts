import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import {classifyActionRoute, isWorkspaceAction} from '../../../src/interface/actions/classify';
import {REQUEST_ACTION_TYPES, isRequestActionType} from '../../../src/interface/actions/action_types';
import type {Action} from '../../../src/interface/actions/action_protocol';

const repoRoot = path.resolve(process.cwd(), '..');

const action = (type: string, workspaceName?: string): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName,
});

const SESSION_TYPES = [
    'agent.sessions.start',
    'agent.sessions.list',
    'agent.sessions.status',
    'agent.sessions.cancel',
    'agent.sessions.report',
    'agent.sessions.prune',
] as const;

test('agent.sessions endpoint actions are registered as request actions', () => {
    assert.equal(REQUEST_ACTION_TYPES.AGENT_SESSIONS_START, 'agent.sessions.start');
    assert.equal(REQUEST_ACTION_TYPES.AGENT_SESSIONS_LIST, 'agent.sessions.list');
    assert.equal(REQUEST_ACTION_TYPES.AGENT_SESSIONS_STATUS, 'agent.sessions.status');
    assert.equal(REQUEST_ACTION_TYPES.AGENT_SESSIONS_CANCEL, 'agent.sessions.cancel');
    assert.equal(REQUEST_ACTION_TYPES.AGENT_SESSIONS_REPORT, 'agent.sessions.report');
    assert.equal(REQUEST_ACTION_TYPES.AGENT_SESSIONS_PRUNE, 'agent.sessions.prune');
    for (const type of SESSION_TYPES) {
        assert.equal(isRequestActionType(type), true, `${type} must be a request action`);
    }
});

test('agent.sessions commands are classified as workspace-scoped', () => {
    for (const type of SESSION_TYPES) {
        assert.equal(classifyActionRoute(action(type, 'ws-1')), 'workspace', `${type} with workspaceName`);
        assert.equal(classifyActionRoute(action(type)), 'workspace', `${type} without workspaceName`);
        assert.equal(isWorkspaceAction(action(type, 'ws-1')), true, `${type} is a workspace action`);
    }
});

test('agent.sessions reply types are derived replies', async () => {
    const {isReplyActionType} = await import('../../../src/interface/actions/action_types');
    for (const type of SESSION_TYPES) {
        assert.equal(isReplyActionType(`${type}.result`), true);
        assert.equal(isReplyActionType(`${type}.failed`), true);
    }
});

test('extension action registry matches agent for agent.sessions', async () => {
    const extTypes = await import(path.resolve(repoRoot, 'extension/src/actions/action_types.ts'));
    const extClassify = await import(path.resolve(repoRoot, 'extension/src/actions/classify.ts'));
    for (const type of SESSION_TYPES) {
        assert.equal(extTypes.isRequestActionType(type), true, `extension: ${type} must be registered`);
        assert.equal(extTypes.classifyActionType(type), 'command', `extension: ${type} classifies as command`);
        assert.equal(
            extClassify.classifyActionRoute(action(type, 'ws-1')),
            'workspace',
            `extension: ${type} with workspaceName routes to workspace`,
        );
        assert.equal(
            extClassify.classifyActionRoute(action(type)),
            'workspace',
            `extension: ${type} without workspaceName routes to workspace`,
        );
    }
});

test('extension envelope accepts agent.sessions commands as workspace commands', async () => {
    const {validateActionEnvelope} = await import(path.resolve(repoRoot, 'extension/src/actions/envelope.ts'));
    for (const type of SESSION_TYPES) {
        const ok = validateActionEnvelope({v: 1, id: 'req-1', type, workspaceName: 'ws-1', payload: {}});
        assert.equal(ok.ok, true, `${type} envelope must validate`);
    }
    for (const type of SESSION_TYPES) {
        const ok = validateActionEnvelope({v: 1, id: 'req-2', type, payload: {}});
        assert.equal(ok.ok, true, `${type} envelope must validate without workspaceName`);
    }
});

test('extension dispatcher routes agent.sessions.start to the workspace gateway', async () => {
    const {dispatchActionRequest} = await import(path.resolve(repoRoot, 'extension/src/actions/dispatcher.ts'));
    const calls: string[] = [];
    const wsClient = {
        sendAction: async (sent: {type: string}) => {
            calls.push(sent.type);
            return {v: 1, id: 'reply-1', type: `${sent.type}.result`, replyTo: 'req-1', payload: {}};
        },
    };
    const reply = await dispatchActionRequest(
        {v: 1, id: 'req-1', type: 'agent.sessions.start', workspaceName: 'ws-1', payload: {prompt: 'p', provider: 'prov', model: 'm'}},
        wsClient as never,
    );
    assert.equal(reply.type, 'agent.sessions.start.result');
    assert.deepEqual(calls, ['agent.sessions.start']);
});

test('extension dispatcher routes agent.sessions.report to the workspace gateway', async () => {
    const {dispatchActionRequest} = await import(path.resolve(repoRoot, 'extension/src/actions/dispatcher.ts'));
    const calls: string[] = [];
    const wsClient = {
        sendAction: async (sent: {type: string}) => {
            calls.push(sent.type);
            return {v: 1, id: 'reply-2', type: `${sent.type}.result`, replyTo: 'req-2', payload: {}};
        },
    };
    const reply = await dispatchActionRequest(
        {v: 1, id: 'req-2', type: 'agent.sessions.report', workspaceName: 'ws-1', payload: {sessionId: 'session-1'}},
        wsClient as never,
    );
    assert.equal(reply.type, 'agent.sessions.report.result');
    assert.deepEqual(calls, ['agent.sessions.report']);
});

test('extension dispatcher routes agent.sessions.prune to the workspace gateway', async () => {
    const {dispatchActionRequest} = await import(path.resolve(repoRoot, 'extension/src/actions/dispatcher.ts'));
    const calls: string[] = [];
    const wsClient = {
        sendAction: async (sent: {type: string}) => {
            calls.push(sent.type);
            return {v: 1, id: 'reply-3', type: `${sent.type}.result`, replyTo: 'req-3', payload: {}};
        },
    };
    const reply = await dispatchActionRequest(
        {v: 1, id: 'req-3', type: 'agent.sessions.prune', workspaceName: 'ws-1', payload: {maxCount: 20}},
        wsClient as never,
    );
    assert.equal(reply.type, 'agent.sessions.prune.result');
    assert.deepEqual(calls, ['agent.sessions.prune']);
});