import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createProductController,
    type ProductAuthoringBridge,
    type ProductControllerHandle,
    type StructuredTeachSnapshot,
} from '../../content/product_controller.js';
import {
    ProductTransportError,
    type BackendEventsResponse,
    type BackendTaskList,
    type BackendTaskView,
    type BackendWorkspaceView,
    type ProductBackendClient,
} from '../../shared/product_transport.js';

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
    promptSummary: 'Fill the order form',
    reportAvailable: false,
    resumable: false,
    createdAt: 1000,
    endedAt: null,
    lastSeq: 0,
    ...overrides,
});

type BridgeLog = { name: string; args: unknown[] };

type TestBridge = ProductAuthoringBridge & {
    readonly log: BridgeLog[];
    structured: StructuredTeachSnapshot | null;
    demo: {status: 'idle' | 'review'; stepCount: number} | null;
    openResult: boolean;
};

const makeBridge = (): TestBridge => {
    const log: BridgeLog[] = [];
    const push = (name: string) => (...args: unknown[]): void => {
        log.push({ name, args });
    };
    const bridge: TestBridge = {
        log,
        structured: null,
        demo: null,
        openResult: true,
        beginStructuredTeach: (kind, selector) => { push('beginStructuredTeach')(kind, selector); },
        stopStructuredTeach: () => { push('stopStructuredTeach')(); },
        saveStructuredTeach: () => { push('saveStructuredTeach')(); },
        discardStructuredTeach: () => { push('discardStructuredTeach')(); },
        readStructuredTeachState: () => Promise.resolve(bridge.structured),
        startDemonstration: () => { push('startDemonstration')(); },
        stopDemonstration: () => { push('stopDemonstration')(); },
        saveDemonstration: () => { push('saveDemonstration')(); },
        discardDemonstration: () => { push('discardDemonstration')(); },
        readDemonstrationState: () => Promise.resolve(bridge.demo),
        openAnnotator: (profileName) => {
            push('openAnnotator')(profileName);
            return Promise.resolve(bridge.openResult);
        },
        closeAnnotator: () => { push('closeAnnotator')(); },
        endLinkedTeach: () => { push('endLinkedTeach')(); },
    };
    return bridge;
};

type Live = { name: string; args: unknown[] };

const makeClient = (options: {libraryUnavailable?: boolean} = {}): ProductBackendClient & {
    live: Live[];
    reservation: {current: Record<string, unknown>};
} => {
    const live: Live[] = [];
    // The stub mirrors the backend reservation state machine: begin/end
    // authoring and takeover mutate what the next workspaceView reports.
    const reservation: {current: Record<string, unknown>} = {
        current: { owner: 'none', humanControl: 'none' },
    };
    const client = {
        live,
        reservation,
    } as unknown as ProductBackendClient & {
        live: Live[];
        reservation: {current: Record<string, unknown>};
    };
    const log = (name: string, args: unknown[]): void => {
        live.push({ name, args });
    };
    const defaultWorkspaceView = (): BackendWorkspaceView => {
        const owner = reservation.current.owner;
        const humanControl = reservation.current.humanControl ?? 'none';
        return {
            workspace: 'ws-1',
            reservation: reservation.current,
            ...(owner === 'task'
                ? {
                    activeTask: task({
                        status: 'waiting_for_user',
                        phase: 'interacting',
                        interaction: takeoverCard(humanControl === 'none' ? 'offered' : 'active'),
                    }),
                }
                : {}),
        };
    };
    client.workspaceView = () => {
        log('workspaceView', []);
        return Promise.resolve(defaultWorkspaceView());
    };
    client.listTasks = (): Promise<BackendTaskList> => {
        log('listTasks', []);
        return Promise.resolve({ active: [], history: [] });
    };
    client.startTask = (): Promise<BackendTaskView> => {
        log('startTask', []);
        return Promise.resolve(task());
    };
    client.taskView = (): Promise<BackendTaskView> => Promise.resolve(task());
    client.events = (): Promise<BackendEventsResponse> =>
        Promise.resolve({ events: [], nextSeq: 0, gap: false });
    client.stopTask = (): Promise<BackendTaskView> => Promise.resolve(task());
    client.approve = (): Promise<BackendTaskView> => Promise.resolve(task());
    client.deny = (): Promise<BackendTaskView> => Promise.resolve(task());
    client.answer = (): Promise<BackendTaskView> => Promise.resolve(task());
    client.chooseRecovery = (): Promise<BackendTaskView> => Promise.resolve(task());
    client.beginGuidance = (_taskId, _token, mode): Promise<BackendTaskView> => {
        log('takeover', [mode]);
        if (reservation.current.owner === 'task') {
            reservation.current = { ...reservation.current, humanControl: mode };
        }
        return Promise.resolve(task({
            status: 'waiting_for_user',
            phase: 'interacting',
            interaction: takeoverCard('active'),
        }));
    };
    client.returnControl = (_taskId, _token, mode, savedReference): Promise<BackendTaskView> => {
        log('returnControl', [mode, savedReference]);
        if (reservation.current.owner === 'task') {
            reservation.current = { ...reservation.current, humanControl: 'none' };
        }
        return Promise.resolve(task({ status: 'running' }));
    };
    client.beginAuthoring = (input): Promise<BackendWorkspaceView> => {
        log('beginAuthoring', [input]);
        reservation.current = input.activity === 'teach'
            ? { owner: 'standalone_teach', humanControl: 'none', teachKind: input.teachKind }
            : { owner: 'standalone_annotate', humanControl: 'none' };
        return Promise.resolve({ workspace: 'ws-1', reservation: reservation.current });
    };
    client.endAuthoring = (outcome): Promise<BackendWorkspaceView> => {
        log('endAuthoring', [outcome]);
        if (reservation.current.owner === 'standalone_teach' || reservation.current.owner === 'standalone_annotate') {
            reservation.current = { owner: 'none', humanControl: 'none' };
        }
        return Promise.resolve({ workspace: 'ws-1', reservation: reservation.current });
    };
    client.librarySummary = (): Promise<Record<string, unknown>> => {
        log('librarySummary', []);
        if (options.libraryUnavailable) {
            return Promise.reject(new ProductTransportError('not_found', 'library projection unavailable', {
                detailCode: 'ERR_LIBRARY_UNAVAILABLE',
            }));
        }
        return Promise.resolve({
            procedures: [{ name: 'Ensure login', health: 'needs_review' }],
        });
    };
    return client;
};

const takeoverCard = (stage: 'offered' | 'active'): Record<string, unknown> => ({
    kind: 'takeover',
    interactionToken: 'tok-2',
    reason: 'captcha requires a human',
    scope: 'workspace',
    stage,
    guidanceModes: ['manual', 'teach', 'annotate'],
    teachKind: 'procedure',
});

const create = (
    client: ProductBackendClient & { live: Live[] },
    bridge: TestBridge,
): ProductControllerHandle => createProductController({
    client,
    workspace: 'ws-1',
    now: () => 10_000,
    authoring: bridge,
});

test('a Task reservation blocks standalone Teach and Annotate on the client', async () => {
    const client = makeClient();
    client.reservation.current = { owner: 'task', ownerTaskId: 'task-1', humanControl: 'none' };
    const bridge = makeBridge();
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.startTeach('procedure', 'sel');
    controller.commands.openAnnotate();
    await settle();

    assert.equal(client.live.some((entry) => entry.name === 'beginAuthoring'), false,
        'no standalone reservation may be requested while a Task owns the workspace');
    assert.equal(controller.getView().startError?.kind, 'workspace');
    assert.equal(bridge.log.some((entry) => entry.name === 'beginStructuredTeach'), false,
        'the recorder must not be opened for a blocked activity');
});

test('begin Teach acquires the backend reservation first, then opens the recorder setup', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.startTeach('procedure', 'orders\u0000orders-form');
    await settle();

    assert.deepEqual(
        client.live.find((entry) => entry.name === 'beginAuthoring')?.args,
        [{ activity: 'teach', teachKind: 'procedure' }],
    );
    assert.deepEqual(
        bridge.log.find((entry) => entry.name === 'beginStructuredTeach')?.args,
        ['procedure', 'orders\u0000orders-form'],
        'procedure Teach drives the existing checkpoint recorder',
    );
    const view = controller.getView();
    assert.equal(view.reservation, 'teach');
    assert.equal(view.authoring?.teach?.phase, 'setup');
});

test('recovery Teach uses the recorder with the recovery kind; demonstration uses the generic record bridge', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.startTeach('recovery', 'orders\u0000error-dialog');
    await settle();
    assert.deepEqual(
        bridge.log.find((entry) => entry.name === 'beginStructuredTeach')?.args,
        ['recovery', 'orders\u0000error-dialog'],
        'recovery Teach drives the checkpoint recorder with kind recovery',
    );
    assert.deepEqual(
        client.live.find((entry) => entry.name === 'beginAuthoring')?.args,
        [{ activity: 'teach', teachKind: 'recovery' }],
    );
});

test('demonstration uses the generic record bridge, never the checkpoint recorder', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.startTeach('demonstration');
    await settle();

    assert.deepEqual(
        client.live.find((entry) => entry.name === 'beginAuthoring')?.args,
        [{ activity: 'teach', teachKind: 'demonstration' }],
    );
    assert.equal(bridge.log.some((entry) => entry.name === 'startDemonstration'), true,
        'Basic Demonstration uses the generic record.* bridge');
    assert.equal(bridge.log.some((entry) => entry.name === 'beginStructuredTeach'), false,
        'demonstration must never open the checkpoint recorder');

    // No transient fake recording: until the real record.start succeeds the
    // panel must not claim a recording is live.
    assert.equal(controller.getView().authoring?.teach?.phase, 'setup',
        'a just-reserved demonstration is not yet recording');

    // The observed successful record.start is what flips it to recording.
    controller.noteAuthoringAction({ type: 'record.start', ok: true });
    await settle();
    assert.equal(controller.getView().authoring?.teach?.phase, 'recording',
        'recording state follows the real record.start success notice');
});

test('a failed record.start releases the reservation instead of faking a recording', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.startTeach('demonstration');
    await settle();
    assert.equal(controller.getView().authoring?.teach?.phase, 'setup');

    controller.noteAuthoringAction({
        type: 'record.start',
        ok: false,
        reply: { message: 'record.start requires at least one bound page' },
    });
    await settle();
    assert.deepEqual(
        client.live.find((entry) => entry.name === 'endAuthoring')?.args,
        ['discarded'],
        'a start that never began releases the standalone reservation',
    );
    assert.equal(controller.getView().reservation, 'idle');
    assert.equal(controller.getView().authoring?.teach, undefined);
});

test('structured save releases the reservation and re-observes the Library', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.startTeach('procedure');
    await settle();
    const librariesBefore = client.live.filter((entry) => entry.name === 'librarySummary').length;

    controller.noteAuthoringAction({
        type: 'checkpoint.record.save',
        ok: true,
        payload: { kind: 'procedure', name: '查询订单', mappings: [] },
        reply: { saved: true, checkpointId: 'order-query-1', name: '查询订单', stepCount: 3 },
    });
    await settle();

    assert.deepEqual(
        client.live.find((entry) => entry.name === 'endAuthoring')?.args,
        ['saved'],
        'save releases the standalone reservation',
    );
    assert.ok(client.live.filter((entry) => entry.name === 'librarySummary').length > librariesBefore,
        'a saved asset is made visible through the Library seam');
    assert.equal(controller.getView().reservation, 'idle');
    assert.equal(controller.getView().authoring?.teach, undefined);
});

test('recorder discard releases the reservation without a Library refresh', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.startTeach('recovery');
    await settle();
    controller.noteAuthoringAction({ type: 'checkpoint.record.cancel', ok: true });
    await settle();

    assert.deepEqual(
        client.live.find((entry) => entry.name === 'endAuthoring')?.args,
        ['discarded'],
    );
    assert.equal(controller.getView().reservation, 'idle');
});

test('discarding a setup-phase Teach with nothing recorded releases the reservation directly', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.startTeach('procedure');
    await settle();
    assert.equal(controller.getView().authoring?.teach?.phase, 'setup');
    assert.equal(controller.getView().authoring?.teach?.unsavedAsset, false);

    controller.commands.discardTeach();
    await settle();
    assert.deepEqual(
        client.live.find((entry) => entry.name === 'endAuthoring')?.args,
        ['discarded'],
        'the panel must be able to end an owned-but-not-yet-recording activity',
    );
    assert.equal(controller.getView().reservation, 'idle');
});

test('Annotate acquires the reservation and opens the existing canvas; observed traffic projects coarse truth', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.openAnnotate();
    await settle();
    assert.deepEqual(
        client.live.find((entry) => entry.name === 'beginAuthoring')?.args,
        [{ activity: 'annotate' }],
    );
    assert.deepEqual(bridge.log.find((entry) => entry.name === 'openAnnotator')?.args, [undefined],
        'the existing Annotator Canvas session is reused');

    controller.noteAuthoringAction({ type: 'entity_rules.annotator.open', ok: true });
    controller.noteAuthoringAction({
        type: 'entity_rules.annotator.apply',
        ok: true,
        payload: { canvasDraft: { profileName: 'orders', entities: [{ id: 'e1' }] } },
    });
    await settle();
    const annotate = controller.getView().authoring?.annotate;
    assert.equal(annotate?.active, true);
    assert.equal(annotate.canvasOpen, true);
    assert.equal(annotate.stage, 'edit');
    assert.equal(annotate.dirty, true, 'apply observed on the canvas is real unsaved state');

    controller.noteAuthoringAction({
        type: 'entity_rules.annotator.save',
        ok: true,
        // Real canvas-v1 save request carries canvasDraft (no `draft`); the
        // authoritative identity is the reply's profileName.
        payload: {
            canvasDraft: {
                profileName: 'orders-draft',
                entities: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
            },
            profileName: 'orders-draft',
        },
        reply: { profileName: 'orders-page', artifactRevision: 'r7', saved: true },
    });
    await settle();
    assert.deepEqual(
        client.live.find((entry) => entry.name === 'endAuthoring')?.args,
        ['saved'],
        'standalone Save and Exit finishes the owned activity immediately',
    );
    assert.equal(controller.getView().authoring?.annotate, undefined,
        'the standalone annotate surface leaves authoring after a successful save');
});

test('a failed annotator open releases the reservation instead of faking an activity', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    bridge.openResult = false;
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.openAnnotate();
    await settle();
    assert.deepEqual(
        client.live.find((entry) => entry.name === 'endAuthoring')?.args,
        ['discarded'],
    );
    assert.equal(controller.getView().startError?.kind, 'service');
});

test('task-linked takeover Teach reuses the Task reservation, launches the tool and returns the saved reference to the same task', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    client.reservation.current = { owner: 'task', ownerTaskId: 'task-1', humanControl: 'none' };
    const controller = create(client, bridge);
    await controller.refresh();

    controller.commands.beginHumanGuidance('teach');
    await settle();
    assert.equal(client.live.some((entry) => entry.name === 'beginAuthoring'), false,
        'linked guidance must never acquire a second standalone reservation');
    await controller.refresh();
    await settle();
    assert.deepEqual(
        bridge.log.find((entry) => entry.name === 'beginStructuredTeach')?.args,
        ['procedure', undefined],
        'the existing checkpoint recorder is started under the Task reservation',
    );

    controller.noteAuthoringAction({
        type: 'checkpoint.record.save',
        ok: true,
        payload: { kind: 'procedure', name: '登录表单', mappings: [] },
        reply: { saved: true, checkpointId: 'login-form-1', name: '登录表单', stepCount: 2 },
    });
    await settle();
    assert.equal(client.live.some((entry) => entry.name === 'endAuthoring'), false,
        'linked save must not release the Task-owned reservation');

    controller.commands.returnControl();
    await settle();
    const returned = client.live.find((entry) => entry.name === 'returnControl');
    assert.deepEqual(returned?.args, ['teach', 'procedure:login-form-1'],
        'return-control carries the stable artifact identity (checkpointId) to the same task');
    assert.equal(bridge.log.some((entry) => entry.name === 'endLinkedTeach'), true,
        'return-control ends the linked authoring activity');
});

test('a reloaded surface adopts the backend reservation but reports recording as interrupted, never resumed', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    bridge.structured = {
        status: 'recording',
        kind: 'procedure',
        stepCount: 4,
        stepSummaries: ['点击查询', '填写单号', '选择日期', '提交'],
        businessAreas: [{ profileName: 'orders', label: '订单页', entityCount: 3, selector: 'orders\u0000orders-form' }],
        selectedSelector: 'orders\u0000orders-form',
    };
    const controller = create(client, bridge);

    // Simulate an extension reload: the page-side recorder cannot re-arm, but
    // the backend still owns a standalone Teach reservation in recording state.
    client.reservation.current = { owner: 'standalone_teach', humanControl: 'none', teachKind: 'procedure' };
    await controller.refresh();

    const teach = controller.getView().authoring?.teach;
    assert.equal(controller.getView().reservation, 'teach', 'the reloaded surface adopts the real reservation');
    assert.equal(teach?.phase, 'recording');
    assert.equal(teach.interrupted, true,
        'recording the page never confirmed must project as interrupted, not as a live recording');
    assert.equal(teach.review, undefined);
});

test('library unavailability is projected truthfully instead of an empty success', async () => {
    const client = makeClient({ libraryUnavailable: true });
    const bridge = makeBridge();
    const controller = create(client, bridge);
    await controller.refresh();
    assert.equal(controller.getView().libraryUnavailable, true);
});

test('the authoring projection never leaks internal ids or recorder selectors into visible summaries', async () => {
    const client = makeClient();
    const bridge = makeBridge();
    bridge.structured = {
        status: 'review',
        kind: 'procedure',
        stepCount: 2,
        stepSummaries: ['点击查询', '填写单号'],
        businessAreas: [{ profileName: 'orders', label: '订单页', entityCount: 3, selector: 'orders\u0000orders-form' }],
    };
    client.reservation.current = { owner: 'standalone_teach', humanControl: 'none', teachKind: 'procedure' };
    const controller = create(client, bridge);
    await controller.refresh();

    const teach = controller.getView().authoring?.teach;
    assert.equal(teach?.phase, 'review');
    assert.deepEqual(teach.review?.stepSummaries, ['点击查询', '填写单号'],
        'human-readable labels produced by the existing recorder pass through');
    const serialized = JSON.stringify(controller.getView());
    for (const leak of ['checkpointId', 'stepId', 'sessionId', 'runId', 'entity_rules', 'body.dsl']) {
        assert.equal(serialized.includes(leak), false, `${leak} must never appear in the product projection`);
    }
});
