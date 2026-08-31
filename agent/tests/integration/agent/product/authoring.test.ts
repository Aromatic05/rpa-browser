import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionManager, ActivityConflictError} from '../../../../src/agent/service/session/manager';
import {createProductController, ProductCommandError} from '../../../../src/agent/product/controller';
import {librarySummaryFrom} from '../../../../src/agent/product/library';
import {encodeInteractionToken} from '../../../../src/agent/product/token';
import type {LibraryAssetSummary} from '../../../../src/agent/library/contracts';
import type {AgentRunResult} from '../../../../src/agent/execution/types';
import {makeResult} from '../service/session/helpers';

const takeoverPause: AgentRunResult = makeResult({
    requestedInteraction: {
        kind: 'takeover',
        reason: 'captcha requires a human',
        scope: 'workspace',
        guidanceModes: ['manual', 'teach', 'annotate'],
    },
});

type Harness = {
    manager: ReturnType<typeof createSessionManager>;
    controller: ReturnType<typeof createProductController>;
    controlInputs: unknown[];
    settleRun: (result: AgentRunResult) => void;
};

const makeHarness = (): Harness => {
    let settle!: (result: AgentRunResult) => void;
    const runPromise = new Promise<AgentRunResult>((resolve) => {
        settle = resolve;
    });
    const controlInputs: unknown[] = [];
    const manager = createSessionManager({
        runner: {
            run: () => runPromise,
        },
        now: () => 1000,
        interactionTtlMs: 5000,
    });
    const controller = createProductController({
        manager,
        workspace: 'ws-1',
        defaults: {provider: 'test', model: 'model'},
        now: () => 1000,
    });
    return {
        manager,
        controller,
        controlInputs,
        settleRun: (result) => {
            settle({
                ...result,
                ...(result.control ? {} : {
                    continuation: {resume: async () => makeResult({text: 'resumed'})},
                    control: {control: async (input: unknown) => {controlInputs.push(input); return makeResult({text: 'controlled'});}},
                }),
            });
        },
    };
};

const pendingTakeover = (manager: ReturnType<typeof createSessionManager>, taskId: string) =>
    manager.listInteractions(taskId)!.find((record) => record.status === 'pending')!;

test('begin Teach acquires the standalone reservation and blocks a Task start', () => {
    const {controller, manager} = makeHarness();
    const view = controller.beginAuthoring({activity: 'teach', teachKind: 'procedure'});
    assert.equal(view.reservation.owner, 'standalone_teach');
    assert.equal(manager.activityReservation().owner, 'standalone_teach');

    assert.throws(
        () => controller.startTask({prompt: 'steal the workspace'}),
        ActivityConflictError,
        'an active Teach must block a Task start, never queue',
    );
});

test('begin Annotate conflicts with an active Teach and vice versa', () => {
    const {controller} = makeHarness();
    controller.beginAuthoring({activity: 'teach', teachKind: 'recovery'});
    assert.throws(
        () => controller.beginAuthoring({activity: 'annotate'}),
        (error: unknown) => error instanceof ProductCommandError && error.code === 'ERR_ACTIVITY_CONFLICT',
    );
});

test('a waiting_for_user Task keeps ownership and blocks standalone authoring', async () => {
    const {controller, manager, settleRun} = makeHarness();
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun(takeoverPause);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.taskView(view.taskId)!.status, 'waiting_for_user');
    assert.throws(
        () => controller.beginAuthoring({activity: 'annotate'}),
        (error: unknown) => error instanceof ProductCommandError && error.code === 'ERR_ACTIVITY_CONFLICT',
        'waiting_for_user keeps the Task reservation',
    );
    assert.equal(manager.activityReservation().ownerTaskId, view.taskId);
});

test('save/discard endAuthoring releases the standalone reservation', () => {
    const {controller, manager} = makeHarness();
    controller.beginAuthoring({activity: 'teach', teachKind: 'demonstration'});
    const ended = controller.endAuthoring({outcome: 'saved'});
    assert.equal(ended.reservation.owner, 'none');
    assert.equal(manager.activityReservation().owner, 'none');
    controller.beginAuthoring({activity: 'annotate'});
    assert.equal(manager.activityReservation().owner, 'standalone_annotate');
    controller.endAuthoring({outcome: 'discarded'});
    assert.equal(manager.activityReservation().owner, 'none');
});

test('endAuthoring never releases a Task-owned reservation', async () => {
    const {controller, manager, settleRun} = makeHarness();
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun(takeoverPause);
    await new Promise((resolve) => setImmediate(resolve));
    controller.endAuthoring({outcome: 'discarded'});
    assert.equal(manager.activityReservation().owner, 'task');
    assert.equal(manager.activityReservation().ownerTaskId, view.taskId);
});

test('task-linked takeover Teach keeps the same Task reservation and return-control keeps lineage', async () => {
    const {controller, manager, settleRun, controlInputs} = makeHarness();
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun(takeoverPause);
    await new Promise((resolve) => setImmediate(resolve));
    const interaction = pendingTakeover(manager, view.taskId);
    const token = encodeInteractionToken(interaction.id, interaction.revision);

    const linked = controller.beginGuidanceTask({taskId: view.taskId, interactionToken: token, mode: 'teach'});
    assert.ok(linked);
    assert.equal(linked.taskId, view.taskId, 'linked guidance never replaces the Task');
    const reservation = manager.activityReservation();
    assert.equal(reservation.owner, 'task', 'the Task keeps the single reservation');
    assert.equal(reservation.humanControl, 'teach');

    const returned = await controller.returnControlTask({
        taskId: view.taskId,
        interactionToken: encodeInteractionToken(interaction.id, interaction.revision + 1),
        mode: 'teach',
        savedReference: 'procedure:order-query-1',
    });
    assert.ok(returned);
    assert.equal(returned.taskId, view.taskId);
    assert.deepEqual(controlInputs, [{kind: 'takeover-return', savedReference: 'procedure:order-query-1'}]);
    assert.equal(manager.activityReservation().humanControl, 'none');

    const stream = controller.events(view.taskId, 0);
    const started = stream.events.find((event) => event.kind === 'human_guidance_started');
    const completed = stream.events.find((event) => event.kind === 'human_guidance_completed');
    assert.equal(started?.kind === 'human_guidance_started' && started.mode, 'teach',
        'started event carries the truthful guidance mode');
    assert.equal(completed?.kind === 'human_guidance_completed' && completed.savedAssetKind, 'procedure');
    assert.equal(completed?.kind === 'human_guidance_completed' && completed.savedAssetRef, 'order-query-1',
        'the stable checkpointId identity is what the event carries');
    const serialized = JSON.stringify(stream.events);
    assert.equal(serialized.includes('sessionId'), false);
    assert.equal(serialized.includes('runId'), false);
    assert.equal(serialized.includes(interaction.id), false, 'raw interaction ids never appear');
});

test('an unknown saved reference degrades to a coarse sanitized asset kind', async () => {
    const {controller, manager, settleRun} = makeHarness();
    const view = controller.startTask({prompt: 'fill'});
    settleRun(takeoverPause);
    await new Promise((resolve) => setImmediate(resolve));
    const interaction = pendingTakeover(manager, view.taskId);
    await controller.beginGuidanceTask({taskId: view.taskId, interactionToken: encodeInteractionToken(interaction.id, interaction.revision), mode: 'annotate'});
    await controller.returnControlTask({
        taskId: view.taskId,
        interactionToken: encodeInteractionToken(interaction.id, interaction.revision + 1),
        mode: 'annotate',
        savedReference: 'raw-dsl-body{...}',
    });
    const completed = controller.events(view.taskId, 0).events
        .find((event) => event.kind === 'human_guidance_completed');
    assert.equal(completed?.kind === 'human_guidance_completed' && completed.savedAssetKind, 'asset');
    assert.equal(JSON.stringify(completed).includes('raw-dsl-body'), false);
});

test('a page_knowledge saved reference projects the real asset kind and ref', async () => {
    const {controller, manager, settleRun} = makeHarness();
    const view = controller.startTask({prompt: 'fill'});
    settleRun(takeoverPause);
    await new Promise((resolve) => setImmediate(resolve));
    const interaction = pendingTakeover(manager, view.taskId);
    await controller.beginGuidanceTask({taskId: view.taskId, interactionToken: encodeInteractionToken(interaction.id, interaction.revision), mode: 'annotate'});
    await controller.returnControlTask({
        taskId: view.taskId,
        interactionToken: encodeInteractionToken(interaction.id, interaction.revision + 1),
        mode: 'annotate',
        savedReference: 'page_knowledge:orders',
    });
    const completed = controller.events(view.taskId, 0).events
        .find((event) => event.kind === 'human_guidance_completed');
    assert.equal(completed?.kind === 'human_guidance_completed' && completed.savedAssetKind, 'page_knowledge');
    assert.equal(completed?.kind === 'human_guidance_completed' && completed.savedAssetRef, 'orders');
});

const assetSummary = (overrides: Partial<LibraryAssetSummary> & {kind: LibraryAssetSummary['kind']; name: string}): LibraryAssetSummary => ({
    title: overrides.name,
    updatedAt: 1,
    revision: 'r1',
    dependencies: [],
    health: 'ready',
    capabilities: {
        runtimeApplied: false,
        callableFromDsl: false,
        agentDiscovery: false,
        runnerRecovery: false,
        agentRecovery: false,
        replayable: false,
        modelLoadSeam: false,
    },
    ...overrides,
} as LibraryAssetSummary);

test('the Library adapter projects real names and truthful health evidence only', () => {
    const summary = librarySummaryFrom([
        assetSummary({kind: 'procedure', name: 'procedure-query-order', title: '查询订单', health: 'needs_review'}),
        assetSummary({kind: 'recovery', name: 'recovery-close-popup', title: '关闭弹窗', health: 'broken'}),
        assetSummary({kind: 'demonstration', name: 'recording-1', stepCount: 7, health: 'unknown'}),
        assetSummary({
            kind: 'page_knowledge',
            name: 'orders',
            title: '订单页',
            applicability: {kind: 'form', urlPattern: 'https://shop.test/orders'},
            entityCount: 3,
            fieldCount: 5,
            actionCount: 2,
            rowActionCount: 1,
            safety: {reversible: 1, compensatable: 0, irreversible: 1, unknown: 0},
        }),
        assetSummary({kind: 'automation', name: 'weekly-report', purpose: 'fills the report', health: 'ready'}),
    ]);
    assert.deepEqual(summary.procedures, [{name: '查询订单', health: 'needs_review'}]);
    assert.deepEqual(summary.recoveries, [{name: '关闭弹窗', health: 'broken'}]);
    assert.equal(JSON.stringify(summary).includes('procedure-query-order'), false,
        'stable Procedure ids are runtime references and must not leak into the product Library');
    assert.equal(JSON.stringify(summary).includes('recovery-close-popup'), false,
        'stable Recovery ids are runtime references and must not leak into the product Library');
    assert.deepEqual(summary.demonstrations, [{name: 'recording-1', stepCount: 7, health: 'unknown'}]);
    assert.deepEqual(summary.pageKnowledge, [{
        profileName: 'orders',
        label: '订单页',
        pageKind: 'form',
        urlPattern: 'https://shop.test/orders',
        entityCount: 3,
        health: 'ready',
    }]);
    assert.deepEqual(summary.automations, [{name: 'weekly-report', description: 'fills the report', status: 'ready'}]);
    const serialized = JSON.stringify(summary);
    for (const leak of ['body', 'dsl', 'selector', 'revision', 'steps']) {
        assert.equal(serialized.includes(leak), false, `library projection must not carry ${leak}`);
    }
});

test('librarySummary reports null when no real Library is wired (never fabricated)', async () => {
    const {controller} = makeHarness();
    assert.equal(await controller.librarySummary(), null);
});
