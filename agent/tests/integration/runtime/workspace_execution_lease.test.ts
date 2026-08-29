import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionError, ERROR_CODES } from '../../../src/interface/actions/results';
import {
    acquireWorkspaceExecution,
    assertWorkspaceExecutionReplaceable,
    getWorkspaceExecutionLease,
    pauseWorkspaceExecution,
    resumeWorkspaceExecution,
    workspaceExecutionOwnerKind,
    type WorkspaceExecutionLease,
} from '../../../src/automation/runtime/workspace/execution_coordinator';
import { runWorkspaceExecution } from '../../../src/automation/runtime/workspace/workspace';
import type { RuntimeWorkspace } from '../../../src/automation/runtime/workspace/workspace';

type LeasedWorkspace = {
    name: string;
    state: 'idle' | 'recording' | 'playing' | 'executing';
    executionOwner: symbol | null;
    executionLease: WorkspaceExecutionLease | null;
    updatedAt: number;
};

const createWorkspace = (): RuntimeWorkspace => {
    const workspace: LeasedWorkspace = {
        name: 'ws-1',
        state: 'idle',
        executionOwner: null,
        executionLease: null,
        updatedAt: 0,
    };
    return workspace as unknown as RuntimeWorkspace;
};

const isBadState = (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_STATE;

test('owner kind derives from the action type prefix', () => {
    assert.equal(workspaceExecutionOwnerKind('agent.program.start'), 'agent');
    assert.equal(workspaceExecutionOwnerKind('mcp.tool.call'), 'mcp');
    assert.equal(workspaceExecutionOwnerKind('dsl.run'), 'dsl');
    assert.equal(workspaceExecutionOwnerKind('task.run.abort'), 'runner');
    assert.equal(workspaceExecutionOwnerKind('record.start'), 'recording');
    assert.equal(workspaceExecutionOwnerKind('play.start'), 'recording');
    assert.equal(workspaceExecutionOwnerKind('tab.closed'), 'control');
});

test('acquire publishes an immutable owner snapshot with kind, id, and startedAt', () => {
    const workspace = createWorkspace();
    const release = acquireWorkspaceExecution(workspace, 'task.run.start');
    const lease = getWorkspaceExecutionLease(workspace)!;
    assert.equal(lease.kind, 'runner');
    assert.equal(lease.id, 'task.run.start');
    assert.equal(lease.intent, 'active');
    assert.equal(typeof lease.startedAt, 'number');
    assert.equal(lease.token, release.token);
    assert.equal(workspace.state, 'executing');
    assert.ok(Object.isFrozen(lease));
    assert.throws(() => {
        (lease as { intent: string }).intent = 'paused';
    }, TypeError);
    release();
});

test('release transitions owner and state exactly once', () => {
    const workspace = createWorkspace();
    const release = acquireWorkspaceExecution(workspace, 'dsl.run');
    assert.equal(release.isReleased(), false);
    release();
    assert.equal(release.isReleased(), true);
    assert.equal(workspace.state, 'idle');
    assert.equal(workspace.executionOwner, null);
    assert.equal(getWorkspaceExecutionLease(workspace), null);
    release();
    assert.equal(workspace.state, 'idle');
});

test('a stale release cannot clear a lease re-acquired by a different owner', () => {
    const workspace = createWorkspace();
    const first = acquireWorkspaceExecution(workspace, 'dsl.run');
    workspace.executionOwner = null;
    workspace.state = 'idle';
    workspace.executionLease = null;
    const second = acquireWorkspaceExecution(workspace, 'task.run.start');
    first();
    assert.equal(getWorkspaceExecutionLease(workspace)?.token, second.token);
    assert.equal(workspace.state, 'executing');
    second();
    assert.equal(getWorkspaceExecutionLease(workspace), null);
    assert.equal(workspace.state, 'idle');
});

test('runWorkspaceExecution preserves pass-through, error release, and exclusivity', async () => {
    const workspace = createWorkspace();
    assert.equal(await runWorkspaceExecution(workspace, 'dsl.run', async () => 'value'), 'value');
    assert.equal(workspace.state, 'idle');
    assert.equal(getWorkspaceExecutionLease(workspace), null);

    await assert.rejects(
        () => runWorkspaceExecution(workspace, 'dsl.run', async () => {throw new Error('boom');}),
        /boom/,
    );
    assert.equal(workspace.state, 'idle');
    assert.equal(getWorkspaceExecutionLease(workspace), null);

    let innerReached = false;
    await assert.rejects(
        () => runWorkspaceExecution(workspace, 'dsl.run', async () =>
            runWorkspaceExecution(workspace, 'dsl.run', async () => {innerReached = true; return 1;}),
        ),
        isBadState,
    );
    assert.equal(innerReached, false);
    assert.equal(workspace.state, 'idle');
});

test('a paused owner hold keeps the workspace idle but blocks foreign execution', async () => {
    const workspace = createWorkspace();
    const hold = acquireWorkspaceExecution(workspace, 'agent.session.hold', { kind: 'agent', id: 'agent-1', intent: 'paused' });
    const heldLease = getWorkspaceExecutionLease(workspace)!;
    assert.equal(heldLease.intent, 'paused');
    assert.equal(heldLease.kind, 'agent');
    assert.equal(heldLease.id, 'agent-1');
    assert.equal(workspace.state, 'idle');

    let foreignReached = false;
    await assert.rejects(
        () => runWorkspaceExecution(workspace, 'dsl.run', async () => {foreignReached = true;}),
        (error: unknown) => isBadState(error)
            && error instanceof ActionError
            && error.message.includes('agent')
            && error.message.includes('agent-1')
            && error.message.includes('intent=paused'),
    );
    assert.equal(foreignReached, false);

    hold();
    assert.equal(getWorkspaceExecutionLease(workspace), null);
    assert.equal(await runWorkspaceExecution(workspace, 'dsl.run', async () => 'free'), 'free');
});

test('the same owner reactivates a paused hold without losing token or startedAt', async () => {
    const workspace = createWorkspace();
    const hold = acquireWorkspaceExecution(workspace, 'agent.session.hold', { kind: 'agent', id: 'agent-1', intent: 'paused' });
    const heldLease = getWorkspaceExecutionLease(workspace)!;

    let activeIntent: string | null = null;
    let activeState: string | null = null;
    let activeStartedAt: number | null = null;
    await runWorkspaceExecution(
        workspace,
        'agent.program.commit',
        async () => {
            const lease = getWorkspaceExecutionLease(workspace)!;
            activeIntent = lease.intent;
            activeState = workspace.state;
            activeStartedAt = lease.startedAt;
        },
        { kind: 'agent', id: 'agent-1' },
    );
    assert.equal(activeIntent, 'active');
    assert.equal(activeState, 'executing');
    assert.equal(activeStartedAt, heldLease.startedAt);

    const after = getWorkspaceExecutionLease(workspace)!;
    assert.equal(after.intent, 'paused');
    assert.equal(after.token, heldLease.token);
    assert.equal(after.startedAt, heldLease.startedAt);
    assert.equal(workspace.state, 'idle');

    hold();
    assert.equal(getWorkspaceExecutionLease(workspace), null);
});

test('pause and resume transition the intent only for the current owner token', () => {
    const workspace = createWorkspace();
    const release = acquireWorkspaceExecution(workspace, 'agent.program.start');
    const lease = getWorkspaceExecutionLease(workspace)!;

    const paused = pauseWorkspaceExecution(workspace, lease.token);
    assert.equal(paused.intent, 'paused');
    assert.equal(paused.token, lease.token);
    assert.equal(paused.startedAt, lease.startedAt);
    assert.ok(Object.isFrozen(paused));

    const resumed = resumeWorkspaceExecution(workspace, paused.token);
    assert.equal(resumed.intent, 'active');

    assert.throws(() => pauseWorkspaceExecution(workspace, Symbol('foreign')), isBadState);
    assert.throws(() => resumeWorkspaceExecution(workspace, Symbol('foreign')), isBadState);
    assert.equal(getWorkspaceExecutionLease(workspace)?.intent, 'active');

    release();
    assert.throws(() => pauseWorkspaceExecution(workspace, lease.token), isBadState);
});

test('assertWorkspaceExecutionReplaceable reports the guarding owner for reset/close/replace', () => {
    const workspace = createWorkspace();
    assert.doesNotThrow(() => assertWorkspaceExecutionReplaceable(workspace, 'workflow.resetDefault'));
    const release = acquireWorkspaceExecution(workspace, 'agent.session.hold', { kind: 'agent', id: 'agent-9', intent: 'paused' });
    assert.throws(
        () => assertWorkspaceExecutionReplaceable(workspace, 'workspace.remove'),
        (error: unknown) => isBadState(error)
            && error instanceof ActionError
            && error.message.includes('agent')
            && error.message.includes('agent-9')
            && error.message.includes('intent=paused'),
    );
    release();
    assert.doesNotThrow(() => assertWorkspaceExecutionReplaceable(workspace, 'workspace.remove'));
});
