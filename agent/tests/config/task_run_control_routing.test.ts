import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceRegistry } from '../../src/runtime/workspace/registry';
import { createWorkflowOnFs, deleteWorkflowFromFs } from '../../src/workflow';
import { handleWorkspaceControlAction } from '../../src/runtime/workspace/router';
import { setRunStepsDeps } from '../../src/runner/run_steps';
import { loadRunnerConfig } from '../../src/config/loader';
import type { StepUnion } from '../../src/runner/steps/types';

const unique = () => `ws-task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const setupDeps = () => {
    setRunStepsDeps({
        runtime: {} as any,
        config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.click': async (step: StepUnion) => ({ stepId: step.id, ok: true, data: { clicked: true } }),
                }) as any,
        } as any,
    });
};

const call = async (ctx: { registry: any; workspace: any }, type: string, payload?: any) =>
    await handleWorkspaceControlAction({
        action: { v: 1, id: `${type}-${Date.now()}`, type, workspaceName: ctx.workspace.name, payload },
        workspace: ctx.workspace,
        workspaceRegistry: ctx.registry,
    } as any);

test('task.run.* are routed through runner control', async () => {
    setupDeps();
    const registry = createWorkspaceRegistry();
    const wsName = unique();
    const workflow = createWorkflowOnFs(wsName);
    const workspace = registry.createWorkspace(wsName, workflow);
    const ctx = { registry, workspace };

    const started = await call(ctx, 'task.run.start', { workspaceName: 'bad-payload' });
    assert.equal(started.reply.type, 'task.run.start.result');
    const runId = (started.reply.payload as any).runId as string;

    const pushed = await call(ctx, 'task.run.push', {
        runId,
        steps: [{ id: 's1', name: 'browser.click', args: { selector: '#a' } }],
        close: true,
    });
    assert.equal(pushed.reply.type, 'task.run.push.result');

    const polled = await call(ctx, 'task.run.poll', { runId, cursor: 0 });
    assert.equal(polled.reply.type, 'task.run.poll.result');

    const checkpointed = await call(ctx, 'task.run.checkpoint', { runId });
    assert.equal(checkpointed.reply.type, 'task.run.checkpoint.result');
    assert.equal((checkpointed.reply.payload as any).checkpoint.workspaceName, wsName);

    const suspended = await call(ctx, 'task.run.suspend', { runId });
    assert.equal(suspended.reply.type, 'task.run.suspend.result');

    const continued = await call(ctx, 'task.run.continue', { runId });
    assert.equal(continued.reply.type, 'task.run.continue.result');

    const flushed = await call(ctx, 'task.run.flush', { runId });
    assert.equal(flushed.reply.type, 'task.run.flush.result');

    const halted = await call(ctx, 'task.run.halt', { runId });
    assert.equal(halted.reply.type, 'task.run.halt.result');

    const resumed = await call(ctx, 'task.run.resume', { runId, steps: [], close: true, workspaceName: 'bad-payload' });
    assert.equal(resumed.reply.type, 'task.run.resume.result');

    deleteWorkflowFromFs(wsName);
});
