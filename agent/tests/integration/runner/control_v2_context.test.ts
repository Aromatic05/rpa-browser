import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunnerControl} from '../../../src/runner/control';
import {setRunStepsDeps, type RunStepsDeps, type RunStepsExecutionContext} from '../../../src/runner/run_steps';
import type {StepResolve, StepResult, StepUnion} from '../../../src/runner/steps/types';
import type {Checkpoint} from '../../../src/runner/checkpoint';
import type {Action} from '../../../src/actions/action_protocol';
import {getRunnerConfig} from '../../../src/config';
import {completeRunStepsDeps} from '../../helpers/run_steps_workspace';
import {executeBrowserCheckpoint} from '../../../src/runner/steps/executors/checkpoint';
import type {ExecutorFn} from '../../../src/runner/steps/executors';

const action = (type: string, payload: Record<string, unknown>): Action => ({
    v: 1,
    id: `${type}-${Math.random()}`,
    type,
    workspaceName: 'ws-1',
    payload,
    at: Date.now(),
});

test('task.run.start preserves V2 checkpoint assets across streamed step pushes', async () => {
    let outerResolve: StepResolve | undefined;
    let nestedResolve: StepResolve | undefined;
    let receivedCheckpoint: Checkpoint | null | undefined;
    let receivedCheckpointBody: string | undefined;
    let clickCount = 0;
    const baseConfig = getRunnerConfig();
    const deps = completeRunStepsDeps({
        pluginHost: {
            getExecutors: () => ({
                'browser.click': async (step: StepUnion) => {
                    clickCount += 1;
                    if (step.id === 'click-approve') {outerResolve = step.resolve;}
                    if (step.id === 'checkpoint:checkpoint-call:content:0') {nestedResolve = step.resolve;}
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
                'browser.checkpoint': async (
                    step: StepUnion,
                    stepDeps: RunStepsDeps,
                    workspaceName: string,
                    context?: RunStepsExecutionContext,
                ): Promise<StepResult> => {
                    receivedCheckpoint = context?.checkpointProvider?.getCheckpoint('recover-click');
                    receivedCheckpointBody = context?.checkpointProvider?.getCheckpointBody?.('recover-click')?.source;
                    return await (executeBrowserCheckpoint as ExecutorFn)(step, stepDeps, workspaceName, context);
                },
            }),
        } as never,
    });
    setRunStepsDeps(deps);
    const control = createRunnerControl({
        runnerConfig: {
            ...baseConfig,
            checkpointPolicy: {...baseConfig.checkpointPolicy, enabled: false},
        },
    });
    const workspace = deps.resolveWorkspace('ws-1');
    const workspaceRegistry = {} as never;
    const outerStepResolve: StepResolve = {hint: {target: {nodeId: 'node:approve'}}};
    const checkpointStepResolve: StepResolve = {hint: {target: {nodeId: 'node:recover'}}};
    const checkpoints: Checkpoint[] = [{
        id: 'recover-click',
        kind: 'procedure',
        content: [{
            type: 'act',
            step: {name: 'browser.click', args: {resolveId: 'checkpoint-approve'}},
        }],
    }];
    const checkpointBodies = { 'recover-click': 'wait 1' };

    await control.handle({
        action: action('task.run.start', {
            runId: 'run-v2-context',
            stepResolves: {approve: outerStepResolve},
            checkpoints,
            checkpointStepResolves: {'recover-click': {'checkpoint-approve': checkpointStepResolve}},
            checkpointBodies,
        }),
        workspace,
        workspaceRegistry,
    });
    await control.handle({
        action: action('task.run.push', {
            runId: 'run-v2-context',
            steps: [
                {
                    id: 'click-approve',
                    name: 'browser.click',
                    args: {resolveId: 'approve'},
                },
                {
                    id: 'checkpoint-call',
                    name: 'browser.checkpoint',
                    args: {checkpointId: 'recover-click'},
                },
            ],
            close: true,
        }),
        workspace,
        workspaceRegistry,
    });

    for (let attempt = 0; attempt < 50 && clickCount < 2; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }

    assert.equal(clickCount, 2, 'outer resolved click and checkpoint nested click must both execute');
    assert.deepEqual(outerResolve, outerStepResolve);
    assert.deepEqual(receivedCheckpoint, checkpoints[0]);
    assert.deepEqual(nestedResolve, checkpointStepResolve);
    assert.equal(receivedCheckpointBody, checkpointBodies['recover-click']);
});
