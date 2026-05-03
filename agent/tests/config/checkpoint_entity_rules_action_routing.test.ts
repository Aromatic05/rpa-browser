import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionDispatcher } from '../../src/actions/dispatcher';
import { createWorkspaceRouter } from '../../src/runtime/workspace/router';
import { classifyRequestAction, isControlAction as isExtControlAction, isWorkspaceAction as isExtWorkspaceAction } from '../../../extension/src/actions/classify';

const action = (type: string, extra: Record<string, unknown> = {}) => ({ v: 1 as const, id: 'a1', type, ...extra });

test('checkpoint/entity_rules without workspaceName fail dispatch', async () => {
    const dispatcher = createActionDispatcher({
        workspaceRegistry: {
            getWorkspace: () => null,
            listWorkspaces: () => [],
            getActiveWorkspace: () => null,
        } as any,
        log: () => undefined,
    });

    const cp = await dispatcher.dispatch(action('checkpoint.list'));
    const er = await dispatcher.dispatch(action('entity_rules.list'));
    assert.equal(cp.type, 'checkpoint.list.failed');
    assert.equal(er.type, 'entity_rules.list.failed');
});

test('checkpoint/entity_rules with workspaceName route into workspace checkpoint/entityRules controls', async () => {
    const calls: string[] = [];
    const control = createWorkspaceRouter({
        pageRegistry: { getPage: async () => ({}) as any },
        workflowControl: { handle: async () => ({ reply: action('noop.result'), events: [] }) } as any,
        recordControl: { handle: async () => ({ reply: action('noop.result'), events: [] }) } as any,
        dslControl: { handle: async () => ({ reply: action('noop.result'), events: [] }) } as any,
        checkpointControl: {
            handle: async ({ action }) => {
                calls.push(action.type);
                return { reply: action as any, events: [] };
            },
        } as any,
        entityRulesControl: {
            handle: async ({ action }) => {
                calls.push(action.type);
                return { reply: action as any, events: [] };
            },
        } as any,
        runnerControl: { handle: async () => ({ reply: action('noop.result'), events: [] }) } as any,
    });

    const ws = {
        name: 'ws-1',
        workflow: { name: 'ws-1' },
        tabs: { getActiveTab: () => null, listTabs: () => [] },
    } as any;
    const registry = { getActiveWorkspace: () => ({ name: 'ws-1' }), setActiveWorkspace: () => undefined } as any;

    await control.handle(action('checkpoint.get', { workspaceName: 'ws-1', payload: { checkpointId: 'cp' } }) as any, ws, registry);
    await control.handle(action('entity_rules.get', { workspaceName: 'ws-1', payload: { profileName: 'p1' } }) as any, ws, registry);
    assert.deepEqual(calls, ['checkpoint.get', 'entity_rules.get']);
});

test('payload.workspaceName is rejected for checkpoint/entity_rules', async () => {
    const dispatcher = createActionDispatcher({
        workspaceRegistry: {
            getWorkspace: () => null,
            listWorkspaces: () => [],
            getActiveWorkspace: () => null,
        } as any,
        log: () => undefined,
    });

    const cp = await dispatcher.dispatch(action('checkpoint.list', { workspaceName: 'ws-1', payload: { workspaceName: 'bad' } }));
    const er = await dispatcher.dispatch(action('entity_rules.list', { workspaceName: 'ws-1', payload: { workspaceName: 'bad' } }));
    assert.equal(cp.type, 'checkpoint.list.failed');
    assert.equal(er.type, 'entity_rules.list.failed');
    assert.match(String((cp.payload as any)?.message || ''), /workspaceName/);
    assert.match(String((er.payload as any)?.message || ''), /workspaceName/);
});

test('extension classification marks checkpoint/entity_rules as workspace actions and not control', () => {
    assert.equal(classifyRequestAction('checkpoint.list'), 'workspace');
    assert.equal(classifyRequestAction('entity_rules.list'), 'workspace');
    assert.equal(isExtWorkspaceAction('checkpoint.save'), true);
    assert.equal(isExtWorkspaceAction('entity_rules.save'), true);
    assert.equal(isExtControlAction('checkpoint.list'), false);
    assert.equal(isExtControlAction('entity_rules.list'), false);
});
