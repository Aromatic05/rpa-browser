import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountCheckpointRecorderUI} from '../checkpoint_recorder_ui.js';
import type {Action} from '../../shared/types.js';

const reply = (type: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: `${type}-reply`,
    type: `${type}.result`,
    payload,
});

const failure = (type: string, message: string): Action => ({
    v: 1,
    id: `${type}-failed`,
    type: `${type}.failed`,
    payload: {message},
});

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
};

test('checkpoint recorder keeps user input after a failed save and only exposes task language', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://example.test/orders'});
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        HTMLInputElement: globalThis.HTMLInputElement,
        HTMLSelectElement: globalThis.HTMLSelectElement,
        Event: globalThis.Event,
        Node: globalThis.Node,
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        HTMLSelectElement: dom.window.HTMLSelectElement,
        Event: dom.window.Event,
        Node: dom.window.Node,
    });

    const host = document.createElement('div');
    const shadow = host.attachShadow({mode: 'open'});
    const launchers = document.createElement('div');
    const surface = document.createElement('div');
    shadow.append(launchers, surface);
    document.body.appendChild(host);

    const calls: Array<{type: string; payload?: Record<string, unknown>}> = [];
    let saveAttempts = 0;
    const active: boolean[] = [];
    const handle = mountCheckpointRecorderUI({
        launchers,
        surface,
        onActiveChange: (value) => active.push(value),
        sendAction: async (type, payload) => {
            calls.push({type, payload});
            if (type === 'checkpoint.record.start') {return reply(type, {status: 'recording'});}
            if (type === 'checkpoint.record.stop') {
                return reply(type, {status: 'review', stepCount: 1, steps: [{index: 1, label: '点击'}]});
            }
            if (type === 'checkpoint.record.save') {
                saveAttempts += 1;
                return saveAttempts === 1
                    ? failure(type, '暂时无法保存')
                    : reply(type, {saved: true, checkpointId: 'internal-id'});
            }
            return reply(type, {canceled: true});
        },
    });

    try {
        const launcher = shadow.querySelector('.checkpoint-launch') as HTMLButtonElement;
        launcher.click();
        await flush();
        assert.equal(shadow.textContent?.includes('正在录制恢复步骤'), true);
        assert.deepEqual(active, [true]);

        shadow.querySelector('[data-rpa-checkpoint-action="stop"]')
            ?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await flush();
        assert.equal(shadow.textContent?.includes('已录制：点击'), true);

        const name = shadow.querySelector('input[type="text"]') as HTMLInputElement;
        name.value = '关闭登录提示';
        name.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        const selects = [...shadow.querySelectorAll('select')] as HTMLSelectElement[];
        selects[0].value = 'text_visible';
        selects[0].dispatchEvent(new dom.window.Event('change', {bubbles: true}));
        const textInputs = [...shadow.querySelectorAll('input[type="text"]')] as HTMLInputElement[];
        textInputs[1].value = '登录已失效';
        textInputs[1].dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        selects[1].value = 'click';
        selects[1].dispatchEvent(new dom.window.Event('change', {bubbles: true}));

        shadow.querySelector('[data-rpa-checkpoint-action="save"]')
            ?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await flush();
        assert.equal(shadow.textContent?.includes('暂时无法保存'), true);
        assert.equal((shadow.querySelector('input[type="text"]') as HTMLInputElement).value, '关闭登录提示');
        const retainedInputs = [...shadow.querySelectorAll('input[type="text"]')] as HTMLInputElement[];
        assert.equal(retainedInputs[1].value, '登录已失效');

        shadow.querySelector('[data-rpa-checkpoint-action="save"]')
            ?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await flush();
        assert.equal(shadow.textContent?.includes('恢复步骤已保存'), true);
        assert.deepEqual(active, [true, false]);

        const saveCalls = calls.filter((call) => call.type === 'checkpoint.record.save');
        assert.equal(saveCalls.length, 2);
        assert.deepEqual(saveCalls[1].payload, {
            name: '关闭登录提示',
            triggerKind: 'text_visible',
            triggerValue: '登录已失效',
            operation: 'click',
            retryOriginal: true,
        });
        const visibleText = shadow.textContent || '';
        assert.equal(visibleText.includes('checkpointId'), false);
        assert.equal(visibleText.includes('matchRules'), false);
        assert.equal(visibleText.includes('resolveId'), false);
    } finally {
        handle.unmount();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('checkpoint recorder restores a review session and lets the user discard it directly', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://example.test/orders'});
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        HTMLInputElement: globalThis.HTMLInputElement,
        HTMLSelectElement: globalThis.HTMLSelectElement,
        Event: globalThis.Event,
        Node: globalThis.Node,
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        HTMLSelectElement: dom.window.HTMLSelectElement,
        Event: dom.window.Event,
        Node: dom.window.Node,
    });

    const host = document.createElement('div');
    const shadow = host.attachShadow({mode: 'open'});
    const launchers = document.createElement('div');
    const surface = document.createElement('div');
    shadow.append(launchers, surface);
    document.body.appendChild(host);
    const actions: string[] = [];
    const active: boolean[] = [];
    const handle = mountCheckpointRecorderUI({
        launchers,
        surface,
        onActiveChange: (value) => active.push(value),
        sendAction: async (type) => {
            actions.push(type);
            if (type === 'checkpoint.record.get') {
                return reply(type, {status: 'review', stepCount: 1, steps: [{index: 1, label: '点击'}]});
            }
            return reply(type, {canceled: true});
        },
    });

    try {
        await flush();
        assert.equal(shadow.textContent?.includes('标注恢复步骤'), true);
        assert.equal(shadow.textContent?.includes('1 个操作'), true);
        assert.deepEqual(active, [true]);
        (shadow.querySelector('[data-rpa-checkpoint-action="discard"]') as HTMLButtonElement).click();
        await flush();
        assert.equal(shadow.querySelector('.checkpoint-recorder')?.hasAttribute('hidden'), true);
        assert.equal((shadow.querySelector('.checkpoint-launch') as HTMLButtonElement).textContent, '录制恢复');
        assert.deepEqual(actions, ['checkpoint.record.get', 'checkpoint.record.cancel']);
        assert.deepEqual(active, [true, false]);
    } finally {
        handle.unmount();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});

test('restored recording status auto-hides without losing the active launcher', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://example.test/orders'});
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        HTMLInputElement: globalThis.HTMLInputElement,
        HTMLSelectElement: globalThis.HTMLSelectElement,
        Event: globalThis.Event,
        Node: globalThis.Node,
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        HTMLSelectElement: dom.window.HTMLSelectElement,
        Event: dom.window.Event,
        Node: dom.window.Node,
    });
    const host = document.createElement('div');
    const shadow = host.attachShadow({mode: 'open'});
    const launchers = document.createElement('div');
    const surface = document.createElement('div');
    shadow.append(launchers, surface);
    document.body.appendChild(host);
    const handle = mountCheckpointRecorderUI({
        launchers,
        surface,
        recordingAutoHideMs: 5,
        sendAction: async (type) => reply(type, {status: 'recording', stepCount: 0, steps: []}),
    });
    try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(shadow.querySelector('.checkpoint-recorder')?.hasAttribute('hidden'), true);
        assert.equal((shadow.querySelector('.checkpoint-launch') as HTMLButtonElement).textContent, '录制中');
        assert.equal((shadow.querySelector('.checkpoint-launch') as HTMLButtonElement).classList.contains('active'), true);
    } finally {
        handle.unmount();
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});
