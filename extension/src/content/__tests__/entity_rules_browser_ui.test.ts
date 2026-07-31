import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountEntityRulesBrowserUI} from '../entity_rules_browser_ui.js';
import type {Action} from '../../shared/types.js';

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const reply = (type: string, payload: Record<string, unknown>): Action => ({
    v: 1,
    id: `${type}-reply`,
    type: `${type}.result`,
    payload,
});

const setupDom = () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: 'https://example.test/orders'});
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLElement: globalThis.HTMLElement,
        HTMLButtonElement: globalThis.HTMLButtonElement,
        Node: globalThis.Node,
    };
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
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
        shadow,
        launchers,
        surface,
        cleanup: () => {
            Object.assign(globalThis, previous);
            dom.window.close();
        },
    };
};

const rules = [{
    profileName: 'orders-page-rule',
    label: '订单页面',
    pageKind: 'table',
    urlPattern: '/orders',
    entityCount: 2,
}];

const view = {
    ...rules[0],
    entities: [
        {
            profileName: 'orders-page-rule',
            businessTag: 'orders.query',
            entityKind: 'form',
            label: '订单查询',
            fields: [{fieldKey: 'orderNo', label: '订单编号', targetKind: 'form.field'}],
            actions: [{actionIntent: 'query', label: '查询', targetKind: 'form.action'}],
            rowActions: [],
            columns: [],
            hasPagination: false,
        },
        {
            profileName: 'orders-page-rule',
            businessTag: 'orders.table',
            entityKind: 'table',
            label: '订单列表',
            fields: [],
            actions: [{actionIntent: 'export', label: '导出', targetKind: 'table.module_action'}],
            rowActions: [{actionIntent: 'confirmShipment', label: '确认发货', targetKind: 'table.row_action'}],
            primaryKey: {fieldKey: 'orderNo', label: '订单编号'},
            columns: [{fieldKey: 'orderNo', label: '订单编号', primaryKey: true, actionCount: 0}],
            hasPagination: true,
        },
    ],
};

test('rules browser lists persisted rules and explains what each entity marks', async () => {
    const fixture = setupDom();
    const previews: unknown[] = [];
    const edits: string[] = [];
    const handle = mountEntityRulesBrowserUI({
        launchers: fixture.launchers,
        surface: fixture.surface,
        pageUrl: () => fixture.dom.window.location.href,
        sendAction: async (type) => type === 'entity_rules.list'
            ? reply(type, {rules})
            : reply(type, {view}),
        onCreate: () => undefined,
        onEdit: (profileName) => {edits.push(profileName);},
        onPreview: async (selection) => {
            previews.push(selection);
            return true;
        },
    });
    try {
        (fixture.shadow.querySelector('[data-rpa-rules-action="launch"]') as HTMLButtonElement).click();
        await flush();
        assert.match(fixture.shadow.textContent || '', /订单页面/);
        assert.match(fixture.shadow.textContent || '', /2 个业务区域/);
        (fixture.shadow.querySelector('[data-rpa-rules-action="open"]') as HTMLButtonElement).click();
        await flush();
        const visible = fixture.shadow.textContent || '';
        assert.match(visible, /订单查询/);
        assert.match(visible, /字段：订单编号/);
        assert.match(visible, /操作：查询/);
        assert.match(visible, /订单列表/);
        assert.match(visible, /行操作：确认发货/);
        assert.match(visible, /列：订单编号（主键）/);
        assert.match(visible, /分页/);
        assert.equal(/orders-page-rule|orders\.query|orders\.table/.test(visible), false);
        assert.equal(fixture.shadow.querySelector('[data-rpa-rule-profile]'), null);
        assert.equal(fixture.shadow.querySelector('[data-rpa-rule-entity]'), null);
        assert.equal(fixture.shadow.innerHTML.includes('orders-page-rule'), false);

        (fixture.shadow.querySelector('[data-rpa-rules-action="preview"]') as HTMLButtonElement).click();
        await flush();
        assert.deepEqual(previews.at(-1), {
            profileName: 'orders-page-rule',
            businessTag: 'orders.query',
            entityKind: 'form',
        });
        (fixture.shadow.querySelector('[data-rpa-rules-action="edit"]') as HTMLButtonElement).click();
        await flush();
        assert.equal(edits.at(-1), 'orders-page-rule');
        assert.equal(previews.at(-1), null);
        assert.equal(fixture.shadow.querySelector('.rules-browser')?.hasAttribute('hidden'), true);
    } finally {
        handle.unmount();
        fixture.cleanup();
    }
});

test('closing rule inspection always clears the page preview', async () => {
    const fixture = setupDom();
    const previews: unknown[] = [];
    const handle = mountEntityRulesBrowserUI({
        launchers: fixture.launchers,
        surface: fixture.surface,
        pageUrl: () => fixture.dom.window.location.href,
        sendAction: async (type) => type === 'entity_rules.list'
            ? reply(type, {rules})
            : reply(type, {view}),
        onCreate: () => undefined,
        onEdit: () => undefined,
        onPreview: async (selection) => {
            previews.push(selection);
            return true;
        },
    });
    try {
        (fixture.shadow.querySelector('[data-rpa-rules-action="launch"]') as HTMLButtonElement).click();
        await flush();
        (fixture.shadow.querySelector('[data-rpa-rules-action="open"]') as HTMLButtonElement).click();
        await flush();
        (fixture.shadow.querySelector('[data-rpa-rules-action="preview"]') as HTMLButtonElement).click();
        await flush();
        (fixture.shadow.querySelector('[data-rpa-rules-action="close"]') as HTMLButtonElement).click();
        await flush();
        assert.equal(previews.at(-1), null);
        assert.equal(fixture.shadow.querySelector('.rules-browser')?.hasAttribute('hidden'), true);
    } finally {
        handle.unmount();
        fixture.cleanup();
    }
});

test('late list responses cannot revive a closed rule browser', async () => {
    const fixture = setupDom();
    let resolveFirst!: (action: Action) => void;
    const firstList = new Promise<Action>((resolve) => {resolveFirst = resolve;});
    let listCalls = 0;
    const handle = mountEntityRulesBrowserUI({
        launchers: fixture.launchers,
        surface: fixture.surface,
        pageUrl: () => fixture.dom.window.location.href,
        sendAction: async (type) => {
            if (type !== 'entity_rules.list') {return reply(type, {view});}
            listCalls += 1;
            return listCalls === 1 ? await firstList : reply(type, {rules});
        },
        onCreate: () => undefined,
        onEdit: () => undefined,
        onPreview: async () => true,
    });
    try {
        (fixture.shadow.querySelector('[data-rpa-rules-action="launch"]') as HTMLButtonElement).click();
        await flush();
        (fixture.shadow.querySelector('[data-rpa-rules-action="close"]') as HTMLButtonElement).click();
        await flush();
        resolveFirst(reply('entity_rules.list', {rules}));
        await flush();
        assert.equal(fixture.shadow.querySelector('.rules-browser')?.hasAttribute('hidden'), true);

        (fixture.shadow.querySelector('[data-rpa-rules-action="launch"]') as HTMLButtonElement).click();
        await flush();
        assert.equal(fixture.shadow.querySelector('.rules-browser')?.hasAttribute('hidden'), false);
        assert.match(fixture.shadow.textContent || '', /订单页面/);
        assert.equal(listCalls, 2);
    } finally {
        handle.unmount();
        fixture.cleanup();
    }
});

test('failed previews stay inactive and report the failure', async () => {
    const fixture = setupDom();
    const handle = mountEntityRulesBrowserUI({
        launchers: fixture.launchers,
        surface: fixture.surface,
        pageUrl: () => fixture.dom.window.location.href,
        sendAction: async (type) => type === 'entity_rules.list'
            ? reply(type, {rules})
            : reply(type, {view}),
        onCreate: () => undefined,
        onEdit: () => undefined,
        onPreview: async (selection) => selection === null,
    });
    try {
        (fixture.shadow.querySelector('[data-rpa-rules-action="launch"]') as HTMLButtonElement).click();
        await flush();
        (fixture.shadow.querySelector('[data-rpa-rules-action="open"]') as HTMLButtonElement).click();
        await flush();
        (fixture.shadow.querySelector('[data-rpa-rules-action="preview"]') as HTMLButtonElement).click();
        await flush();
        assert.match(fixture.shadow.textContent || '', /无法在当前页面查看这条规则/);
        assert.equal(
            (fixture.shadow.querySelector('[data-rpa-rules-action="preview"]') as HTMLButtonElement).textContent,
            '在页面查看',
        );
    } finally {
        handle.unmount();
        fixture.cleanup();
    }
});

test('rules browser owns focus and Escape closes it with preview cleanup', async () => {
    const fixture = setupDom();
    const previews: unknown[] = [];
    const handle = mountEntityRulesBrowserUI({
        launchers: fixture.launchers,
        surface: fixture.surface,
        pageUrl: () => fixture.dom.window.location.href,
        sendAction: async (type) => type === 'entity_rules.list'
            ? reply(type, {rules})
            : reply(type, {view}),
        onCreate: () => undefined,
        onEdit: () => undefined,
        onPreview: async (selection) => {
            previews.push(selection);
            return true;
        },
    });
    try {
        const launcher = fixture.shadow.querySelector('[data-rpa-rules-action="launch"]') as HTMLButtonElement;
        launcher.focus();
        launcher.click();
        await flush();
        const panel = fixture.shadow.querySelector('.rules-browser') as HTMLElement;
        assert.equal(panel.getAttribute('role'), 'dialog');
        assert.equal(fixture.shadow.activeElement, panel);

        fixture.dom.window.document.dispatchEvent(new fixture.dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            composed: true,
        }));
        await flush();
        assert.equal(panel.hasAttribute('hidden'), true);
        assert.equal(previews.at(-1), null);
        assert.equal(fixture.shadow.activeElement, launcher);
    } finally {
        handle.unmount();
        fixture.cleanup();
    }
});

test('refreshing the rule list clears an active page preview', async () => {
    const fixture = setupDom();
    const previews: unknown[] = [];
    const handle = mountEntityRulesBrowserUI({
        launchers: fixture.launchers,
        surface: fixture.surface,
        pageUrl: () => fixture.dom.window.location.href,
        sendAction: async (type) => type === 'entity_rules.list'
            ? reply(type, {rules})
            : reply(type, {view}),
        onCreate: () => undefined,
        onEdit: () => undefined,
        onPreview: async (selection) => {
            previews.push(selection);
            return true;
        },
    });
    try {
        (fixture.shadow.querySelector('[data-rpa-rules-action="launch"]') as HTMLButtonElement).click();
        await flush();
        (fixture.shadow.querySelector('[data-rpa-rules-action="open"]') as HTMLButtonElement).click();
        await flush();
        (fixture.shadow.querySelector('[data-rpa-rules-action="preview"]') as HTMLButtonElement).click();
        await flush();
        await handle.refresh();
        await flush();
        assert.equal(previews.at(-1), null);
        assert.match(fixture.shadow.textContent || '', /订单页面/);
        assert.equal(fixture.shadow.textContent?.includes('字段：订单编号'), false);
    } finally {
        handle.unmount();
        fixture.cleanup();
    }
});
