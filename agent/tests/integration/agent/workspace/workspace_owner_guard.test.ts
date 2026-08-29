import test from 'node:test';
import assert from 'node:assert/strict';
import type { Workflow } from '../../../../src/automation/workflow';
import type { WorkspaceServiceStopResult } from '../../../../src/automation/runtime/service/types';
import { ActionError, ERROR_CODES } from '../../../../src/interface/actions/results';
import { handleRuntimeControlAction } from '../../../../src/automation/runtime/control_plane';
import { acquireWorkspaceExecution, runWorkspaceExecution } from '../../../../src/automation/runtime/workspace/execution_coordinator';
import { createWorkspaceHarness } from '../../../helpers/workspace_harness';

const uniqueName = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

type StoppableWorkspace = {
    agent: { stop: () => Promise<WorkspaceServiceStopResult> };
    mcp: { stop: () => Promise<WorkspaceServiceStopResult> };
    runner: { stop: () => Promise<void> };
    browserSession: { stop: () => Promise<void> };
};

const stubStop = (workspace: StoppableWorkspace, name: string, order: string[]) => {
    workspace.agent.stop = async () => {
        order.push('agent');
        return { serviceName: 'agent', workspaceName: name, status: 'stopped' };
    };
    workspace.mcp.stop = async () => {
        order.push('mcp');
        return { serviceName: 'mcp', workspaceName: name, status: 'stopped' };
    };
    workspace.runner.stop = async () => {order.push('runner');};
    workspace.browserSession.stop = async () => {order.push('browserSession');};
};

const closeWorkspace = (registry: ReturnType<typeof createWorkspaceHarness>['registry'], name: string, id: string) =>
    handleRuntimeControlAction({
        action: { v: 1, id, type: 'workspace.close', payload: { workspaceName: name } },
        workspaceRegistry: registry,
    } as never);

test('registry.removeWorkspace rejects a paused owner hold and keeps the workspace registered', async () => {
    const { registry } = createWorkspaceHarness();
    const name = uniqueName('guard-remove');
    const workspace = registry.createWorkspace(name, { name } as Workflow);
    const hold = acquireWorkspaceExecution(workspace, 'agent.session.hold', { kind: 'agent', id: 'agent-keep', intent: 'paused' });

    assert.throws(
        () => registry.removeWorkspace(name),
        (error: unknown) => error instanceof ActionError
            && error.code === ERROR_CODES.ERR_BAD_STATE
            && error.message.includes('workspace.remove')
            && error.message.includes('agent-keep')
            && error.message.includes('intent=paused'),
    );
    assert.equal(registry.getWorkspace(name), workspace);

    hold();
    assert.equal(registry.removeWorkspace(name), workspace);
    assert.equal(registry.getWorkspace(name), null);
});

test('registry blocks remove and rename for an active execution owner mid-run', async () => {
    const { registry } = createWorkspaceHarness();
    const name = uniqueName('guard-active');
    const targetName = uniqueName('guard-active-target');
    const workspace = registry.createWorkspace(name, { name } as Workflow);

    await runWorkspaceExecution(workspace, 'agent.program.start', async () => {
        assert.throws(
            () => registry.removeWorkspace(name),
            (error: unknown) => error instanceof ActionError
                && error.code === ERROR_CODES.ERR_BAD_STATE
                && error.message.includes('intent=active')
                && error.message.includes('agent'),
        );
        assert.throws(
            () => registry.renameWorkspace(name, targetName, { name: targetName } as Workflow),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
        );
        assert.equal(registry.getWorkspace(name), workspace);
    });

    assert.equal(registry.renameWorkspace(name, targetName, { name: targetName } as Workflow).name, targetName);
    assert.equal(registry.getWorkspace(name), null);
});

test('workspace.close shuts agent, mcp, runner, and browser services in the defined order', async () => {
    const { registry } = createWorkspaceHarness();
    const name = uniqueName('close-order');
    const workspace = registry.createWorkspace(name, { name } as Workflow);
    const order: string[] = [];
    stubStop(workspace, name, order);

    const result = await closeWorkspace(registry, name, 'close-order');
    assert.equal((result.reply.payload as { closed?: boolean }).closed, true);
    assert.deepEqual(order, ['agent', 'mcp', 'runner', 'browserSession']);
    assert.equal(registry.getWorkspace(name), null);
});

test('workspace.close shutdown continues past the first failing service and still blocks removal', async () => {
    const { registry } = createWorkspaceHarness();
    const name = uniqueName('close-error');
    const workspace = registry.createWorkspace(name, { name } as Workflow);
    const order: string[] = [];
    stubStop(workspace, name, order);
    workspace.agent.stop = async () => {order.push('agent'); throw new Error('agent-stop-failed');};

    await assert.rejects(() => closeWorkspace(registry, name, 'close-error'), /agent-stop-failed/);
    assert.deepEqual(order, ['agent', 'mcp', 'runner', 'browserSession']);
    assert.equal(registry.getWorkspace(name), workspace);
});

test('workspace.close rejects while an agent execution is active and leaves the runtime untouched', async () => {
    const { registry } = createWorkspaceHarness();
    const name = uniqueName('close-active');
    const workspace = registry.createWorkspace(name, { name } as Workflow);
    const order: string[] = [];
    stubStop(workspace, name, order);

    await runWorkspaceExecution(workspace, 'agent.program.start', async () => {
        await assert.rejects(
            () => closeWorkspace(registry, name, 'close-active'),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE,
        );
    });
    assert.deepEqual(order, []);
    assert.equal(registry.getWorkspace(name), workspace);
});

test('workspace.close cannot silently drop a paused agent hold: removal is refused at the registry', async () => {
    const { registry } = createWorkspaceHarness();
    const name = uniqueName('close-held');
    const workspace = registry.createWorkspace(name, { name } as Workflow);
    const hold = acquireWorkspaceExecution(workspace, 'agent.session.hold', { kind: 'agent', id: 'agent-held', intent: 'paused' });

    await assert.rejects(
        () => closeWorkspace(registry, name, 'close-held'),
        (error: unknown) => error instanceof ActionError
            && error.code === ERROR_CODES.ERR_BAD_STATE
            && error.message.includes('workspace.remove')
            && error.message.includes('agent-held'),
    );
    assert.equal(registry.getWorkspace(name), workspace);
    hold();
});
