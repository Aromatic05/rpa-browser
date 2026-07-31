import test from 'node:test';
import assert from 'node:assert/strict';
import { runStepList } from '../../../src/runner/run_steps';
import type { StepUnion } from '../../../src/runner/steps/types';
import { WorkflowError } from '../../../src/workflow/errors';
import { completeRunStepsDeps } from '../../helpers/run_steps_workspace';

test('runSteps fails before executing when persisted checkpoint artifacts are invalid', async () => {
    let executions = 0;
    const workspace = {
        workflow: { name: 'ws-checkpoint-load' },
        checkpoint: {
            getProvider: () => ({
                listCheckpoints: () => {
                    throw new WorkflowError('invalid checkpoint artifact: recovery-1', 'ERR_WORKFLOW_INVALID_ARTIFACT');
                },
            }),
        },
    };
    const deps = completeRunStepsDeps({
        resolveWorkspace: () => workspace as any,
        pluginHost: {
            getExecutors: () => ({
                'browser.snapshot': async (step: StepUnion) => {
                    executions += 1;
                    return { stepId: step.id, ok: true };
                },
            }) as any,
        } as any,
    });

    const result = await runStepList('ws-checkpoint-load', [{
        id: 'snapshot-1',
        name: 'browser.snapshot',
        args: {},
    } as StepUnion], deps);

    assert.equal(result.checkpoint.status, 'failed');
    assert.equal(executions, 0);
});
