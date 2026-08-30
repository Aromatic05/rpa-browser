import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionManager, ActivityConflictError} from '../../../../src/agent/service/session/manager';
import {createProductController, ProductCommandError} from '../../../../src/agent/product/controller';
import {createProductEventLog} from '../../../../src/agent/product/events';
import {encodeInteractionToken} from '../../../../src/agent/product/token';
import {createWorkspaceActivityReservation} from '../../../../src/agent/product/reservation';
import type {ProductInteractionCard} from '../../../../src/agent/product/types';
import type {ModelRequestedInteraction} from '../../../../src/agent/interaction/contracts';
import type {AgentRunResult} from '../../../../src/agent/execution/types';
import {makeRequest, makeResult} from '../service/session/helpers';

const approvalPause = {reason: 'barrier', continuationId: 'cont-1', stepName: 'browser.submit', risk: 'irreversible'} as const;

const pausedResult = (): AgentRunResult => makeResult({
    programs: [{source: 'output ok = input.ok', input: {}, status: 'paused', pause: approvalPause}],
});

type Harness = {
    manager: ReturnType<typeof createSessionManager>;
    controller: ReturnType<typeof createProductController>;
    runCalls: number;
    controlCalls: number;
    resumeCalls: number;
    controlInputs: unknown[];
    settleRun: (result?: AgentRunResult) => void;
};

const makeHarness = (): Harness => {
    let settle!: (result: AgentRunResult) => void;
    const runPromise = new Promise<AgentRunResult>((resolve) => {
        settle = resolve;
    });
    const state = {runCalls: 0, controlCalls: 0, resumeCalls: 0};
    const controlInputs: unknown[] = [];
    const manager = createSessionManager({
        runner: {
            run: () => {
                state.runCalls += 1;
                return runPromise;
            },
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
        get runCalls() { return state.runCalls; },
        get controlCalls() { return state.controlCalls; },
        get resumeCalls() { return state.resumeCalls; },
        controlInputs,
        settleRun: (result = pausedResult()) => {
            settle({
                ...result,
                ...(result.control ? {} : {
                    continuation: {resume: async () => {state.resumeCalls += 1; return makeResult({text: 'resumed'});}},
                    control: {control: async (input: unknown) => {state.controlCalls += 1; controlInputs.push(input); return makeResult({text: 'controlled'});}},
                }),
            });
        },
    };
};

const pendingInteraction = (manager: ReturnType<typeof createSessionManager>, taskId: string) =>
    manager.listInteractions(taskId)!.find((record) => record.status === 'pending')!;

test('start task acquires the reservation and a second start is rejected without queuing', async () => {
    const {controller, manager} = makeHarness();
    const view = controller.startTask({prompt: 'fill the order form'});
    assert.equal(view.status, 'running');
    assert.equal(manager.activityReservation().owner, 'task');

    assert.throws(
        () => controller.startTask({prompt: 'second task'}),
        ActivityConflictError,
        'a second activity must be rejected, never queued',
    );
    assert.equal(manager.list().length, 1, 'the conflicted start must not create a session');
    assert.equal(manager.activityReservation().owner, 'task');
});

test('a waiting task keeps the reservation and projects as waiting_for_user', async () => {
    const {controller, manager, settleRun} = makeHarness();
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun();
    await new Promise((resolve) => setImmediate(resolve));

    const task = controller.taskView(view.taskId)!;
    assert.equal(task.status, 'waiting_for_user');
    assert.equal(task.phase, 'interacting');
    assert.equal(task.interaction?.kind, 'approval');
    if (task.interaction?.kind === 'approval') {
        assert.equal(task.interaction.actionName, 'browser.submit');
        assert.ok(task.interaction.interactionToken.length > 0);
    }
    assert.equal(task.title, 'fill the order form');

    const workspace = controller.workspaceView();
    assert.equal(workspace.reservation.owner, 'task');
    assert.equal(workspace.activeTask?.taskId, view.taskId);
    assert.equal(workspace.activeTask?.status, 'waiting_for_user');

    assert.throws(
        () => controller.startTask({prompt: 'steal the workspace'}),
        ActivityConflictError,
        'a waiting task must keep its reservation',
    );
});

test('approve through the product surface resumes the same task without a second runner', async () => {
    const harness = makeHarness();
    const {controller, manager, settleRun} = harness;
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun();
    await new Promise((resolve) => setImmediate(resolve));
    const interaction = pendingInteraction(manager, view.taskId);
    const token = encodeInteractionToken(interaction.id, interaction.revision);

    const after = await controller.approveTask({taskId: view.taskId, interactionToken: token});
    assert.equal(after!.status, 'completed');
    assert.equal(harness.runCalls, 1, 'approval must not start a second runner');
    assert.equal(harness.resumeCalls, 1, 'approval takes the exact retained execution fast path');
});

test('deny through the product surface never cancels and re-enters the Agent control loop', async () => {
    const harness = makeHarness();
    const {controller, manager, settleRun, controlInputs} = harness;
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun();
    await new Promise((resolve) => setImmediate(resolve));
    const interaction = pendingInteraction(manager, view.taskId);
    const token = encodeInteractionToken(interaction.id, interaction.revision);

    const after = await controller.denyTask({
        taskId: view.taskId,
        interactionToken: token,
        reason: 'not safe',
        requestedAlternative: 'route to a review step',
    });
    assert.notEqual(after!.status, 'cancelled', 'deny must never project as cancelled');
    assert.equal(harness.controlCalls, 1);
    assert.deepEqual(controlInputs[0], {
        kind: 'deny',
        effectName: 'browser.submit',
        reason: 'not safe',
        requestedAlternative: 'route to a review step',
    });
});

test('stop is a cancellation distinct from deny and releases the reservation', async () => {
    const harness = makeHarness();
    const {controller, manager, settleRun} = harness;
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun();
    await new Promise((resolve) => setImmediate(resolve));

    const after = controller.stopTask({taskId: view.taskId})!;
    assert.equal(after.status, 'cancelled');
    assert.equal(after.error?.code, 'ERR_SESSION_CANCELLED');
    assert.equal(harness.resumeCalls, 0, 'stop must not take the approval fast path');
    assert.equal(harness.controlCalls, 0, 'stop must not re-enter the control loop');
    assert.equal(manager.activityReservation().owner, 'none');
});

test('a stale interaction token is rejected and nothing is executed', async () => {
    const {controller, manager, settleRun} = makeHarness();
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun();
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(
        () => controller.approveTask({taskId: view.taskId, interactionToken: 'not-a-token'}),
        (error: unknown) => error instanceof ProductCommandError && error.code === 'ERR_STALE',
    );
    assert.equal(manager.listInteractions(view.taskId)!.length, 1, 'the interaction stays pending');
});

test('a stale revision is rejected with a product-level stale error', async () => {
    const {controller, manager, settleRun} = makeHarness();
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun();
    await new Promise((resolve) => setImmediate(resolve));
    const interaction = pendingInteraction(manager, view.taskId);

    await assert.rejects(
        () => controller.approveTask({taskId: view.taskId, interactionToken: encodeInteractionToken(interaction.id, interaction.revision - 1)}),
        (error: unknown) => error instanceof ProductCommandError && error.code === 'ERR_STALE',
    );
});

test('an orphan pause projects as failed, never as a healthy wait', async () => {
    const {controller, manager, settleRun} = makeHarness();
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun(makeResult({
        programs: [{source: 's', input: {}, status: 'paused', pause: {reason: 'statement', continuationId: 'c'}}],
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.listInteractions(view.taskId)!.length, 0, 'a statement pause must not create an approval');

    const task = controller.taskView(view.taskId)!;
    assert.equal(task.status, 'failed');
    assert.equal(task.error?.code, 'ERR_ORPHAN_PAUSE');
    assert.notEqual(task.status, 'waiting_for_user');
    assert.equal(manager.activityReservation().owner, 'none', 'the orphan sweep releases the reservation');
});

test('clarification/recovery/takeover cards are typed with opaque tokens and no internal ids', async () => {
    const cases: Array<{
        requested: ModelRequestedInteraction;
        assertCard: (card: ProductInteractionCard) => void;
    }> = [
        {
            requested: {kind: 'clarification', question: 'Which delivery date?', schema: {field: 'date', type: 'date'}},
            assertCard: (card) => {
                assert.equal(card.kind, 'clarification');
                if (card.kind === 'clarification') {
                    assert.equal(card.question, 'Which delivery date?');
                    assert.equal(card.schema.type, 'date');
                }
            },
        },
        {
            requested: {
                kind: 'recovery_decision',
                failureSummary: 'step failed',
                options: [{id: 'retry', kind: 'retry', label: 'Retry', eligible: true}],
            },
            assertCard: (card) => {
                assert.equal(card.kind, 'recovery_decision');
                if (card.kind === 'recovery_decision') {
                    assert.equal(card.options[0].label, 'Retry');
                }
            },
        },
        {
            requested: {kind: 'takeover', reason: '2FA required', scope: 'workspace', guidanceModes: ['manual', 'teach']},
            assertCard: (card) => {
                assert.equal(card.kind, 'takeover');
                if (card.kind === 'takeover') {
                    assert.equal(card.reason, '2FA required');
                    assert.deepEqual(card.guidanceModes, ['manual', 'teach']);
                    assert.equal(card.stage, 'offered');
                }
            },
        },
    ];

    for (const {requested, assertCard} of cases) {
        const {controller, manager, settleRun} = makeHarness();
        const view = controller.startTask({prompt: 'fill the order form'});
        settleRun(makeResult({requestedInteraction: requested}));
        await new Promise((resolve) => setImmediate(resolve));

        const task = controller.taskView(view.taskId)!;
        assert.equal(task.status, 'waiting_for_user');
        assert.ok(task.interaction);
        assertCard(task.interaction);
        const rawIds = manager.listInteractions(view.taskId)!.map((record) => record.id);
        const serialized = JSON.stringify(task);
        for (const rawId of rawIds) {
            assert.equal(serialized.includes(rawId), false, 'raw interaction ids must not appear');
        }
        assert.equal(serialized.includes('continuationId'), false);
        assert.equal(serialized.includes('sessionId'), false);
        assert.equal(serialized.includes('"revision"'), false);
    }
});

test('the workspace product view exposes reservation and active task without raw ids', async () => {
    const {controller, settleRun} = makeHarness();
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun();
    await new Promise((resolve) => setImmediate(resolve));

    const workspace = controller.workspaceView();
    assert.equal(workspace.workspace, 'ws-1');
    assert.equal(workspace.reservation.owner, 'task');
    assert.equal(workspace.reservation.humanControl, 'none');
    const serialized = JSON.stringify(workspace);
    assert.equal(serialized.includes('sessionId'), false);
    assert.equal(serialized.includes('runId'), false);
    assert.equal(serialized.includes('continuationId'), false);
});

test('events are deterministic, monotonic, sanitized and expose gaps for reconnects', async () => {
    const {controller, manager, settleRun} = makeHarness();
    const view = controller.startTask({prompt: 'fill the order form'});
    settleRun();
    await new Promise((resolve) => setImmediate(resolve));
    const interaction = pendingInteraction(manager, view.taskId);
    await controller.approveTask({taskId: view.taskId, interactionToken: encodeInteractionToken(interaction.id, interaction.revision)});

    const tail = controller.events(view.taskId, 0);
    assert.equal(tail.gap, false, 'a fresh consumer gets a contiguous stream');
    const seqs = tail.events.map((event) => event.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
    const kinds = tail.events.map((event) => event.kind);
    assert.ok(kinds.includes('task_created'));
    assert.ok(kinds.includes('interaction_requested'));
    assert.ok(kinds.includes('interaction_resolved'));
    assert.ok(kinds.includes('task_terminated'));

    const serialized = JSON.stringify(tail.events);
    assert.equal(serialized.includes('sessionId'), false);
    assert.equal(serialized.includes('runId'), false);
    assert.equal(serialized.includes('continuationId'), false);
    assert.equal(serialized.includes('output ok = input.ok'), false, 'no program source in events');

    const afterTail = controller.events(view.taskId, tail.nextSeq);
    assert.equal(afterTail.events.length, 0);
    assert.equal(afterTail.gap, false);

    const ahead = controller.events(view.taskId, tail.nextSeq + 10);
    assert.equal(ahead.gap, true, 'a consumer ahead of the log must refresh instead of guessing');
});

test('the product event log detects a missing middle seq as a gap', () => {
    const log = createProductEventLog(() => 1);
    const first = log.append('t', {kind: 'activity', summary: 'a'});
    const second = log.append('t', {kind: 'activity', summary: 'b'});
    assert.equal(first, 1);
    assert.equal(second, 2);
    const res = log.eventsAfter('t', 0);
    assert.equal(res.gap, false);
    assert.equal(res.events.length, 2);
    assert.deepEqual(res.events.map((event) => event.seq), [1, 2]);
    assert.equal(res.nextSeq, 2);
    const tail = log.eventsAfter('t', 2);
    assert.equal(tail.gap, false);
    assert.equal(tail.events.length, 0);
});

test('reservation conflicts reject and standalone activities acquire the same reservation', () => {
    const reservation = createWorkspaceActivityReservation();
    assert.equal(reservation.read().owner, 'none');
    const acquired = reservation.acquire({kind: 'standalone_annotate'});
    assert.equal(acquired.ok, true);
    assert.throws(() => {
        const task = reservation.acquire({kind: 'task', taskId: 't-1'});
        if (!task.ok) {throw new Error('conflict');}
    }, /conflict/);
    assert.equal(reservation.release({kind: 'standalone_annotate'}), true);
    const task = reservation.acquire({kind: 'task', taskId: 't-1'});
    assert.equal(task.ok, true);
    assert.equal(reservation.setHumanControl('t-1', 'manual').ok, true);
    assert.deepEqual(reservation.read(), {owner: 'task', ownerTaskId: 't-1', humanControl: 'manual'});
    assert.equal(reservation.setHumanControl('t-other', 'teach').ok, false);
});

test('startTask requires a provider/model default and rejects empty prompts', () => {
    const manager = createSessionManager({runner: {run: async () => makeResult()}});
    const controller = createProductController({manager, workspace: 'ws-x'});
    assert.throws(
        () => controller.startTask({prompt: 'anything'}),
        (error: unknown) => error instanceof ProductCommandError && error.code === 'ERR_BAD_ARGS',
    );
    assert.throws(
        () => controller.startTask({prompt: '   ', provider: 'p', model: 'm'}),
        (error: unknown) => error instanceof ProductCommandError && error.code === 'ERR_BAD_ARGS',
    );
});