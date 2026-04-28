import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkflowWorkspace } from '../../src/workflow';

test('restoreOnly fails when restore errors', async () => {
    await assert.rejects(
        () =>
            resolveWorkflowWorkspace(
                {
                    pageRegistry: {} as any,
                    restoreWorkspace: async () => {
                        throw new Error('no snapshot');
                    },
                },
                {
                    scene: 'order',
                    binding: {
                        version: 1,
                        workspace: { strategy: 'restoreOnly' },
                    },
                },
            ),
        /ERR_WORKFLOW_WORKSPACE_RESOLVE_FAILED|workflow workspace resolve failed/,
    );
});

test('createOnly uses create workspace path', async () => {
    let created = false;
    let shellCalled = false;
    const result = await resolveWorkflowWorkspace(
        {
            pageRegistry: {
                createWorkspace: async () => {
                    created = true;
                    return { workspaceId: 'ws-1', tabId: 'tab-1' };
                },
                resolveTabToken: () => 'tk-1',
                createWorkspaceShell: () => {
                    shellCalled = true;
                    return { workspaceId: 'workflow:order' };
                },
                resolvePage: async () => ({ url: () => 'http://a', goto: async () => {} }),
            } as any,
            restoreWorkspace: async () => ({ workspaceId: 'ws-x', tabId: 'tab-x', tabToken: 'tk-x' }),
        },
        {
            scene: 'order',
            binding: {
                version: 1,
                workspace: { strategy: 'createOnly', entryUrl: 'http://a' },
            },
        },
    );
    assert.equal(created, true);
    assert.equal(shellCalled, false);
    assert.equal(result.workspaceId, 'ws-1');
});

test('restoreOrCreate tries restore first then create', async () => {
    let restoreCalled = 0;
    let createCalled = 0;
    const result = await resolveWorkflowWorkspace(
        {
            pageRegistry: {
                createWorkspace: async () => {
                    createCalled += 1;
                    return { workspaceId: 'ws-created', tabId: 'tab-created' };
                },
                resolveTabToken: () => 'tk-created',
                resolvePage: async () => ({ url: () => 'http://a', goto: async () => {} }),
            } as any,
            restoreWorkspace: async () => {
                restoreCalled += 1;
                throw new Error('missing');
            },
        },
        {
            scene: 'order',
            binding: {
                version: 1,
                workspace: { strategy: 'restoreOrCreate' },
            },
        },
    );
    assert.equal(restoreCalled, 1);
    assert.equal(createCalled, 1);
    assert.equal(result.workspaceId, 'ws-created');
});

test('expectedTabs urlIncludes validation succeeds', async () => {
    const result = await resolveWorkflowWorkspace(
        {
            pageRegistry: {
                createWorkspace: async () => ({ workspaceId: 'ws-created', tabId: 'tab-created' }),
                resolveTabToken: () => 'tk-created',
                resolvePage: async () => ({ url: () => 'http://localhost/orders/list', goto: async () => {} }),
            } as any,
            restoreWorkspace: async () => ({ workspaceId: 'ws-restore', tabId: 'tab-restore', tabToken: 'tk-restore' }),
        },
        {
            scene: 'order',
            binding: {
                version: 1,
                workspace: {
                    strategy: 'createOnly',
                    expectedTabs: [{ ref: 'main', urlIncludes: '/orders' }],
                },
            },
        },
    );
    assert.equal(result.workspaceId, 'ws-created');
});

test('expectedTabs exactUrl validation fails with ERR_WORKFLOW_WORKSPACE_RESOLVE_FAILED', async () => {
    await assert.rejects(
        () =>
            resolveWorkflowWorkspace(
                {
                    pageRegistry: {
                        createWorkspace: async () => ({ workspaceId: 'ws-created', tabId: 'tab-created' }),
                        resolveTabToken: () => 'tk-created',
                        resolvePage: async () => ({ url: () => 'http://localhost/orders/list', goto: async () => {} }),
                    } as any,
                    restoreWorkspace: async () => ({ workspaceId: 'ws-restore', tabId: 'tab-restore', tabToken: 'tk-restore' }),
                },
                {
                    scene: 'order',
                    binding: {
                        version: 1,
                        workspace: {
                            strategy: 'createOnly',
                            expectedTabs: [{ ref: 'main', exactUrl: 'http://localhost/orders/detail' }],
                        },
                    },
                },
            ),
        /ERR_WORKFLOW_WORKSPACE_RESOLVE_FAILED|workflow workspace resolve failed/,
    );
});
