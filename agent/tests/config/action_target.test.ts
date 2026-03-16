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
            if (!scope) throw new Error('not found');
            return scope;
        },
        resolveScope: (scope?: { workspaceId?: string; tabId?: string }) => ({
            workspaceId: scope?.workspaceId || 'ws-1',
            tabId: scope?.tabId || 'tab-1',
        }),
        resolveTabToken: (scope?: { workspaceId?: string; tabId?: string }) => {
            if (scope?.workspaceId === 'ws-1' && scope?.tabId === 'tab-2') return 'token-b';
            return 'token-a';
        },
    } as any;
};

test('resolveActionTarget prefers tabToken and validates scope consistency', () => {
    const action: Action = {
        v: 1,
        id: '1',
        type: 'record.start',
        tabToken: 'token-b',
        scope: { workspaceId: 'ws-1', tabId: 'tab-2' },
    };
    const target = resolveActionTarget(action, createRegistry());
    assert.equal(target.tabToken, 'token-b');
    assert.equal(target.scope.workspaceId, 'ws-1');
    assert.equal(target.scope.tabId, 'tab-2');
});

test('resolveActionTarget throws when scope and tabToken mismatch', () => {
    const action: Action = {
        v: 1,
        id: '2',
        type: 'record.start',
        tabToken: 'token-a',
        scope: { workspaceId: 'ws-1', tabId: 'tab-2' },
    };
    assert.throws(() => resolveActionTarget(action, createRegistry()), /scope\.tabId does not match tabToken/);
});
