import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createWorkspaceHarness } from '../../helpers/workspace_harness';
import { handleRuntimeControlAction } from '../../../src/runtime/control_plane';
import { createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs } from '../../../src/workflow';
import { isRequestActionType } from '../../../src/actions/action_types';
import {ActionError, ERROR_CODES} from '../../../src/actions/results';
import {setRunStepsDeps} from '../../../src/runner/run_steps';

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const cleanup = (name: string) => { try { deleteWorkflowFromFs(name); } catch {} };

test('workflow lifecycle actions are handled by runtime control', async () => {
    const { registry } = createWorkspaceHarness();
    const workflowName = uniqueName('wf-main4');
    const renamed = uniqueName('wf-main4-renamed');
    cleanup(workflowName);
    cleanup(renamed);

    const created = await handleRuntimeControlAction({
        action: { v: 1, id: '1', type: 'workflow.create', payload: { workflowName } },
        workspaceRegistry: registry,
    } as any);
    assert.equal(created.reply.type, 'workflow.create.result');
    const createdWorkspace = registry.getWorkspace(workflowName);
    assert.ok(createdWorkspace);
    createdWorkspace.browserSession.start = async () => undefined;

    const listed = await handleRuntimeControlAction({
        action: { v: 1, id: '2', type: 'workflow.list' },
        workspaceRegistry: registry,
    } as any);
    assert.equal(listed.reply.type, 'workflow.list.result');

    const opened = await handleRuntimeControlAction({
        action: { v: 1, id: '3', type: 'workflow.open', payload: { workflowName } },
        workspaceRegistry: registry,
    } as any);
    assert.equal(opened.reply.type, 'workflow.open.result');
    assert.equal(registry.getWorkspace(workflowName)?.tabs.listTabs().length, 1);

    const renamedReply = await handleRuntimeControlAction({
        action: { v: 1, id: '4', type: 'workflow.rename', payload: { fromName: workflowName, toName: renamed } },
        workspaceRegistry: registry,
    } as any);
    assert.equal(renamedReply.reply.type, 'workflow.rename.result');
    cleanup(workflowName);
    cleanup(renamed);
});

test('workflow.open opens a tab only for tabless workspace', async () => {
    const { registry } = createWorkspaceHarness();
    const workflowName = uniqueName('wf-open-tab');
    cleanup(workflowName);
    const workflow = createWorkflowOnFs(workflowName);
    const preparedWorkspace = registry.createWorkspace(workflowName, workflow);
    preparedWorkspace.browserSession.start = async () => undefined;

    const opened = await handleRuntimeControlAction({
        action: { v: 1, id: 'open-tab-1', type: 'workflow.open', payload: { workflowName } },
        workspaceRegistry: registry,
    } as any);
    assert.equal(opened.reply.type, 'workflow.open.result');
    assert.equal((opened.reply.payload as Record<string, unknown>).workspaceName, workflowName);
    assert.equal(registry.getActiveWorkspace()?.name, workflowName);
    assert.deepEqual(opened.events.map((event) => event.type), ['workspace.changed']);

    const workspace = registry.getWorkspace(workflowName);
    assert.ok(workspace);
    assert.equal(workspace.tabs.listTabs().length, 1);
    workspace.tabs.createTab({ tabName: 'tab-existing' });

    const reopened = await handleRuntimeControlAction({
        action: { v: 1, id: 'open-tab-2', type: 'workflow.open', payload: { workflowName } },
        workspaceRegistry: registry,
    } as any);
    assert.deepEqual(reopened.events.map((event) => event.type), ['workspace.changed']);
    assert.equal(workspace.tabs.listTabs().length, 2);
    cleanup(workflowName);
});

test('dsl actions are handled by dsl control', async () => {
    const { registry } = createWorkspaceHarness();
    const name = uniqueName('wf-dsl');
    cleanup(name);
    const workflow = createWorkflowOnFs(name);
    workflow.save({ kind: 'dsl', name: 'main', content: '' } as any);
    workflow.save({
        kind: 'checkpoint',
        name: 'cp-1',
        checkpoint: { id: 'cp-1', trigger: { matchRules: [{ errorCode: 'ERR_SAMPLE' }] } },
        stepResolves: {},
        hints: {},
    } as any);
    const ws = registry.createWorkspace(name, workflow);

    const got = await ws.router.handle({ v: 1, id: 'd1', type: 'dsl.get', workspaceName: name } as any, ws as any, registry as any);
    assert.equal(got.reply.type, 'dsl.get.result');

    const saved = await ws.router.handle({ v: 1, id: 'd2', type: 'dsl.save', workspaceName: name, payload: { content: '' } } as any, ws as any, registry as any);
    assert.equal(saved.reply.type, 'dsl.save.result');

    const tested = await ws.router.handle({ v: 1, id: 'd3', type: 'dsl.test', workspaceName: name, payload: { input: { a: 1 } } } as any, ws as any, registry as any);
    assert.equal(tested.reply.type, 'dsl.test.result');

    const ran = await ws.router.handle({ v: 1, id: 'd4', type: 'dsl.run', workspaceName: name, payload: { input: { b: 2 } } } as any, ws as any, registry as any);
    assert.equal(ran.reply.type, 'dsl.run.result');

    cleanup(name);
});

test('workflow.dsl.* and workflow.releaseRun are not request actions', () => {
    assert.equal(isRequestActionType('workflow.dsl.get'), false);
    assert.equal(isRequestActionType('workflow.dsl.save'), false);
    assert.equal(isRequestActionType('workflow.dsl.test'), false);
    assert.equal(isRequestActionType('workflow.releaseRun'), false);
});

test('workspace.close removes runtime and workflow.open rebuilds it from persisted workflow', async () => {
    const { registry } = createWorkspaceHarness();
    const name = uniqueName('wf-close-reopen');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        workflow.save({ kind: 'dsl', name: 'main', content: 'wait 1' } as any);
        const workspace = registry.createWorkspace(name, workflow);
        workspace.browserSession.stop = async () => undefined;

        const closed = await handleRuntimeControlAction({
            action: { v: 1, id: 'close-1', type: 'workspace.close', payload: { workspaceName: name } },
            workspaceRegistry: registry,
        } as any);
        assert.equal(closed.reply.type, 'workspace.close.result');
        assert.equal(registry.getWorkspace(name), null);

        const originalCreateWorkspace = registry.createWorkspace.bind(registry);
        registry.createWorkspace = ((workspaceName: string, loadedWorkflow: any) => {
            const next = originalCreateWorkspace(workspaceName, loadedWorkflow);
            next.browserSession.start = async () => undefined;
            return next;
        }) as typeof registry.createWorkspace;

        const reopened = await handleRuntimeControlAction({
            action: { v: 1, id: 'open-after-close', type: 'workflow.open', payload: { workflowName: name } },
            workspaceRegistry: registry,
        } as any);
        assert.equal(reopened.reply.type, 'workflow.open.result');
        const rebuilt = registry.getWorkspace(name);
        assert.ok(rebuilt);
        assert.notEqual(rebuilt, workspace);
        assert.equal(rebuilt.workflow.get('main', { kind: 'dsl' })?.kind, 'dsl');
    } finally {
        cleanup(name);
    }
});

test('an active task run owns the workspace and blocks DSL and destructive lifecycle actions', async () => {
    const {registry, runStepsDeps} = createWorkspaceHarness();
    setRunStepsDeps(runStepsDeps);
    const source = uniqueName('wf-execution-owner');
    const target = uniqueName('wf-execution-owner-renamed');
    const runId = uniqueName('workspace-owner-run');
    cleanup(source);
    cleanup(target);
    try {
        const workflow = createWorkflowOnFs(source);
        workflow.save({kind: 'dsl', name: 'main', content: 'wait 1', stepResolves: {}});
        const workspace = registry.createWorkspace(source, workflow);

        await workspace.router.handle({
            v: 1, id: 'task-owner-start', type: 'task.run.start', workspaceName: source, payload: {runId},
        } as any, workspace as any, registry as any);
        assert.equal(workspace.state, 'executing');

        await assert.rejects(
            () => workspace.router.handle({
                v: 1, id: 'dsl-while-task', type: 'dsl.run', workspaceName: source,
            } as any, workspace as any, registry as any),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
        );
        await assert.rejects(
            () => handleRuntimeControlAction({
                action: {v: 1, id: 'close-while-task', type: 'workspace.close', payload: {workspaceName: source}},
                workspaceRegistry: registry,
            } as any),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
        );
        await assert.rejects(
            () => handleRuntimeControlAction({
                action: {v: 1, id: 'rename-while-task', type: 'workflow.rename', payload: {fromName: source, toName: target}},
                workspaceRegistry: registry,
            } as any),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
        );
        assert.equal(registry.getWorkspace(source), workspace);
        assert.equal(registry.getWorkspace(target), null);

        await workspace.router.handle({
            v: 1, id: 'task-owner-halt', type: 'task.run.halt', workspaceName: source, payload: {runId},
        } as any, workspace as any, registry as any);
        assert.equal(workspace.state, 'idle');
    } finally {
        const workspace = registry.getWorkspace(source);
        if (workspace?.state === 'executing') {
            try {
                await workspace.router.handle({
                    v: 1, id: 'task-owner-cleanup', type: 'task.run.halt', workspaceName: source,
                    payload: {runId},
                } as any, workspace as any, registry as any);
            } catch {}
        }
        cleanup(source);
        cleanup(target);
    }
});

test('workflow.resetDefault refuses to replace a workspace owned by an active task run', async () => {
    const {registry, runStepsDeps} = createWorkspaceHarness();
    setRunStepsDeps(runStepsDeps);
    const runId = uniqueName('default-owner-run');
    cleanup('default');
    try {
        const workflow = createWorkflowOnFs('default');
        const workspace = registry.createWorkspace('default', workflow);
        await workspace.router.handle({
            v: 1, id: 'default-owner-start', type: 'task.run.start', workspaceName: 'default', payload: {runId},
        } as any, workspace as any, registry as any);

        await assert.rejects(
            () => handleRuntimeControlAction({
                action: {v: 1, id: 'reset-while-task', type: 'workflow.resetDefault', payload: {}},
                workspaceRegistry: registry,
            } as any),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
        );
        assert.equal(registry.getWorkspace('default'), workspace);

        await workspace.router.handle({
            v: 1, id: 'default-owner-halt', type: 'task.run.halt', workspaceName: 'default', payload: {runId},
        } as any, workspace as any, registry as any);
        assert.equal(workspace.state, 'idle');
    } finally {
        const workspace = registry.getWorkspace('default');
        if (workspace?.state === 'executing') {
            try {
                await workspace.router.handle({
                    v: 1, id: 'default-owner-cleanup', type: 'task.run.halt', workspaceName: 'default', payload: {runId},
                } as any, workspace as any, registry as any);
            } catch {}
        }
        cleanup('default');
    }
});

test('workflow.open creates a blank page instead of navigating to a placeholder site', async () => {
    const startUrls: Array<string | undefined> = [];
    const { registry } = createWorkspaceHarness({
        getPage: async (_tabName, startUrl) => {
            startUrls.push(startUrl);
            return {
                url: () => startUrl || 'about:blank',
                isClosed: () => false,
                close: async () => undefined,
            } as any;
        },
    });
    const name = uniqueName('wf-blank-open');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        const workspace = registry.createWorkspace(name, workflow);
        workspace.browserSession.start = async () => undefined;
        const opened = await handleRuntimeControlAction({
            action: { v: 1, id: 'blank-open', type: 'workflow.open', payload: { workflowName: name } },
            workspaceRegistry: registry,
        } as any);
        assert.equal(opened.reply.type, 'workflow.open.result');
        assert.deepEqual(startUrls, ['about:blank']);
    } finally {
        cleanup(name);
    }
});

test('workflow.saveAs copies DSL and checkpoint without sharing later mutations', async () => {
    const { registry } = createWorkspaceHarness();
    const source = uniqueName('wf-save-as-source');
    const target = uniqueName('wf-save-as-target');
    cleanup(source);
    cleanup(target);
    try {
        const sourceWorkflow = createWorkflowOnFs(source);
        sourceWorkflow.save({ kind: 'dsl', name: 'main', content: 'use checkpoint "shared"' } as any);
        sourceWorkflow.save({
            kind: 'checkpoint',
            name: 'shared',
            checkpoint: { id: 'shared', trigger: { matchRules: [{ errorCode: 'ERR_UNUSED' }] }, output: { source: 'original' } },
            stepResolves: {},
            hints: {},
        } as any);
        registry.createWorkspace(source, sourceWorkflow);

        const savedAs = await handleRuntimeControlAction({
            action: { v: 1, id: 'save-as', type: 'workflow.saveAs', payload: { sourceName: source, targetName: target } },
            workspaceRegistry: registry,
        } as any);
        assert.equal(savedAs.reply.type, 'workflow.saveAs.result');
        const targetWorkspace = registry.getWorkspace(target);
        assert.ok(targetWorkspace);
        assert.equal(targetWorkspace.workflow.get('main', { kind: 'dsl' })?.kind, 'dsl');
        assert.equal(targetWorkspace.workflow.get('shared', { kind: 'checkpoint' })?.kind, 'checkpoint');

        sourceWorkflow.save({ kind: 'dsl', name: 'main', content: 'wait 999' } as any);
        const copiedDsl = targetWorkspace.workflow.get('main', { kind: 'dsl' });
        assert.equal(copiedDsl?.kind, 'dsl');
        assert.equal(copiedDsl?.content, 'use checkpoint "shared"');
    } finally {
        cleanup(source);
        cleanup(target);
    }
});

test('workflow.rename migrates artifact providers and removes the old identity', async () => {
    const { registry } = createWorkspaceHarness();
    const source = uniqueName('wf-rename-source');
    const target = uniqueName('wf-rename-target');
    cleanup(source);
    cleanup(target);
    try {
        const workflow = createWorkflowOnFs(source);
        workflow.save({ kind: 'dsl', name: 'main', content: 'wait 1' } as any);
        workflow.save({
            kind: 'checkpoint',
            name: 'shared',
            checkpoint: { id: 'shared', trigger: { matchRules: [{ errorCode: 'ERR_UNUSED' }] }, output: { renamed: true } },
            stepResolves: {},
            hints: {},
        } as any);
        const workspace = registry.createWorkspace(source, workflow);
        workspace.browserSession.stop = async () => undefined;

        const renamed = await handleRuntimeControlAction({
            action: { v: 1, id: 'rename-artifacts', type: 'workflow.rename', payload: { fromName: source, toName: target } },
            workspaceRegistry: registry,
        } as any);
        assert.equal(renamed.reply.type, 'workflow.rename.result');
        assert.equal(registry.getWorkspace(source), null);
        const renamedWorkspace = registry.getWorkspace(target);
        assert.ok(renamedWorkspace);
        assert.equal(renamedWorkspace.name, target);
        assert.equal(renamedWorkspace.workflow.name, target);
        assert.equal(renamedWorkspace.workflow.get('main', { kind: 'dsl' })?.kind, 'dsl');
        assert.equal(renamedWorkspace.checkpoint.getProvider(renamedWorkspace.workflow).getCheckpoint('shared')?.id, 'shared');
        assert.throws(() => loadWorkflowFromFs(source), /workflow not found/);
    } finally {
        cleanup(source);
        cleanup(target);
    }
});

test('workflow.rename preflight failures do not stop the source runtime', async () => {
    const {registry} = createWorkspaceHarness();
    const source = uniqueName('wf-rename-preflight-source');
    const target = uniqueName('wf-rename-preflight-target');
    cleanup(source);
    cleanup(target);
    try {
        const workspace = registry.createWorkspace(source, createWorkflowOnFs(source));
        createWorkflowOnFs(target);
        const stops: string[] = [];
        workspace.mcp.stop = async () => {
            stops.push('mcp');
            return {serviceName: 'mcp', workspaceName: source, status: 'stopped'};
        };
        (workspace.runner as any).stop = async () => {stops.push('runner');};
        workspace.browserSession.stop = async () => {stops.push('browser');};

        await assert.rejects(() => handleRuntimeControlAction({
            action: {v: 1, id: 'rename-preflight', type: 'workflow.rename', payload: {fromName: source, toName: target}},
            workspaceRegistry: registry,
        } as any));

        assert.deepEqual(stops, []);
        assert.equal(registry.getWorkspace(source), workspace);
        assert.equal(registry.getWorkspace(target), null);
    } finally {
        cleanup(source);
        cleanup(target);
    }
});

test('workflow.resetDefault discards persisted artifacts and creates a fresh default runtime', async () => {
    const { registry } = createWorkspaceHarness();
    cleanup('default');
    try {
        const workflow = createWorkflowOnFs('default');
        workflow.save({ kind: 'dsl', name: 'main', content: 'wait 1' } as any);
        const previous = registry.createWorkspace('default', workflow);
        let mcpStops = 0;
        previous.mcp.stop = async () => {
            mcpStops += 1;
            return { serviceName: 'mcp', workspaceName: 'default', status: 'stopped' };
        };
        previous.browserSession.stop = async () => undefined;

        const reset = await handleRuntimeControlAction({
            action: { v: 1, id: 'reset-default', type: 'workflow.resetDefault', payload: {} },
            workspaceRegistry: registry,
        } as any);
        assert.equal(reset.reply.type, 'workflow.resetDefault.result');
        const current = registry.getWorkspace('default');
        assert.ok(current);
        assert.notEqual(current, previous);
        assert.equal(mcpStops, 1);
        assert.deepEqual(current.workflow.list({ kind: 'dsl' }), []);
        assert.deepEqual(current.workflow.list({ kind: 'checkpoint' }), []);
    } finally {
        cleanup('default');
    }
});

test('workflow lifecycle stops MCP runner and browser services before removing or replacing runtimes', async () => {
    const { registry } = createWorkspaceHarness();
    const closeName = uniqueName('wf-mcp-close');
    const renameSource = uniqueName('wf-mcp-rename-source');
    const renameTarget = uniqueName('wf-mcp-rename-target');
    cleanup(closeName);
    cleanup(renameSource);
    cleanup(renameTarget);

    try {
        const closeWorkspace = registry.createWorkspace(closeName, createWorkflowOnFs(closeName));
        let closeMcpStops = 0;
        let closeRunnerStops = 0;
        const closeOrder: string[] = [];
        closeWorkspace.mcp.stop = async () => {
            closeMcpStops += 1;
            closeOrder.push('mcp');
            return { serviceName: 'mcp', workspaceName: closeName, status: 'stopped' };
        };
        (closeWorkspace.runner as any).stop = async () => {
            closeRunnerStops += 1;
            closeOrder.push('runner');
        };
        closeWorkspace.browserSession.stop = async () => {closeOrder.push('browser');};

        await handleRuntimeControlAction({
            action: { v: 1, id: 'mcp-close', type: 'workspace.close', payload: { workspaceName: closeName } },
            workspaceRegistry: registry,
        } as any);
        assert.equal(closeMcpStops, 1);
        assert.equal(closeRunnerStops, 1);
        assert.deepEqual(closeOrder, ['mcp', 'runner', 'browser']);
        assert.equal(registry.getWorkspace(closeName), null);

        const renameWorkspace = registry.createWorkspace(renameSource, createWorkflowOnFs(renameSource));
        let renameMcpStops = 0;
        let renameRunnerStops = 0;
        const renameOrder: string[] = [];
        renameWorkspace.mcp.stop = async () => {
            renameMcpStops += 1;
            renameOrder.push('mcp');
            return { serviceName: 'mcp', workspaceName: renameSource, status: 'stopped' };
        };
        (renameWorkspace.runner as any).stop = async () => {
            renameRunnerStops += 1;
            renameOrder.push('runner');
        };
        renameWorkspace.browserSession.stop = async () => {renameOrder.push('browser');};

        await handleRuntimeControlAction({
            action: { v: 1, id: 'mcp-rename', type: 'workflow.rename', payload: { fromName: renameSource, toName: renameTarget } },
            workspaceRegistry: registry,
        } as any);
        assert.equal(renameMcpStops, 1);
        assert.equal(renameRunnerStops, 1);
        assert.deepEqual(renameOrder, ['mcp', 'runner', 'browser']);
        assert.equal(registry.getWorkspace(renameSource), null);
        assert.equal(registry.getWorkspace(renameTarget)?.mcp.status().status, 'stopped');

    } finally {
        cleanup(closeName);
        cleanup(renameSource);
        cleanup(renameTarget);
    }
});

test('workflow.open creates a live managed tab when bootstrap reporting left only an unbound placeholder', async () => {
    const openedUrls: Array<string | undefined> = [];
    const {registry} = createWorkspaceHarness({
        getPage: async (_tabName, startUrl) => {
            openedUrls.push(startUrl);
            return {
                url: () => startUrl || 'about:blank',
                isClosed: () => false,
                close: async () => undefined,
            } as any;
        },
    });
    const name = uniqueName('wf-bootstrap-placeholder');
    cleanup(name);
    try {
        const workflow = createWorkflowOnFs(name);
        const workspace = registry.createWorkspace(name, workflow);
        workspace.browserSession.start = async () => undefined;
        workspace.tabs.createTab({tabName: 'bootstrap-placeholder'});

        const opened = await handleRuntimeControlAction({
            action: {v: 1, id: 'bootstrap-open', type: 'workflow.open', payload: {workflowName: name}},
            workspaceRegistry: registry,
        } as any);

        assert.equal(opened.reply.type, 'workflow.open.result');
        const tabs = workspace.tabs.listTabs();
        assert.equal(tabs.length, 2);
        assert.equal(tabs.some((tab) => tab.page && !tab.page.isClosed()), true);
        assert.deepEqual(openedUrls, ['about:blank']);
    } finally {
        cleanup(name);
    }
});
