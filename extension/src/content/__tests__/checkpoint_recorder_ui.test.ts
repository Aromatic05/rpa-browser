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

const setupDom = () => {
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
    return {
        dom,
        previous,
        shadow,
        cleanup: () => {
            Object.assign(globalThis, previous);
            dom.window.close();
        },
        launchers,
        surface,
    };
};

const procedureReviewPayload = {
    status: 'review',
    stepCount: 3,
    steps: [
        {index: 1, stepId: 'fill-order', stepName: 'browser.fill', label: '填写 订单编号', recordedValue: 'SO-001', profileName: 'order-query-rule', businessTag: 'orders.query', fieldKey: 'orderNo', fieldHint: '订单编号'},
        {index: 2, stepId: 'fill-buyer', stepName: 'browser.fill', label: '填写 采购人', recordedValue: '王小虎', profileName: 'order-query-rule', businessTag: 'orders.query', fieldKey: 'buyer', fieldHint: '采购人'},
        {index: 3, stepId: 'click-query', stepName: 'browser.click', label: '点击 查询', profileName: 'order-query-rule', businessTag: 'orders.query', actionHint: 'query'},
    ],
    kind: 'procedure',
    entityRule: {profileName: 'order-query-rule', businessTag: 'orders.query', entityKind: 'table'},
    entityRules: [{
        profileName: 'order-query-rule',
        businessTag: 'orders.query',
        entityKind: 'table',
        label: '订单查询',
        fields: [
            {fieldKey: 'orderNo', label: '订单编号', targetKind: 'table.filter'},
            {fieldKey: 'buyer', label: '采购人', targetKind: 'table.filter'},
        ],
        actions: [{actionIntent: 'query', label: '查询', targetKind: 'table.module_action'}],
        outputs: [
            {kind: 'none', label: '无'},
            {kind: 'table.currentRows', label: '当前列表数据'},
        ],
    }],
};

test('checkpoint recorder defaults to a business procedure and preserves mappings after save failure', async () => {
    const fixture = setupDom();
    const calls: Array<{type: string; payload?: Record<string, unknown>}> = [];
    let saveAttempts = 0;
    const active: boolean[] = [];
    const previews: unknown[] = [];
    const handle = mountCheckpointRecorderUI({
        launchers: fixture.launchers,
        surface: fixture.surface,
        onActiveChange: (value) => active.push(value),
        onEntityRulePreview: (value) => {previews.push(value);},
        sendAction: async (type, payload) => {
            calls.push({type, payload});
            if (type === 'checkpoint.record.get') {return reply(type, {...procedureReviewPayload, status: 'idle', steps: []});}
            if (type === 'checkpoint.record.start') {return reply(type, {status: 'recording'});}
            if (type === 'checkpoint.record.stop') {return reply(type, procedureReviewPayload);}
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
        const launcher = fixture.shadow.querySelector('.checkpoint-launch') as HTMLButtonElement;
        assert.equal(launcher.textContent, '录制检查点');
        launcher.click();
        await flush();
        assert.equal(fixture.shadow.textContent?.includes('选择业务区域'), true);
        assert.equal(fixture.shadow.textContent?.includes('高亮不会拦截操作'), true);
        assert.deepEqual(previews.at(-1), {
            profileName: 'order-query-rule',
            businessTag: 'orders.query',
            entityKind: 'table',
        });
        fixture.shadow.querySelector('[data-rpa-checkpoint-action="start"]')
            ?.dispatchEvent(new fixture.dom.window.MouseEvent('click', {bubbles: true}));
        await flush();
        assert.equal(fixture.shadow.textContent?.includes('正在录制检查点'), true);
        assert.deepEqual(calls.find((call) => call.type === 'checkpoint.record.start')?.payload, {
            kind: 'procedure',
            profileName: 'order-query-rule',
            businessTag: 'orders.query',
            entityKind: 'table',
        });
        fixture.shadow.querySelector('[data-rpa-checkpoint-action="stop"]')
            ?.dispatchEvent(new fixture.dom.window.MouseEvent('click', {bubbles: true}));
        await flush();

        assert.equal(fixture.shadow.textContent?.includes('标注检查点'), true);
        assert.equal(fixture.shadow.textContent?.includes('成立条件'), true);
        assert.equal(fixture.shadow.textContent?.includes('输入'), true);
        assert.equal(fixture.shadow.textContent?.includes('输出'), true);
        assert.equal(fixture.shadow.textContent?.includes('操作失败时'), false);

        const name = fixture.shadow.querySelector('[data-rpa-checkpoint-field="name"]') as HTMLInputElement;
        name.value = '查询订单';
        name.dispatchEvent(new fixture.dom.window.Event('input', {bubbles: true}));

        const mappingOrder = fixture.shadow.querySelector('[data-rpa-checkpoint-map="fill-order"]') as HTMLSelectElement;
        const mappingBuyer = fixture.shadow.querySelector('[data-rpa-checkpoint-map="fill-buyer"]') as HTMLSelectElement;
        const mappingAction = fixture.shadow.querySelector('[data-rpa-checkpoint-map="click-query"]') as HTMLSelectElement;
        assert.equal(mappingOrder.value, 'input:orderNo');
        assert.equal(mappingBuyer.value, 'input:buyer');
        assert.equal(mappingAction.value, 'action:query');

        fixture.shadow.querySelector('[data-rpa-checkpoint-action="save"]')
            ?.dispatchEvent(new fixture.dom.window.MouseEvent('click', {bubbles: true}));
        await flush();
        assert.equal(fixture.shadow.textContent?.includes('暂时无法保存'), true);
        assert.equal((fixture.shadow.querySelector('[data-rpa-checkpoint-field="name"]') as HTMLInputElement).value, '查询订单');
        assert.equal((fixture.shadow.querySelector('[data-rpa-checkpoint-map="fill-order"]') as HTMLSelectElement).value, 'input:orderNo');

        fixture.shadow.querySelector('[data-rpa-checkpoint-action="save"]')
            ?.dispatchEvent(new fixture.dom.window.MouseEvent('click', {bubbles: true}));
        await flush();
        assert.equal(fixture.shadow.textContent?.includes('检查点已保存'), true);
        assert.deepEqual(active, [true, false]);

        const saveCalls = calls.filter((call) => call.type === 'checkpoint.record.save');
        assert.deepEqual(saveCalls.at(-1)?.payload, {
            kind: 'procedure',
            name: '查询订单',
            mappings: [
                {stepId: 'fill-order', kind: 'input', fieldKey: 'orderNo'},
                {stepId: 'fill-buyer', kind: 'input', fieldKey: 'buyer'},
                {stepId: 'click-query', kind: 'action', actionIntent: 'query'},
            ],
            outputKind: 'none',
        });
        const visibleText = fixture.shadow.textContent || '';
        assert.equal(/checkpointId|matchRules|resolveId|businessTag|profileName/.test(visibleText), false);
    } finally {
        handle.unmount();
        fixture.cleanup();
    }
});

test('error recovery remains an explicit secondary checkpoint type', async () => {
    const fixture = setupDom();
    const calls: Array<{type: string; payload?: Record<string, unknown>}> = [];
    const previews: unknown[] = [];
    const handle = mountCheckpointRecorderUI({
        launchers: fixture.launchers,
        surface: fixture.surface,
        onEntityRulePreview: (value) => {previews.push(value);},
        sendAction: async (type, payload) => {
            calls.push({type, payload});
            if (type === 'checkpoint.record.get') {
                return reply(type, {...procedureReviewPayload, status: 'idle', steps: []});
            }
            if (type === 'checkpoint.record.start') {return reply(type, {status: 'recording', kind: 'recovery'});}
            if (type === 'checkpoint.record.stop') {
                return reply(type, {
                    status: 'review',
                    kind: 'recovery',
                    stepCount: 1,
                    steps: [{index: 1, stepId: 'click-close', stepName: 'browser.click', label: '点击 关闭', profileName: 'order-query-rule', businessTag: 'orders.query', actionHint: 'query'}],
                    entityRule: procedureReviewPayload.entityRule,
                    entityRules: procedureReviewPayload.entityRules,
                });
            }
            return reply(type, {saved: true});
        },
    });
    try {
        const launcher = fixture.shadow.querySelector('.checkpoint-launch') as HTMLButtonElement;
        launcher.click();
        await flush();
        const kind = fixture.shadow.querySelector('[data-rpa-checkpoint-field="kind"]') as HTMLSelectElement;
        kind.value = 'recovery';
        kind.dispatchEvent(new fixture.dom.window.Event('change', {bubbles: true}));
        assert.equal(fixture.shadow.textContent?.includes('错误状态会保持高亮'), true);
        assert.equal(fixture.shadow.textContent?.includes('业务区域'), false);
        assert.equal(fixture.shadow.textContent?.includes('错误状态'), true);
        assert.deepEqual(previews.at(-1), {
            profileName: 'order-query-rule',
            businessTag: 'orders.query',
            entityKind: 'table',
        });
        fixture.shadow.querySelector('[data-rpa-checkpoint-action="start"]')
            ?.dispatchEvent(new fixture.dom.window.MouseEvent('click', {bubbles: true}));
        await flush();
        assert.deepEqual(calls.find((call) => call.type === 'checkpoint.record.start')?.payload, {
            kind: 'recovery',
            profileName: 'order-query-rule',
            businessTag: 'orders.query',
            entityKind: 'table',
        });
        fixture.shadow.querySelector('[data-rpa-checkpoint-action="stop"]')
            ?.dispatchEvent(new fixture.dom.window.MouseEvent('click', {bubbles: true}));
        await flush();
        assert.equal(fixture.shadow.textContent?.includes('错误状态'), true);
        assert.equal(fixture.shadow.textContent?.includes('订单查询'), true);
        assert.equal(fixture.shadow.textContent?.includes('操作失败时，如果'), false);

        const name = fixture.shadow.querySelector('[data-rpa-checkpoint-field="name"]') as HTMLInputElement;
        name.value = '关闭登录提示';
        name.dispatchEvent(new fixture.dom.window.Event('input', {bubbles: true}));
        fixture.shadow.querySelector('[data-rpa-checkpoint-action="save"]')
            ?.dispatchEvent(new fixture.dom.window.MouseEvent('click', {bubbles: true}));
        await flush();
        assert.deepEqual(calls.at(-1), {
            type: 'checkpoint.record.save',
            payload: {
                kind: 'recovery',
                name: '关闭登录提示',
                operation: 'any',
                retryOriginal: true,
            },
        });
    } finally {
        handle.unmount();
        fixture.cleanup();
    }
});

test('restored recording status auto-hides without losing the active launcher', async () => {
    const fixture = setupDom();
    const handle = mountCheckpointRecorderUI({
        launchers: fixture.launchers,
        surface: fixture.surface,
        recordingAutoHideMs: 5,
        sendAction: async (type) => reply(type, {status: 'recording', stepCount: 0, steps: []}),
    });
    try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(fixture.shadow.querySelector('.checkpoint-recorder')?.hasAttribute('hidden'), true);
        assert.equal((fixture.shadow.querySelector('.checkpoint-launch') as HTMLButtonElement).textContent, '录制中');
        assert.equal((fixture.shadow.querySelector('.checkpoint-launch') as HTMLButtonElement).classList.contains('active'), true);
    } finally {
        handle.unmount();
        fixture.cleanup();
    }
});
