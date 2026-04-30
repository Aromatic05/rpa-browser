import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActionTarget } from '../../src/runtime/action_target';
import type { Action } from '../../src/actions/action_protocol';

const createRegistry = () => {
    const tokenScope = new Map<string, { workspaceId: string; tabId: string }>([
        ['token-a', { workspaceId: 'ws-1', tabId: 'tab-1' }],
        ['token-b', { workspaceId: 'ws-1', tabId: 'tab-2' }],
    ]);
    return {
        resolveScopeFromToken: (token: string) => {
            const scope = tokenScope.get(token);
            if (!scope) {throw new Error('not found');}
            return scope;
        },
        resolveScope: (scope?: { workspaceId?: string; tabId?: string }) => ({
            workspaceId: scope?.workspaceId || 'ws-1',
            tabId: scope?.tabId || 'tab-1',
        }),
        resolveTabToken: (scope?: { workspaceId?: string; tabId?: string }) => {
            if (scope?.workspaceId === 'ws-1' && scope?.tabId === 'tab-2') {return 'token-b';}
            return 'token-a';
        },
    } as any;
};

test('resolveActionTarget prefers tabToken and validates scope consistency', () => {
    const action: Action = {
        v: 1,
        id: '1',
        type: 'record.start',
        workspaceName: 'ws-1',
    };
    const target = resolveActionTarget(action, createRegistry());
    assert.equal(target.tabToken, 'token-a');
    assert.equal(target.scope.workspaceId, 'ws-1');
    assert.equal(target.scope.tabId, 'tab-1');
});

test('resolveActionTarget throws when workspaceName is missing in workspace path', () => {
    const action: Action = {
        v: 1,
        id: '2',
        type: 'record.start',
    };
    const target = resolveActionTarget(action, createRegistry());
    assert.equal(target, null);
});

test('resolveActionTarget returns null when workspaceName is missing', () => {
    const action: Action = {
        v: 1,
        id: '3',
        type: 'workspace.create',
    };
    const target = resolveActionTarget(action, createRegistry());
    assert.equal(target, null);
});

test('resolveActionTarget throws when workspaceName cannot be resolved', () => {
    const action: Action = {
        v: 1,
        id: '4',
        type: 'tab.activated',
        workspaceName: 'ws-missing',
    };
    const registry = {
        resolveScope: () => { throw new Error('not found'); },
    } as any;
    assert.throws(() => resolveActionTarget(action, registry), /workspace scope not found for workspaceName/);
});
