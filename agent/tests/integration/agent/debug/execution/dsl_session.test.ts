import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import type {WorldView, WorldViewSource} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/snapshot';
import type {RunStepsDeps} from '../../../../../src/runner/run_steps';
import type {StepUnion} from '../../../../../src/runner/steps/types';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const deps = {} as RunStepsDeps;

const createViews = async (): Promise<[WorldView, WorldView]> => {
    const pageKey = {};
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const firstEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const secondCapture = structuredClone(fixture.capture);
    secondCapture.control.observation.identity.captureRevision = 2;
    const secondEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        reason: 'explicit',
        capture: async () => secondCapture,
    });
    const toView = (entry: typeof firstEntry): WorldView => Object.freeze({
        workspaceName: 'ws-1',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return [toView(firstEntry), toView(secondEntry)];
};

test('paused DSL execution binds one pinned WorldView to each retained continuation', async () => {
    const [firstView, secondView] = await createViews();
    const views = [firstView, secondView];
    let pinCalls = 0;
    const source: WorldViewSource = {
        pin: async () => views[pinCalls++] ?? secondView,
    };
    let snapshotCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            snapshot
            output result = input.value
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {value: 9},
            stepExecutionPort: {
                execute: async (step: StepUnion) => {
                    if (step.name === 'browser.snapshot') {snapshotCalls += 1;}
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        },
        worldViewSource: source,
        debug: {initialMode: 'step'},
    });

    const first = await execution.waitForPause();
    assert.equal(first.location.path, 'body.0');
    assert.equal(first.world.revision.captureRevision, 1);
    assert.deepEqual(first.scope.output, {});

    const rows = execution.query(first.continuationId, {
        op: 'entity',
        businessTag: 'order.table.main',
        query: 'table.rowCount',
    });
    assert.equal(rows.ok, true);
    assert.equal(rows.world.revision.captureRevision, 1);

    execution.step(first.continuationId);
    const second = await execution.waitForPause();
    assert.equal(snapshotCalls, 1);
    assert.equal(second.location.path, 'body.1');
    assert.equal(second.world.revision.captureRevision, 2);
    assert.equal(pinCalls, 2);

    assert.throws(
        () => execution.query(first.continuationId, {from: 'snapshot'}),
        /continuation is not active/,
    );

    execution.continue(second.continuationId);
    const completed = await execution.waitForCompletion();
    assert.deepEqual(completed.scope.output, {result: 9});
    assert.equal(snapshotCalls, 1);
});

test('paused DSL execution exposes pure compute against explicit pause-local scope values', async () => {
    const [view] = await createViews();
    const execution = createDslDebugExecutionSession({
        source: 'output result = input.value',
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {value: 4},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const paused = await execution.waitForPause();
    const computed = execution.compute(paused.continuationId, {
        op: 'eq',
        args: [
            {ref: {path: 'input.value'}},
            {literal: 4},
        ],
    }, {input: paused.scope.input});

    assert.equal(computed.ok, true);
    if (computed.ok) {assert.equal(computed.value, true);}
    assert.deepEqual(computed.world.revision, paused.world.revision);

    execution.continue(paused.continuationId);
    await execution.waitForCompletion();
});
