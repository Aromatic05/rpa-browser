import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductController } from '../../content/product_controller.js';
import type { ProductControllerHandle } from '../../content/product_controller.js';
import {
    ProductTransportError,
    type BackendEventsResponse,
    type BackendTaskList,
    type BackendTaskView,
    type BackendWorkspaceView,
    type ProductBackendClient,
} from '../../shared/product_transport.js';

type CallLog = { name: string; args: unknown[] };

const settle = async (): Promise<void> => {
    for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
    }
};

const task = (overrides: Partial<BackendTaskView> = {}): BackendTaskView => ({
    taskId: 'task-1',
    status: 'running',
    title: 'Fill the order form',
    promptSummary: 'Fill the order form and submit',
    reportAvailable: false,
    resumable: false,
    createdAt: 1000,
    endedAt: null,
    lastSeq: 1,
    ...overrides,
});

const approvalInteraction = {
    kind: 'approval',
    interactionToken: 'tok-1',
    actionName: 'browser.submit',
    summary: 'Submits the order',
    risk: 'irreversible' as const,
};

const workspace = (active?: BackendTaskView): BackendWorkspaceView => ({
    workspace: 'ws-1',
    reservation: {
        owner: active ? 'task' : 'none',
        ...(active ? { ownerTaskId: active.taskId } : {}),
        humanControl: 'none',
    },
    ...(active ? { activeTask: active } : {}),
});

class StubBackend implements ProductBackendClient {
    readonly live: CallLog[] = [];

    workspaceImpl: () => BackendWorkspaceView = () => workspace();
    listImpl: () => BackendTaskList = () => ({ active: [], history: [] });
    startImpl: (prompt: string) => BackendTaskView = (prompt) =>
        task({ status: 'running', title: prompt, promptSummary: prompt });
    taskViewImpl: () => BackendTaskView = () => task();
    eventsImpl: (afterSeq: number) => BackendEventsResponse = () => ({
        events: [],
        nextSeq: 0,
        gap: false,
    });
    pauseImpl: () => BackendTaskView = () => task({ status: 'paused', resumable: true });
    resumeImpl: () => BackendTaskView = () => task({ status: 'running' });
    stopImpl: () => BackendTaskView = () => task({ status: 'cancelled' });
    approveImpl: (token: string) => BackendTaskView = (_token: string) => task({ status: 'running' });
    denyImpl: (token: string, reason: string) => BackendTaskView = () => task({ status: 'running' });
    answerImpl: (token: string, value: unknown) => BackendTaskView = () => task({ status: 'running' });
    recoveryImpl: (token: string, optionId: string) => BackendTaskView = () => task({ status: 'running' });
    takeoverImpl: (token: string, mode: string) => BackendTaskView = () => task({ status: 'running' });
    returnControlImpl: (token: string, mode: string, savedReference?: string) => BackendTaskView = () => task({ status: 'running' });

    private log(name: string, args: unknown[]): void {
        this.live.push({ name, args });
    }

    workspaceView(): Promise<BackendWorkspaceView> {
        this.log('workspaceView', []);
        return Promise.resolve(this.workspaceImpl());
    }

    listTasks(): Promise<BackendTaskList> {
        this.log('listTasks', []);
        return Promise.resolve(this.listImpl());
    }

    startTask(prompt: string): Promise<BackendTaskView> {
        this.log('startTask', [prompt]);
        return Promise.resolve(this.startImpl(prompt));
    }

    taskView(taskId: string): Promise<BackendTaskView> {
        this.log('taskView', [taskId]);
        return Promise.resolve(this.taskViewImpl());
    }

    events(taskId: string, afterSeq: number): Promise<BackendEventsResponse> {
        this.log('events', [taskId, afterSeq]);
        return Promise.resolve(this.eventsImpl(afterSeq));
    }

    pauseTask(taskId: string): Promise<BackendTaskView> {
        this.log('pauseTask', [taskId]);
        return Promise.resolve(this.pauseImpl());
    }

    resumeTask(taskId: string): Promise<BackendTaskView> {
        this.log('resumeTask', [taskId]);
        return Promise.resolve(this.resumeImpl());
    }

    saveAutomation(taskId: string, name: string): Promise<{saved: boolean; name: string; reason?: 'conflict'}> {
        this.log('saveAutomation', [taskId, name]);
        return Promise.resolve({saved: true, name});
    }

    stopTask(taskId: string): Promise<BackendTaskView> {
        this.log('stopTask', [taskId]);
        return Promise.resolve(this.stopImpl());
    }

    approve(taskId: string, interactionToken: string): Promise<BackendTaskView> {
        this.log('approve', [taskId, interactionToken]);
        return Promise.resolve(this.approveImpl(interactionToken));
    }

    deny(taskId: string, interactionToken: string, reason: string, requestedAlternative?: string): Promise<BackendTaskView> {
        this.log('deny', [taskId, interactionToken, reason, requestedAlternative]);
        return Promise.resolve(this.denyImpl(interactionToken, reason));
    }

    answer(taskId: string, interactionToken: string, value: unknown): Promise<BackendTaskView> {
        this.log('answer', [taskId, interactionToken, value]);
        return Promise.resolve(this.answerImpl(interactionToken, value));
    }

    chooseRecovery(taskId: string, interactionToken: string, optionId: string): Promise<BackendTaskView> {
        this.log('recovery', [taskId, interactionToken, optionId]);
        return Promise.resolve(this.recoveryImpl(interactionToken, optionId));
    }

    beginGuidance(taskId: string, interactionToken: string, mode: string): Promise<BackendTaskView> {
        this.log('takeover', [taskId, interactionToken, mode]);
        return Promise.resolve(this.takeoverImpl(interactionToken, mode));
    }

    returnControl(taskId: string, interactionToken: string, mode: string, savedReference?: string): Promise<BackendTaskView> {
        this.log('returnControl', [taskId, interactionToken, mode, savedReference]);
        return Promise.resolve(this.returnControlImpl(interactionToken, mode, savedReference));
    }

    beginAuthoringImpl: (input: {activity: string; teachKind?: string}) => BackendWorkspaceView = (input) => ({
        workspace: 'ws-1',
        reservation: {
            owner: input.activity === 'teach' ? 'standalone_teach' : 'standalone_annotate',
            humanControl: 'none',
            ...(input.activity === 'teach' && input.teachKind ? {teachKind: input.teachKind} : {}),
        },
    });

    beginAuthoring(input: {activity: 'teach'; teachKind: string} | {activity: 'annotate'}): Promise<BackendWorkspaceView> {
        this.log('beginAuthoring', [input]);
        return Promise.resolve(this.beginAuthoringImpl(input));
    }

    endAuthoringImpl: () => BackendWorkspaceView = () => ({
        workspace: 'ws-1',
        reservation: { owner: 'none', humanControl: 'none' },
    });

    endAuthoring(outcome: string): Promise<BackendWorkspaceView> {
        this.log('endAuthoring', [outcome]);
        return Promise.resolve(this.endAuthoringImpl());
    }

    librarySummaryImpl: () => Record<string, unknown> = () => ({
        procedures: [{ name: 'Ensure login', health: 'needs_review' }],
    });

    librarySummary(): Promise<Record<string, unknown>> {
        this.log('librarySummary', []);
        return Promise.resolve(this.librarySummaryImpl());
    }
}

const create = (backend: StubBackend): ProductControllerHandle =>
    createProductController({ client: backend, workspace: 'ws-1', now: () => 10_000 });

test('adapter maps the real backend workspace projection into the typed view', async () => {
    const backend = new StubBackend();
    backend.workspaceImpl = () => workspace(task({ status: 'waiting_for_user', phase: 'interacting', interaction: approvalInteraction }));
    const controller = create(backend);
    await controller.refresh();

    const view = controller.getView();
    assert.equal(view.workspace, 'ws-1');
    assert.equal(view.connection, 'connected');
    assert.equal(view.reservation, 'task', 'reservation object maps owner task -> product task');
    const activeTask = view.activeTask;
    if (!activeTask) {
        assert.fail('expected a projected active task');
    }
    assert.equal(activeTask.title, 'Fill the order form');
    assert.equal(activeTask.status, 'waiting_for_user');
    assert.equal(activeTask.phase, 'interacting');
    const interaction = activeTask.interaction;
    if (!interaction) {
        assert.fail('expected a projected interaction');
    }
    if (interaction.kind !== 'approval') {
        assert.fail('expected an approval interaction');
    }
    assert.equal(interaction.effectName, 'browser.submit', 'backend actionName maps to product effectName');
    assert.equal(interaction.evidence, 'Submits the order', 'backend summary maps to evidence');
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes('sessionId'), false);
    assert.equal(serialized.includes('runId'), false);
    assert.equal(serialized.includes('continuationId'), false);
    assert.equal(serialized.includes('executionMode'), false);
    assert.equal(serialized.includes('provider'), false);
});

test('terminal tasks list into history when the workspace is idle', async () => {
    const backend = new StubBackend();
    backend.listImpl = () => ({
        active: [],
        history: [
            task({ status: 'completed', endedAt: 7000 }),
            task({ status: 'cancelled', endedAt: 8000 }),
        ],
    });
    const controller = create(backend);
    await controller.refresh();
    const view = controller.getView();
    assert.equal(view.reservation, 'idle', 'owner none projects to idle');
    assert.equal(view.history.length, 2, 'terminal tasks project into history');
    assert.deepEqual(
        view.history.map((entry) => entry.outcome).sort(),
        ['cancelled', 'completed'],
        'terminal outcomes map into history entries',
    );
    assert.equal(
        controller.getView().history[0]?.taskId,
        'task-1',
        'history entries keep the opaque taskId only',
    );
});

test('a task result stays selected after completion until the user starts a new task', async () => {
    const backend = new StubBackend();
    let active: BackendTaskView | undefined = task({status: 'running'});
    const completed = task({
        status: 'completed',
        result: {outcome: 'completed', summary: 'done', saveEligible: true},
        endedAt: 9000,
    });
    backend.workspaceImpl = () => workspace(active);
    backend.taskViewImpl = () => completed;
    backend.listImpl = () => ({active: [], history: [completed]});
    const controller = create(backend);

    await controller.refresh();
    assert.equal(controller.getView().activeTask?.status, 'running');

    active = undefined;
    await controller.refresh();
    assert.equal(controller.getView().reservation, 'idle');
    assert.equal(controller.getView().activeTask?.status, 'completed', 'result remains visible after reservation release');
    assert.equal(controller.getView().activeTask?.result?.saveEligible, true);

    controller.commands.newTask();
    assert.equal(controller.getView().activeTask, undefined, 'New Task explicitly dismisses the retained result');
});

test('startTask sends only the prompt and uses product defaults (no provider/model fields)', async () => {
    const backend = new StubBackend();
    let active: BackendTaskView | undefined;
    backend.workspaceImpl = () => workspace(active);
    backend.listImpl = () => ({ active: active ? [active] : [], history: [] });
    backend.startImpl = (prompt) => {
        active = task({ status: 'running', title: prompt, promptSummary: prompt, lastSeq: 1 });
        return active;
    };
    const controller = create(backend);
    await controller.refresh();
    assert.equal(controller.getView().activeTask, undefined, 'idle before start');

    controller.commands.startTask('  do the thing  ');
    await settle();

    const start = backend.live.find((entry) => entry.name === 'startTask');
    assert.ok(start, 'startTask was dispatched');
    assert.deepEqual(start.args, ['do the thing'], 'the only start input is the prompt');

    const view = controller.getView();
    assert.equal(view.activeTask?.title, 'do the thing');
    assert.equal(view.connection, 'connected');
    const serialized = JSON.stringify(view);
    assert.equal(serialized.includes('"executionMode"'), false);
    assert.equal(serialized.includes('"model"'), false);
});

test('active task refresh appends the event cursor and dedupes by sequence', async () => {
    const backend = new StubBackend();
    backend.workspaceImpl = () => workspace(task({ status: 'running', lastSeq: 2 }));
    backend.eventsImpl = (afterSeq) => {
        if (afterSeq === 0) {
            return {
                events: [
                    { seq: 1, taskId: 'task-1', at: 10, kind: 'task_created', promptSummary: 'Fill', startedAt: 10 },
                    { seq: 2, taskId: 'task-1', at: 20, kind: 'interaction_requested', interactionKind: 'irreversible-effect-approval', headline: 'browser.submit', deadlineAt: 60 },
                ],
                nextSeq: 2,
                gap: false,
            };
        }
        return { events: [], nextSeq: 2, gap: false };
    };
    const controller = create(backend);
    await controller.refresh();
    assert.equal(controller.getView().activeTask?.timeline.length, 2);

    await controller.refresh();
    assert.equal(controller.getView().activeTask?.timeline.length, 2, 'calling refresh again does not duplicate events');
});

test('a sequence gap rebuilds the timeline from the head (no guessed state)', async () => {
    const backend = new StubBackend();
    backend.workspaceImpl = () => workspace(task({ status: 'waiting_for_user', phase: 'interacting', interaction: approvalInteraction, lastSeq: 3 }));
    let head = 3;
    backend.eventsImpl = (afterSeq) => {
        if (afterSeq === 0) {
            return {
                events: [
                    { seq: 1, taskId: 'task-1', at: 10, kind: 'task_created', promptSummary: 'Fill', startedAt: 10 },
                    { seq: 2, taskId: 'task-1', at: 20, kind: 'interaction_requested', interactionKind: 'irreversible-effect-approval', headline: 'browser.submit', deadlineAt: 60 },
                    { seq: 3, taskId: 'task-1', at: 30, kind: 'interaction_resolved', interactionKind: 'irreversible-effect-approval', decisionSummary: 'Approved' },
                ],
                nextSeq: 3,
                gap: false,
            };
        }
        if (afterSeq === 2) {
            head = 5;
            return { events: [{ seq: 5, taskId: 'task-1', at: 50, kind: 'activity', summary: 'stepping' }], nextSeq: 5, gap: true };
        }
        return { events: [], nextSeq: head, gap: false };
    };
    const controller = create(backend);
    await controller.refresh();
    assert.equal(controller.getView().activeTask?.timeline.length, 3);

    await controller.refresh();
    const timeline = controller.getView().activeTask?.timeline ?? [];
    assert.equal(timeline.length, 3, 'a detected gap rebuilds from seq 0 instead of merging a hole');
    assert.deepEqual(timeline.map((event) => event.at), [10, 20, 30]);
});

test('interaction commands use the opaque token and refresh on success', async () => {
    const backend = new StubBackend();
    backend.workspaceImpl = () => workspace(task({ status: 'waiting_for_user', phase: 'interacting', interaction: approvalInteraction }));
    const controller = create(backend);
    await controller.refresh();

    controller.commands.approve();
    await settle();
    assert.deepEqual(
        backend.live.find((entry) => entry.name === 'approve')?.args,
        ['task-1', 'tok-1'],
        'approve carries taskId + interaction token',
    );
    assert.equal(backend.live.filter((entry) => entry.name === 'approve').length, 1, 'no automatic retries');
});

test('deny requires a reason and forwards optional alternative only when given', async () => {
    const backend = new StubBackend();
    backend.workspaceImpl = () => workspace(task({ status: 'waiting_for_user', phase: 'interacting', interaction: approvalInteraction }));
    const controller = create(backend);
    await controller.refresh();

    controller.commands.deny('   ', undefined);
    await settle();
    assert.equal(backend.live.some((entry) => entry.name === 'deny'), false, 'empty reason is rejected client-side');

    controller.commands.deny('manual review', 'use a sandbox');
    await settle();
    assert.deepEqual(
        backend.live.find((entry) => entry.name === 'deny')?.args,
        ['task-1', 'tok-1', 'manual review', 'use a sandbox'],
    );
});

test('clarification, recovery, takeover and return-control map to product commands', async () => {
    const backend = new StubBackend();
    const takeoverCard = (): BackendTaskView['interaction'] => ({
        kind: 'takeover',
        interactionToken: 'tok-2',
        reason: 'user should drive this',
        scope: 'tab',
        stage: 'active',
        guidanceModes: ['manual', 'teach', 'annotate'],
    });
    backend.workspaceImpl = () => workspace(task({ status: 'waiting_for_user', phase: 'interacting', interaction: takeoverCard() }));
    const controller = create(backend);
    await controller.refresh();

    controller.commands.beginHumanGuidance('manual');
    await settle();
    assert.deepEqual(
        backend.live.find((entry) => entry.name === 'takeover')?.args,
        ['task-1', 'tok-2', 'manual'],
    );

    controller.commands.returnControl();
    await settle();
    assert.deepEqual(
        backend.live.find((entry) => entry.name === 'returnControl')?.args,
        ['task-1', 'tok-2', 'manual', undefined],
        'return-control reuses the mode the user took',
    );
});

test('return-control with an explicit active mode preserves it', async () => {
    const backend = new StubBackend();
    backend.workspaceImpl = () => workspace(task({
        status: 'waiting_for_user',
        phase: 'interacting',
        interaction: {
            kind: 'takeover',
            interactionToken: 'tok-9',
            reason: 'annotate required',
            scope: 'workspace',
            stage: 'active',
            guidanceModes: ['manual', 'teach', 'annotate'],
        },
    }));
    const controller = create(backend);
    await controller.refresh();

    controller.commands.beginHumanGuidance('teach');
    await settle();

    const view = controller.getView();
    const interaction = view.activeTask?.interaction;
    if (interaction?.kind !== 'takeover') {
        assert.fail('expected a takeover interaction after beginHumanGuidance refresh');
    }
    assert.equal(interaction.activeMode, 'teach', 'controller reflects the confirmed take-over mode');

    controller.commands.returnControl();
    await settle();
    assert.deepEqual(
        backend.live.find((entry) => entry.name === 'returnControl')?.args,
        ['task-1', 'tok-9', 'teach', undefined],
    );
});

test('a stale interaction token triggers an authoritative refresh and never auto-retries', async () => {
    const backend = new StubBackend();
    let stale = true;
    backend.approveImpl = () => {
        if (stale) {
            throw new ProductTransportError('stale', 'the interaction token is invalid or stale', { detailCode: 'ERR_STALE' });
        }
        return task({ status: 'running' });
    };
    backend.workspaceImpl = () => workspace(task({ status: 'waiting_for_user', phase: 'interacting', interaction: approvalInteraction }));
    const controller = create(backend);
    await controller.refresh();

    controller.commands.approve();
    await settle();
    assert.equal(backend.live.filter((entry) => entry.name === 'approve').length, 1, 'stale resolution is not retried');

    stale = false;
    controller.commands.approve();
    await settle();
    assert.equal(backend.live.filter((entry) => entry.name === 'approve').length, 2, 'a fresh token retries only on the next user action');
});

test('disconnect keeps the last-known sanitized projection with no fake changes', async () => {
    const backend = new StubBackend();
    const running = task({ status: 'running' });
    backend.workspaceImpl = () => workspace(running);
    const controller = create(backend);
    await controller.refresh();
    assert.equal(controller.getView().connection, 'connected');
    assert.ok(controller.getView().activeTask);

    backend.workspaceImpl = () => {
        throw new ProductTransportError('unreachable', 'connection refused');
    };
    await controller.refresh();
    const offline = controller.getView();
    assert.equal(offline.connection, 'disconnected');
    assert.ok(offline.activeTask, 'last-known active task is preserved');
    assert.equal(offline.reservation, 'task', 'last-known reservation is preserved');
    assert.equal(offline.reconnectAttempts, 1);
});

test('manual reconnect returns to connected and clears auto-attempt count', async () => {
    const backend = new StubBackend();
    let reachable = true;
    backend.workspaceImpl = () => {
        if (!reachable) {
            throw new ProductTransportError('unreachable', 'connection refused');
        }
        return workspace();
    };
    const controller = create(backend);
    await controller.refresh();
    reachable = false;
    await controller.refresh();
    assert.equal(controller.getView().connection, 'disconnected');

    reachable = true;
    controller.commands.reconnect();
    await settle();
    assert.equal(controller.getView().connection, 'connected');
    assert.equal(controller.getView().reconnectAttempts, 0);
});

test('a start command failure surfaces a truthful start error and stays open', async () => {
    const backend = new StubBackend();
    backend.workspaceImpl = () => workspace(task({ status: 'running' }));
    backend.startImpl = () => {
        throw new ProductTransportError('conflict', 'workspace already has an active activity', { detailCode: 'ERR_ACTIVITY_CONFLICT' });
    };
    const controller = create(backend);
    await controller.refresh();

    controller.commands.startTask('second task');
    await settle();
    const view = controller.getView();
    assert.equal(view.startError?.kind, 'workspace');
    assert.equal(view.connection, 'connected', 'a workspace conflict is not a connectivity failure');
    assert.ok(view.activeTask, 'the occupying task stays visible while the conflict holds');
});