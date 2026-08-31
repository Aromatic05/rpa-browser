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