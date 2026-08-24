import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDsl, parseDsl, runDsl} from '../../../src/automation/dsl';
import {runStepList} from '../../../src/automation/runner/run_steps';
import {stepExecutors} from '../../../src/automation/runner/steps/executors';
import type {Checkpoint} from '../../../src/automation/runner/checkpoint';
import type {StepUnion} from '../../../src/automation/runner/steps/types';
import {completeRunStepsDeps} from '../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../helpers/v2_business_page';

const workflowCheckpoint: Checkpoint = {
    id: 'approve-checkpoint',
    kind: 'procedure',
    content: [{
        type: 'act',
        step: {
            name: 'browser.click',
            args: {nodeId: 'node:checkpoint-action'},
        },
    }],
};

test('V2 PageSession supports Step refs, content refs, manual entities, Checkpoint and DSL orchestration', async () => {
    const fixture = createV2BusinessPage();
    const page = {url: () => 'https://example.test/orders'};
    const clickedNodeIds: string[] = [];
    const deps = completeRunStepsDeps({
        pluginHost: {
            getExecutors: () => ({
                ...stepExecutors,
                'browser.click': async (step: StepUnion) => {
                    const nodeId = 'nodeId' in step.args ? step.args.nodeId : undefined;
                    clickedNodeIds.push(String(nodeId ?? ''));
                    return {stepId: step.id, ok: true, data: {clicked: nodeId}};
                },
            }),
        } as never,
    }, {workspaceName: 'ws-1', tabName: 'tab-1', page});
    const baseWorkspace = deps.resolveWorkspace('ws-1');
    deps.resolveWorkspace = () => ({
        ...baseWorkspace,
        workflow: {} as never,
        checkpoint: {
            getProvider: () => ({
                getCheckpoint: () => null,
                getCheckpointResolves: () => ({}),
            }),
        },
    } as never);
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: page.url(),
        capture: async () => fixture.capture,
    });
    const ensureFresh = deps.pageSession.ensureFresh.bind(deps.pageSession);
    deps.pageSession.ensureFresh = async (input) => {
        if (input.reason === 'explicit') {
            const current = deps.pageSession.read(page as never);
            assert.ok(current);
            return current;
        }
        return await ensureFresh(input);
    };

    const steps: StepUnion[] = [
        {
            id: 'resolve-submit',
            name: 'browser.query',
            args: {
                op: 'entity.target',
                businessTag: 'order.form.main',
                target: {kind: 'form.action', actionIntent: 'submit'},
            },
        },
        {
            id: 'snapshot-submit',
            name: 'browser.snapshot',
            args: {contain: '{{resolve-submit.data.nodeId}}', depth: 0},
        },
        {
            id: 'content-submit',
            name: 'browser.get_content',
            args: {ref: '{{snapshot-submit.data.roots.0.contentRef}}'},
        },
        {
            id: 'add-manual',
            name: 'browser.entity',
            args: {
                op: 'add',
                nodeId: '{{resolve-submit.data.nodeId}}',
                kind: 'panel',
                name: 'Submit panel',
                businessTag: 'manual.submit',
            },
        },
        {
            id: 'find-manual',
            name: 'browser.entity',
            args: {op: 'find', businessTag: 'manual.submit'},
        },
        {
            id: 'rename-manual',
            name: 'browser.entity',
            args: {op: 'rename', nodeId: '{{resolve-submit.data.nodeId}}', name: 'Renamed submit'},
        },
        {
            id: 'assert-manual',
            name: 'browser.assert',
            args: {entityExists: {kind: 'panel', businessTag: 'manual.submit'}},
        },
        {
            id: 'delete-manual',
            name: 'browser.entity',
            args: {
                op: 'delete',
                nodeId: '{{resolve-submit.data.nodeId}}',
                kind: 'panel',
                businessTag: 'manual.submit',
            },
        },
        {
            id: 'click-submit',
            name: 'browser.click',
            args: {nodeId: '{{resolve-submit.data.nodeId}}'},
        },
        {
            id: 'checkpoint-call',
            name: 'browser.checkpoint',
            args: {checkpointId: workflowCheckpoint.id},
        },
    ];
    const run = await runStepList('ws-1', steps, deps, {
        runId: 'v2-orchestration-stack',
        checkpoints: [workflowCheckpoint],
    });
    assert.equal(run.checkpoint.status, 'completed', JSON.stringify(run.pipe.items, null, 2));
    assert.equal(run.pipe.items.every((item) => item.ok), true, JSON.stringify(run.pipe.items, null, 2));
    const byStep = new Map(run.pipe.items.map((item) => [item.stepId, item]));
    assert.match(String((byStep.get('content-submit')?.data as {content?: string})?.content), /提交/);
    assert.equal((byStep.get('find-manual')?.data as {total?: number})?.total, 1);
    assert.equal((byStep.get('delete-manual')?.data as {deleted_count?: number})?.deleted_count, 1);
    assert.deepEqual(clickedNodeIds, [fixture.nodeIds.submit, 'node:checkpoint-action']);

    deps.pageSession.markDirty(page as never, 'interaction');
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: page.url(),
        capture: async () => fixture.capture,
    });
    const dsl = normalizeDsl(parseDsl(`
        snapshot
        let submit = query entity.target "order.form.main" {
          kind: "form.action"
          actionIntent: "submit"
        }
        click submit
    `));
    await runDsl(dsl, {workspaceName: 'ws-1', deps});
    assert.equal(clickedNodeIds.at(-1), fixture.nodeIds.submit);
});
