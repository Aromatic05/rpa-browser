import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountProductFromContent } from '../../content/product_mount.js';
import type { ProductMountHandle } from '../../content/product_mount.js';
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

const task = (overrides: Record<string, unknown> = {}): BackendTaskView => ({
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

const connectedClient = (): ProductBackendClient & { live: CallLog[] } => {
    const live: CallLog[] = [];
    const future: BackendTaskView = task({
        status: 'waiting_for_user',
        phase: 'interacting',
        interaction: {
            kind: 'approval',
            interactionToken: 'tok-12345',
            actionName: 'browser.submit',
            summary: 'Submits the order',
            risk: 'irreversible',
        },
        sessionId: 'session-leak',
        runId: 'run-leak',
        continuationId: 'cont-leak',
    });
    return {
        live,
        workspaceView: async (): Promise<BackendWorkspaceView> => {
            live.push({ name: 'workspaceView', args: [] });
            const value: BackendWorkspaceView = {
                workspace: 'ws-1',
                reservation: { owner: 'task', ownerTaskId: 'task-1', humanControl: 'none' },
                activeTask: future,
            };
            return await Promise.resolve(value);
        },
        listTasks: async (): Promise<BackendTaskList> => {
            live.push({ name: 'listTasks', args: [] });
            return await Promise.resolve({ active: [], history: [] });
        },
        startTask: async (prompt): Promise<BackendTaskView> => {
            live.push({ name: 'startTask', args: [prompt] });
            return await Promise.resolve(future);
        },
        taskView: async () => await Promise.resolve(future),
        events: async (_taskId, afterSeq): Promise<BackendEventsResponse> => {
            live.push({ name: 'events', args: [afterSeq] });
            return await Promise.resolve(
                afterSeq === 0
                    ? {
                          events: [
                              { seq: 1, taskId: 'task-1', at: 10, kind: 'task_created', promptSummary: 'Fill the order form', startedAt: 10 },
                              { seq: 2, taskId: 'task-1', at: 20, kind: 'interaction_requested', interactionKind: 'irreversible-effect-approval', headline: 'browser.submit', deadlineAt: 60 },
                          ],
                          nextSeq: 2,
                          gap: false,
                      }
                    : { events: [], nextSeq: 2, gap: false },
            );
        },
        stopTask: async () => await Promise.resolve(future),
        approve: async () => await Promise.resolve(future),
        deny: async () => await Promise.resolve(future),
        answer: async () => await Promise.resolve(future),
        chooseRecovery: async () => await Promise.resolve(future),
        beginGuidance: async () => await Promise.resolve(future),
        returnControl: async () => await Promise.resolve(future),
        beginAuthoring: async (): Promise<BackendWorkspaceView> => await Promise.resolve(
            { workspace: 'ws-1', reservation: { owner: 'none', humanControl: 'none' } },
        ),
        endAuthoring: async (): Promise<BackendWorkspaceView> => await Promise.resolve(
            { workspace: 'ws-1', reservation: { owner: 'none', humanControl: 'none' } },
        ),
        librarySummary: async (): Promise<Record<string, unknown>> => await Promise.resolve({}),
    };
};

const setupDom = (): { dom: JSDOM; restore: () => void } => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/orders' });
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        Node: globalThis.Node,
        Event: globalThis.Event,
        KeyboardEvent: globalThis.KeyboardEvent,
        location: globalThis.location,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        HTMLInputElement: globalThis.HTMLInputElement,
        HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
        HTMLSelectElement: globalThis.HTMLSelectElement,
        HTMLOptionElement: globalThis.HTMLOptionElement,
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        Node: dom.window.Node,
        Event: dom.window.Event,
        KeyboardEvent: dom.window.KeyboardEvent,
        location: dom.window.location,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
        HTMLSelectElement: dom.window.HTMLSelectElement,
        HTMLOptionElement: dom.window.HTMLOptionElement,
    });
    return {
        dom,
        restore: () => {
            Object.assign(globalThis, previous);
            dom.window.close();
        },
    };
};

const bodyText = (shadow: ShadowRoot, panel: HTMLElement): string => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- textContent is nullable per lib.dom
    const text = `${shadow.textContent ?? ''}${panel.textContent ?? ''}`;
    return text.replace(/\s+/gu, ' ').trim();
};

test('mounting the product panel from the content surface is idempotent', async () => {
    const { restore } = setupDom();
    try {
        const client = connectedClient();
        const first = mountProductFromContent({
            workspaceName: 'ws-1',
            dispatchAction: () => Promise.resolve({}),
            client,
        });
        await settle();

        assert.equal(document.getElementById('rpa-product-panel') !== null, true, 'panel host mounted');
        const callsAfterFirst = client.live.filter((entry) => entry.name === 'workspaceView').length;

        const second = mountProductFromContent({
            workspaceName: 'ws-1',
            dispatchAction: () => Promise.resolve({}),
            client,
        });
        await settle();
        assert.equal(
            document.querySelectorAll('#rpa-product-panel').length,
            1,
            'no second host is created',
        );
        assert.equal(
            client.live.filter((entry) => entry.name === 'workspaceView').length,
            callsAfterFirst,
            'the second mount does not start a second controller',
        );

        first.unmount();
        assert.equal(document.getElementById('rpa-product-panel'), null, 'unmount removes the host');
        const third = mountProductFromContent({
            workspaceName: 'ws-1',
            dispatchAction: () => Promise.resolve({}),
            client,
        });
        assert.ok(third !== second, 'a fresh mount after unmount is a live handle');
        third.unmount();
    } finally {
        restore();
    }
});

test('the ordinary product surface never renders internal identifiers', async () => {
    const { dom, restore } = setupDom();
    try {
        const client = connectedClient();
        const handle: ProductMountHandle = mountProductFromContent({
            workspaceName: 'ws-1',
            dispatchAction: () => Promise.resolve({}),
            client,
        });
        try {
            await settle();
            const host = document.getElementById('rpa-product-panel') as HTMLElement;
            const shadow = host.shadowRoot as ShadowRoot;
            const launcher = shadow.querySelector('[data-rpa-product-launcher]') as HTMLButtonElement;
            launcher.click();

            const panel = shadow.querySelector('[data-rpa-product-panel]') as HTMLElement;
            const text = bodyText(shadow, panel);
            assert.equal(text.includes('Fill the order form'), true, 'task title is rendered');
            assert.equal(text.includes('browser.submit') || text.includes('Submits the order'), true, 'approval content is rendered');
            for (const secret of ['task-1', 'tok-12345', 'session-leak', 'run-leak', 'cont-leak', 'executionMode', 'provider']) {
                assert.equal(text.includes(secret), false, `identifier ${secret} must not be visible`);
            }
        } finally {
            handle.unmount();
            void dom;
        }
    } finally {
        restore();
    }
});

test('reconnecting restores the connected surface after an offline window', async () => {
    const { restore } = setupDom();
    try {
        const client = connectedClient();
        const original = client.workspaceView.bind(client);
        let offline = false;
        client.workspaceView = async () => {
            if (offline) {
                throw new ProductTransportError('unreachable', 'connection refused');
            }
            return await original();
        };
        const handle = mountProductFromContent({
            workspaceName: 'ws-1',
            dispatchAction: () => Promise.resolve({}),
            client,
        });
        try {
            await settle();
            offline = true;
            await handle.refresh();
            const host = document.getElementById('rpa-product-panel') as HTMLElement;
            const shadow = host.shadowRoot as ShadowRoot;
            const banner = shadow.querySelector('.rpa-connection-banner') as HTMLElement;
            assert.equal(banner.hidden, false, 'disconnected banner appears while offline');

            offline = false;
            await handle.refresh();
            assert.equal(banner.hidden, true, 'banner clears after reconnect');
        } finally {
            handle.unmount();
        }
    } finally {
        restore();
    }
});

type AuthoringCall = { type: string; payload: Record<string, unknown> };

const authoringClient = (
    reservation: {current: Record<string, unknown>},
    live: CallLog[],
): ProductBackendClient => ({
    workspaceView: () => {
        live.push({ name: 'workspaceView', args: [] });
        return Promise.resolve({ workspace: 'ws-1', reservation: reservation.current });
    },
    listTasks: () => {
        live.push({ name: 'listTasks', args: [] });
        return Promise.resolve({ active: [], history: [] });
    },
    startTask: () => {
        live.push({ name: 'startTask', args: [] });
        return Promise.resolve({});
    },
    taskView: () => Promise.resolve({}),
    events: () => Promise.resolve({ events: [], nextSeq: 0, gap: false }),
    stopTask: () => Promise.resolve({}),
    approve: () => Promise.resolve({}),
    deny: () => Promise.resolve({}),
    answer: () => Promise.resolve({}),
    chooseRecovery: () => Promise.resolve({}),
    beginGuidance: () => Promise.resolve({}),
    returnControl: () => Promise.resolve({}),
    beginAuthoring: (input) => {
        live.push({ name: 'beginAuthoring', args: [input] });
        reservation.current = input.activity === 'teach'
            ? { owner: 'standalone_teach', humanControl: 'none', teachKind: input.teachKind }
            : { owner: 'standalone_annotate', humanControl: 'none' };
        return Promise.resolve({ workspace: 'ws-1', reservation: reservation.current });
    },
    endAuthoring: (outcome) => {
        live.push({ name: 'endAuthoring', args: [outcome] });
        reservation.current = { owner: 'none', humanControl: 'none' };
        return Promise.resolve({ workspace: 'ws-1', reservation: reservation.current });
    },
    librarySummary: () => {
        live.push({ name: 'librarySummary', args: [] });
        return Promise.resolve({ procedures: [{ name: '查询订单', health: 'needs_review' }] });
    },
});

const recorderReply = (type: string, payload: Record<string, unknown>): unknown => ({
    v: 1,
    id: 'reply-1',
    type: `${type}.result`,
    payload,
});

const entityRulePayload = {
    status: 'idle',
    stepCount: 0,
    steps: [],
    entityRules: [{
        profileName: 'orders',
        businessTag: 'order-form',
        entityKind: 'form',
        label: '订单表单',
        fields: [{ fieldKey: 'a', label: 'A', targetKind: 'form.field' }],
        actions: [{ actionIntent: 'submit', label: '提交', targetKind: 'form.action' }],
        rowActions: [],
        outputs: [{ kind: 'none', label: '无' }],
    }],
};

const openTeachSurface = (shadow: ShadowRoot, panel: HTMLElement): void => {
    const launcher = shadow.querySelector('[data-rpa-product-launcher]') as HTMLButtonElement;
    launcher.click();
    const teach = shadow.querySelector('[data-rpa-product-action="teach"]') as HTMLButtonElement;
    assert.ok(teach, 'home offers the Teach entry');
    teach.click();
    void panel;
};

test('procedures start with the backend reservation, then open the existing recorder', async () => {
    const { restore } = setupDom();
    try {
        const live: CallLog[] = [];
        const actions: AuthoringCall[] = [];
        const reservation = { current: { owner: 'none', humanControl: 'none' } };
        const handle = mountProductFromContent({
            workspaceName: 'ws-1',
            client: authoringClient(reservation, live),
            dispatchAction: (type, payload) => {
                actions.push({ type, payload: payload ?? {} });
                if (type === 'checkpoint.record.get') {
                    return Promise.resolve(recorderReply(type, entityRulePayload));
                }
                return Promise.resolve(recorderReply(type, { status: 'recording' }));
            },
        });
        try {
            await settle();
            const host = document.getElementById('rpa-product-panel') as HTMLElement;
            const shadow = host.shadowRoot as ShadowRoot;
            openTeachSurface(shadow, host);
            await settle();

            const start = shadow.querySelector('[data-rpa-product-action="start-teach"]') as HTMLButtonElement;
            assert.ok(start, 'teach surface offers Start Teaching');
            assert.equal(start.disabled, true, 'a business area must be chosen first');
            const select = shadow.querySelector('[data-rpa-product-field="business-area"]') as HTMLSelectElement;
            const option = Array.from(select.options).find((item) => item.value.includes('订单表单') || item.value.includes('orders'));
            assert.ok(option, 'the recorder entity rules are projected as business areas');
            select.value = option.value;
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
            await settle();

            (shadow.querySelector('[data-rpa-product-action="start-teach"]') as HTMLButtonElement).click();
            await settle();

            const beginAt = live.findIndex((entry) => entry.name === 'beginAuthoring');
            const recorderAt = actions.findIndex((entry) => entry.type === 'checkpoint.record.start');
            assert.ok(beginAt >= 0, 'beginAuthoring reached the backend');
            assert.deepEqual(live[beginAt].args, [{ activity: 'teach', teachKind: 'procedure' }]);
            assert.ok(actions.some((entry) => entry.type === 'checkpoint.record.get'),
                'the existing checkpoint recorder was queried');
            assert.equal(actions.some((entry) => entry.type === 'record.start'), false,
                'procedure must not start the generic demonstration recorder');
            void recorderAt;
        } finally {
            handle.unmount();
        }
    } finally {
        restore();
    }
});

test('basic demonstration uses the generic record.* actions, never the checkpoint recorder', async () => {
    const { restore } = setupDom();
    try {
        const live: CallLog[] = [];
        const actions: AuthoringCall[] = [];
        const reservation = { current: { owner: 'none', humanControl: 'none' } };
        const handle = mountProductFromContent({
            workspaceName: 'ws-1',
            client: authoringClient(reservation, live),
            dispatchAction: (type, payload) => {
                actions.push({ type, payload: payload ?? {} });
                if (type === 'record.get') {
                    return Promise.resolve(recorderReply(type, { steps: [], manifest: {}, enrichments: [], unsaved: { stepCount: 0 } }));
                }
                return Promise.resolve(recorderReply(type, {}));
            },
        });
        try {
            await settle();
            const host = document.getElementById('rpa-product-panel') as HTMLElement;
            const shadow = host.shadowRoot as ShadowRoot;
            openTeachSurface(shadow, host);
            await settle();

            const demoRadio = shadow.querySelector('input[value="demonstration"]') as HTMLInputElement;
            demoRadio.checked = true;
            demoRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
            await settle();
            (shadow.querySelector('[data-rpa-product-action="start-teach"]') as HTMLButtonElement).click();
            await settle();

            assert.deepEqual(
                live.find((entry) => entry.name === 'beginAuthoring')?.args,
                [{ activity: 'teach', teachKind: 'demonstration' }],
            );
            assert.ok(actions.some((entry) => entry.type === 'record.start'),
                'demonstration reuses the existing record.start capability');
            assert.equal(actions.some((entry) => entry.type === 'checkpoint.record.start'), false,
                'demonstration must never start the checkpoint recorder');
        } finally {
            handle.unmount();
        }
    } finally {
        restore();
    }
});

test('Annotate acquires the reservation and opens the existing canvas without duplicating its UI', async () => {
    const { restore } = setupDom();
    try {
        const live: CallLog[] = [];
        const reservation = { current: { owner: 'none', humanControl: 'none' } };
        let opened: string | undefined;
        const handle = mountProductFromContent({
            workspaceName: 'ws-1',
            client: authoringClient(reservation, live),
            dispatchAction: (type) => Promise.resolve(recorderReply(type, {})),
            openAnnotator: (profileName) => {
                opened = profileName;
                return Promise.resolve(true);
            },
        });
        try {
            await settle();
            const host = document.getElementById('rpa-product-panel') as HTMLElement;
            const shadow = host.shadowRoot as ShadowRoot;
            (shadow.querySelector('[data-rpa-product-action="annotate"]') as HTMLButtonElement).click();
            await settle();

            assert.deepEqual(live.find((entry) => entry.name === 'beginAuthoring')?.args, [{ activity: 'annotate' }]);
            assert.equal(opened, undefined, 'the existing annotator session controller received the open');
            const body = shadow.querySelector('.rpa-body') as HTMLElement;
            assert.equal(body.textContent.includes('Annotating on the page'), true);
        } finally {
            handle.unmount();
        }
    } finally {
        restore();
    }
});

test('the ordinary authoring surfaces never render checkpoint/entity_rules/Step/DSL vocabulary', async () => {
    const { restore } = setupDom();
    try {
        const live: CallLog[] = [];
        const reservation = { current: { owner: 'none', humanControl: 'none' } };
        const handle = mountProductFromContent({
            workspaceName: 'ws-1',
            client: authoringClient(reservation, live),
            dispatchAction: (type) => Promise.resolve(
                type === 'checkpoint.record.get'
                    ? recorderReply(type, entityRulePayload)
                    : recorderReply(type, {}),
            ),
        });
        try {
            await settle();
            const host = document.getElementById('rpa-product-panel') as HTMLElement;
            const shadow = host.shadowRoot as ShadowRoot;
            openTeachSurface(shadow, host);
            await settle();
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- textContent is nullable per lib.dom
            const text = (shadow.querySelector('.rpa-body') as HTMLElement).textContent ?? '';
            for (const banned of ['checkpoint', 'entity_rules', 'Step', 'DSL', 'body.dsl', 'task-1']) {
                assert.equal(text.includes(banned), false, `ordinary Teach surface must not expose ${banned}`);
            }
        } finally {
            handle.unmount();
        }
    } finally {
        restore();
    }
});