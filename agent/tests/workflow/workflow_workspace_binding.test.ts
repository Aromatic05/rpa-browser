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
                    return { workspaceName: 'ws-1', tabName: 'tab-1' };
                },
                resolveTabName: () => 'tk-1',
                createWorkspaceShell: () => {
                    shellCalled = true;
                    return { workspaceName: 'workflow:order' };
                },
                resolvePage: async () => ({ url: () => 'http://a', goto: async () => {} }),
            } as any,
            restoreWorkspace: async () => ({ workspaceName: 'ws-x', tabName: 'tab-x' }),
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
    assert.equal(result.workspaceName, 'ws-1');
});

test('restoreOrCreate tries restore first then create', async () => {
    let restoreCalled = 0;
    let createCalled = 0;
    const result = await resolveWorkflowWorkspace(
        {
            pageRegistry: {
                createWorkspace: async () => {
                    createCalled += 1;
                    return { workspaceName: 'ws-created', tabName: 'tab-created' };
                },
                resolveTabName: () => 'tk-created',
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
    assert.equal(result.workspaceName, 'ws-created');
});

test('expectedTabs urlIncludes validation succeeds', async () => {
    const result = await resolveWorkflowWorkspace(
        {
            pageRegistry: {
                createWorkspace: async () => ({ workspaceName: 'ws-created', tabName: 'tab-created' }),
                resolveTabName: () => 'tk-created',
                resolvePage: async () => ({ url: () => 'http://localhost/orders/list', goto: async () => {} }),
            } as any,
            restoreWorkspace: async () => ({ workspaceName: 'ws-restore', tabName: 'tab-restore' }),
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
    assert.equal(result.workspaceName, 'ws-created');
});

test('expectedTabs exactUrl validation fails with ERR_WORKFLOW_WORKSPACE_RESOLVE_FAILED', async () => {
    await assert.rejects(
        () =>
            resolveWorkflowWorkspace(
                {
                    pageRegistry: {
                        createWorkspace: async () => ({ workspaceName: 'ws-created', tabName: 'tab-created' }),
                        resolveTabName: () => 'tk-created',
                        resolvePage: async () => ({ url: () => 'http://localhost/orders/list', goto: async () => {} }),
                    } as any,
                    restoreWorkspace: async () => ({ workspaceName: 'ws-restore', tabName: 'tab-restore' }),
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
