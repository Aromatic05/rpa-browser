import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
import {classifyPausedDslDebugToolCall} from '../../../../../src/agent/debug/execution/tool_policy';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import type {RunStepsDeps} from '../../../../../src/runner/run_steps';
import {PageSnapshotSessionStore} from '../../../../../src/snapshot';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const deps = {} as RunStepsDeps;

const createViews = async (): Promise<{
    first: WorldView;
    second: WorldView;
    oldTarget: string;
    newTarget: string;
}> => {
    const fixture = createV2BusinessPage();
    const firstCapture = structuredClone(fixture.capture);
    const secondCapture = structuredClone(fixture.capture);
    secondCapture.control.observation.identity.captureRevision = 2;
    const formProfile = secondCapture.entityRules?.profiles['orders-form'];
    assert.ok(formProfile);
    const root = Object.values(formProfile.semanticBindings.byId)
        .find((binding) => binding.annotation.businessTag === 'order.form.main');
    assert.ok(root);
    const fields = root.annotation.formFields as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(fields), true);
    root.annotation.formFields = fields.map((field) => field.fieldKey === 'orderNo'
        ? {...field, controlNodeId: fixture.nodeIds.submit, nodeId: fixture.nodeIds.submit}
        : field);

    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const firstEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        capture: async () => firstCapture,
    });
    const secondEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        reason: 'explicit',
        capture: async () => secondCapture,
    });
    const view = (entry: typeof firstEntry): WorldView => Object.freeze({
        workspaceName: 'ws-provenance-recompute',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return {
        first: view(firstEntry),
        second: view(secondEntry),
        oldTarget: fixture.nodeIds.buyer,
        newTarget: fixture.nodeIds.submit,
    };
};

test('debug.recompute recursively re-evaluates query, ref and compute lineage without mutating scope', async () => {
    const views = await createViews();
    let live = views.first;
    let queryCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            let field = query entity.target "order.form.main" {
              kind: "form.field"
              fieldKey: "orderNo"
            }
            let present = compute exists(field)
            output selected = field
            wait 0
        `,
        context: {
            workspaceName: 'ws-provenance-recompute',
            deps,
            stepExecutionPort: {
                execute: async (step) => {
                    if (step.name === 'browser.query') {
                        queryCalls += 1;
                        return {
                            stepId: step.id,
                            ok: true,
                            data: {
                                kind: 'nodeId',
                                nodeId: views.oldTarget,
                                meta: {pageEpoch: 'v2-business', captureRevision: 1},
                            },
                        };
                    }
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        },
        worldViewSource: {pin: async () => live},
        debug: {breakpoints: ['body.3']},
    });

    const pause = await execution.waitForPause();
    const tools = createPausedDslDebugAgentTools(execution, pause);
    const tool = (name: string) => tools.tools.find((candidate) => candidate.name === name)!;
    const scopeBefore = structuredClone(pause.scope);

    const explained = await tool('debug.explain').execute('explain-field', {path: 'vars.field'});
    assert.deepEqual((explained.details as any).explanation.provenance.source.query, {
        op: 'entity.target',
        businessTag: 'order.form.main',
        target: {kind: 'form.field', fieldKey: 'orderNo'},
    });

    live = views.second;
    const refreshed = await tool('debug.refresh').execute('refresh', {});
    assert.equal((refreshed.details as any).pause.world.revision.captureRevision, 2);

    const field = await tool('debug.recompute').execute('recompute-field', {path: 'vars.field'});
    assert.equal((field.details as any).status, 'recomputed');
    assert.equal((field.details as any).currentValue.nodeId, views.oldTarget);
    assert.equal((field.details as any).candidateValue.nodeId, views.newTarget);
    assert.equal((field.details as any).changed, true);

    const present = await tool('debug.recompute').execute('recompute-present', {path: 'vars.present'});
    assert.equal((present.details as any).status, 'recomputed');
    assert.equal((present.details as any).currentValue, true);
    assert.equal((present.details as any).candidateValue, true);
    assert.equal((present.details as any).changed, false);

    const selected = await tool('debug.recompute').execute('recompute-selected', {path: 'output.selected'});
    assert.equal((selected.details as any).status, 'recomputed');
    assert.equal((selected.details as any).currentValue.nodeId, views.oldTarget);
    assert.equal((selected.details as any).candidateValue.nodeId, views.newTarget);
    assert.equal((selected.details as any).changed, true);
    assert.equal(queryCalls, 1);
    assert.equal(classifyPausedDslDebugToolCall('debug.recompute'), 'read');

    const scopeAfter = await tool('debug.scope').execute('scope-after', {});
    assert.deepEqual((scopeAfter.details as any).scope, scopeBefore);

    const unavailable = await tool('debug.recompute').execute('recompute-missing', {path: 'vars.missing'});
    assert.equal((unavailable.details as any).status, 'unavailable');
    assert.equal((unavailable.details as any).reason, 'untracked');

    await tool('debug.abort').execute('abort', {});
});
