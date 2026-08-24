import {test, expect} from '@playwright/test';
import crypto from 'node:crypto';
import {dispatch, runStep, startAgent} from '../../helpers/e2e_multitab_helper';
import {startFixtureServer} from '../../helpers/server';
import type {Action} from '../../../src/interface/actions/action_protocol';
import type {StepUnion} from '../../../src/automation/runner/steps/types';

type AgentHandle = Awaited<ReturnType<typeof startAgent>>;
type Point = {x: number; y: number};

const action = (type: string, workspaceName: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName,
    payload,
    at: Date.now(),
});

const controlAction = (type: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    payload,
    at: Date.now(),
});

const step = <T extends StepUnion['name']>(
    id: string,
    name: T,
    args: Extract<StepUnion, {name: T}>['args'],
): Extract<StepUnion, {name: T}> => ({id, name, args} as Extract<StepUnion, {name: T}>);

const createWorkspacePage = async (agent: AgentHandle, workspaceName: string, url: string): Promise<void> => {
    expect((await dispatch(agent.endpoint, controlAction('workspace.create', {workspaceName}))).type)
        .toBe('workspace.create.result');
    const before = await dispatch(agent.endpoint, action('tab.list', workspaceName));
    const beforeNames = new Set(
        ((before.payload as {tabs?: Array<{tabName: string}>})?.tabs || []).map((tab) => tab.tabName),
    );
    expect((await dispatch(agent.endpoint, action('tab.open', workspaceName))).type).toBe('tab.open.result');
    let tabName = '';
    await expect.poll(async () => {
        const listed = await dispatch(agent.endpoint, action('tab.list', workspaceName));
        tabName = ((listed.payload as {tabs?: Array<{tabName: string}>})?.tabs || [])
            .find((tab) => !beforeNames.has(tab.tabName))?.tabName || '';
        return tabName;
    }, {timeout: 20_000}).not.toBe('');
    expect((await runStep(agent.endpoint, workspaceName, step('switch-tab', 'browser.switch_tab', {tabName}))).ok).toBe(true);
    expect((await runStep(agent.endpoint, workspaceName, step('open-page', 'browser.goto', {url}))).ok).toBe(true);
};

const evaluate = async <T>(agent: AgentHandle, workspaceName: string, expression: string): Promise<T> => {
    const result = await runStep(
        agent.endpoint,
        workspaceName,
        step(`evaluate-${crypto.randomUUID()}`, 'browser.evaluate', {expression}),
    );
    if (!result.ok) {
        throw new Error(`browser.evaluate failed: ${JSON.stringify(result.error || {})}`);
    }
    return result.data as T;
};

const clickPoint = async (agent: AgentHandle, workspaceName: string, point: Point): Promise<void> => {
    expect((await runStep(
        agent.endpoint,
        workspaceName,
        step(`click-${crypto.randomUUID()}`, 'browser.mouse', {action: 'click', ...point}),
    )).ok).toBe(true);
};

const pressKey = async (agent: AgentHandle, workspaceName: string, key: string): Promise<void> => {
    expect((await runStep(
        agent.endpoint,
        workspaceName,
        step(`key-${crypto.randomUUID()}`, 'browser.press_key', {key}),
    )).ok).toBe(true);
};

const pagePoint = async (agent: AgentHandle, workspaceName: string, selector: string): Promise<Point> => {
    const point = await evaluate<Point | null>(agent, workspaceName, `
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    `);
    expect(point).not.toBeNull();
    return point!;
};

const floatingPoint = async (agent: AgentHandle, workspaceName: string, selector: string): Promise<Point> => {
    const point = await evaluate<Point | null>(agent, workspaceName, `
        const element = document.querySelector('#rpa-floating-panel')?.shadowRoot
            ?.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement) || (element instanceof HTMLButtonElement && element.disabled)) return null;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    `);
    expect(point, `${selector} should be visible`).not.toBeNull();
    return point!;
};

const ordinaryRecordingSnapshot = async (agent: AgentHandle, workspaceName: string): Promise<string> => {
    const reply = await dispatch(agent.endpoint, action('record.get', workspaceName));
    expect(reply.type).toBe('record.get.result');
    return JSON.stringify((reply.payload as {steps?: unknown[]}).steps || []);
};

const saveOrderQueryEntityRule = async (agent: AgentHandle, workspaceName: string): Promise<void> => {
    const canvas = {
        version: 1,
        profileName: 'order-query-rule',
        page: {kind: 'form', urlPattern: 'checkpoint_recorder\\.html'},
        entities: [{
            id: 'e0',
            source: 'region',
            kind: 'form',
            name: '订单查询',
            businessTag: 'orders.query',
            target: {idEquals: 'order-query'},
            expect: 'unique',
            annotations: [
                {id: 'f-order', type: 'field', name: '订单编号', businessKey: 'orderNo', target: {idEquals: 'order-no'}, expect: 'unique', origin: 'confirmed', disposition: 'active'},
                {id: 'f-buyer', type: 'field', name: '采购人', businessKey: 'buyer', target: {idEquals: 'buyer'}, expect: 'unique', origin: 'confirmed', disposition: 'active'},
                {id: 'a-query', type: 'action', name: '查询', businessKey: 'query', target: {idEquals: 'query-orders'}, expect: 'unique', origin: 'confirmed', disposition: 'active'},
            ],
            columns: [],
            origin: 'confirmed',
        }],
        preserved: {},
    };
    const saved = await dispatch(agent.endpoint, action('entity_rules.save', workspaceName, {
        profileName: 'order-query-rule',
        page: {kind: 'form', urlPattern: 'checkpoint_recorder\\.html'},
        match: {
            version: 2,
            rules: [
                {ruleId: 'root', source: 'region', expect: 'unique', match: {idEquals: 'order-query'}},
                {ruleId: 'order-no', source: 'node', expect: 'unique', within: 'root', match: {idEquals: 'order-no'}},
                {ruleId: 'buyer', source: 'node', expect: 'unique', within: 'root', match: {idEquals: 'buyer'}},
                {ruleId: 'query', source: 'node', expect: 'unique', within: 'root', match: {idEquals: 'query-orders'}},
            ],
        },
        annotation: {
            version: 2,
            bindings: [
                {ruleId: 'root', entityKey: 'ordersQuery', businessTag: 'orders.query', displayName: '订单查询', legacyCanvas: canvas},
                {ruleId: 'order-no', fieldKey: 'orderNo', fieldRole: 'field', fieldName: '订单编号'},
                {ruleId: 'buyer', fieldKey: 'buyer', fieldRole: 'field', fieldName: '采购人'},
                {ruleId: 'query', actionIntent: 'query', actionRole: 'form', actionText: '查询'},
            ],
        },
    }));
    expect(saved.type).toBe('entity_rules.save.result');
};

const saveOrderFulfillmentEntityRule = async (agent: AgentHandle, workspaceName: string): Promise<void> => {
    const canvas = {
        version: 1,
        profileName: 'order-fulfillment-rule',
        page: {kind: 'table', urlPattern: 'checkpoint_recorder\\.html'},
        entities: [{
            id: 'orders',
            source: 'region',
            kind: 'table',
            name: '订单列表',
            businessTag: 'orders.table',
            target: {
                kind: 'table',
                idEquals: 'order-workbench',
                v2Match: {kind: 'table', idEquals: 'orders-table'},
            },
            expect: 'unique',
            annotations: [
                {id: 'filter-order', type: 'field', name: '订单编号', businessKey: 'orderNo', target: {idEquals: 'order-no'}, expect: 'unique', origin: 'confirmed', disposition: 'active'},
                {id: 'query-orders', type: 'action', name: '查询', businessKey: 'query', target: {idEquals: 'query-orders'}, expect: 'unique', origin: 'confirmed', disposition: 'active'},
            ],
            primaryKey: {fieldKey: 'orderNo', columns: ['订单编号']},
            columns: [
                {id: 'order-no-column', fieldKey: 'orderNo', name: '订单编号', actions: [], origin: 'confirmed', disposition: 'active'},
                {id: 'buyer-column', fieldKey: 'buyer', name: '采购人', actions: [], origin: 'confirmed', disposition: 'active'},
                {id: 'status-column', fieldKey: 'status', name: '状态', actions: [], origin: 'confirmed', disposition: 'active'},
                {
                    id: 'actions-column',
                    fieldKey: 'actions',
                    name: '操作',
                    kind: 'action_column',
                    actions: [{
                        id: 'confirm-shipment',
                        actionIntent: 'confirmShipment',
                        text: '确认发货',
                        target: {classContains: 'confirm-shipment'},
                        origin: 'confirmed',
                        disposition: 'active',
                    }],
                    origin: 'confirmed',
                    disposition: 'active',
                },
            ],
            origin: 'confirmed',
        }],
        preserved: {},
    };
    const saved = await dispatch(agent.endpoint, action('entity_rules.save', workspaceName, {
        profileName: 'order-fulfillment-rule',
        page: {kind: 'table', urlPattern: 'checkpoint_recorder\\.html'},
        match: {
            version: 2,
            rules: [
                {ruleId: 'table-root', source: 'region', expect: 'unique', match: {kind: 'table', idEquals: 'orders-table'}},
                {ruleId: 'workbench', source: 'node', expect: 'unique', contains: 'table-root', match: {idEquals: 'order-workbench'}},
                {ruleId: 'order-no', source: 'node', expect: 'unique', within: 'workbench', match: {idEquals: 'order-no'}},
                {ruleId: 'query', source: 'node', expect: 'unique', within: 'workbench', match: {idEquals: 'query-orders'}},
                {ruleId: 'confirm-shipment', source: 'node', expect: 'one_or_more', within: 'table-root', match: {classContains: 'confirm-shipment'}},
            ],
        },
        annotation: {
            version: 2,
            bindings: [
                {
                    ruleId: 'table-root',
                    entityKey: 'ordersTable',
                    businessTag: 'orders.table',
                    entityKind: 'table',
                    displayName: '订单列表',
                    primaryKey: {fieldKey: 'orderNo', columns: ['订单编号'], source: 'annotation'},
                    columns: [
                        {fieldKey: 'orderNo', name: '订单编号', source: 'annotation'},
                        {fieldKey: 'buyer', name: '采购人', source: 'annotation'},
                        {fieldKey: 'status', name: '状态', source: 'annotation'},
                        {fieldKey: 'actions', name: '操作', kind: 'action_column', source: 'annotation', actions: [{actionIntent: 'confirmShipment', text: '确认发货'}]},
                    ],
                    legacyCanvas: canvas,
                },
                {ruleId: 'order-no', fieldKey: 'orderNo', fieldRole: 'filter', fieldName: '订单编号'},
                {ruleId: 'query', actionIntent: 'query', actionRole: 'module', actionText: '查询'},
                {ruleId: 'confirm-shipment', actionIntent: 'confirmShipment', actionRole: 'row', actionText: '确认发货', columnFieldKey: 'actions'},
            ],
        },
    }));
    expect(saved.type).toBe('entity_rules.save.result');
};

const saveExpiredSessionEntityRule = async (agent: AgentHandle, workspaceName: string): Promise<void> => {
    const canvas = {
        version: 1,
        profileName: 'expired-session-rule',
        page: {kind: 'panel', urlPattern: 'checkpoint_recorder\\.html'},
        entities: [{
            id: 'expired',
            source: 'region',
            kind: 'panel',
            name: '登录失效提示',
            businessTag: 'auth.expired',
            target: {idEquals: 'session-alert'},
            expect: 'unique',
            annotations: [
                {id: 'dismiss', type: 'action', name: '关闭提示', businessKey: 'dismiss', target: {idEquals: 'dismiss-session'}, expect: 'unique', origin: 'confirmed', disposition: 'active'},
            ],
            columns: [],
            origin: 'confirmed',
        }],
        preserved: {},
    };
    const saved = await dispatch(agent.endpoint, action('entity_rules.save', workspaceName, {
        profileName: 'expired-session-rule',
        page: {kind: 'panel', urlPattern: 'checkpoint_recorder\\.html'},
        match: {
            version: 2,
            rules: [
                {ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'panel', idEquals: 'session-alert'}},
                {ruleId: 'dismiss', source: 'node', expect: 'unique', within: 'root', match: {idEquals: 'dismiss-session'}},
            ],
        },
        annotation: {
            version: 2,
            bindings: [
                {ruleId: 'root', entityKey: 'authExpired', businessTag: 'auth.expired', entityKind: 'panel', displayName: '登录失效提示', legacyCanvas: canvas},
                {ruleId: 'dismiss', actionIntent: 'dismiss', actionRole: 'form', actionText: '关闭提示'},
            ],
        },
    }));
    expect(saved.type).toBe('entity_rules.save.result');
};

test('records a business checkpoint through entity-rule highlights without blocking the page', async ({}, testInfo) => {
    testInfo.setTimeout(180_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    const workspaceName = `checkpoint-recorder-${Date.now()}`;
    try {
        await createWorkspacePage(agent, workspaceName, `${fixture.baseURL}/checkpoint_recorder.html`);
        await saveOrderQueryEntityRule(agent, workspaceName);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return Boolean(document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('[data-rpa-checkpoint-action="launch"]'));
        `), {timeout: 20_000}).toBe(true);

        expect((await dispatch(agent.endpoint, action('record.start', workspaceName))).type).toBe('record.start.result');
        await clickPoint(agent, workspaceName, await pagePoint(agent, workspaceName, '#ordinary-action'));
        await expect.poll(async () => {
            const reply = await dispatch(agent.endpoint, action('record.get', workspaceName));
            return ((reply.payload as {steps?: unknown[]}).steps || []).length;
        }, {timeout: 15_000}).toBeGreaterThan(0);
        expect((await dispatch(agent.endpoint, action('record.stop', workspaceName))).type).toBe('record.stop.result');
        const ordinaryBefore = await ordinaryRecordingSnapshot(agent, workspaceName);

        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="launch"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const panelRoot = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const annotator = document.querySelector('#rpa-entity-annotator-host');
            const root = annotator?.shadowRoot;
            const query = document.querySelector('#query-orders');
            const rect = query?.getBoundingClientRect();
            const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
            return {
                title: panelRoot?.querySelector('.checkpoint-recorder header strong')?.textContent || '',
                selected: panelRoot?.querySelector('[data-rpa-checkpoint-field="entity"]')?.selectedOptions?.[0]?.textContent || '',
                highlightOnly: annotator?.hasAttribute('data-rpa-highlight-only') || false,
                interaction: annotator?.getAttribute('data-rpa-interaction-mode') || '',
                pointer: annotator ? getComputedStyle(annotator).pointerEvents : '',
                visible: annotator instanceof HTMLElement && annotator.style.display !== 'none',
                boxes: root?.querySelectorAll('.annotator-box').length || 0,
                labels: [...(root?.querySelectorAll('.annotator-label') || [])].map((item) => item.textContent?.replace(/\s+/g, ' ').trim()),
                markers: [...document.querySelectorAll('[data-rpa-annotation-kind]')].map((item) => ({
                    id: item.id,
                    kind: item.getAttribute('data-rpa-annotation-kind'),
                })),
                labelsClickable: [...(root?.querySelectorAll('.annotator-label') || [])].some((item) => getComputedStyle(item).pointerEvents !== 'none'),
                hitId: hit instanceof HTMLElement ? hit.id : '',
            };
        `), {timeout: 25_000}).toEqual({
            title: '选择业务区域',
            selected: '订单查询',
            highlightOnly: true,
            interaction: 'passthrough',
            pointer: 'none',
            visible: true,
            boxes: 1,
            labels: [],
            markers: [
                {id: 'order-no', kind: 'field'},
                {id: 'buyer', kind: 'field'},
                {id: 'query-orders', kind: 'action'},
            ],
            labelsClickable: false,
            hitId: 'query-orders',
        });

        await pressKey(agent, workspaceName, 'Escape');
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const panelRoot = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const annotator = document.querySelector('#rpa-entity-annotator-host');
            return {
                panelHidden: panelRoot?.querySelector('.checkpoint-recorder')?.hasAttribute('hidden') || false,
                annotatorHidden: annotator instanceof HTMLElement && annotator.style.display === 'none',
                launchText: panelRoot?.querySelector('.checkpoint-launch')?.textContent || '',
            };
        `), {timeout: 10_000}).toEqual({
            panelHidden: true,
            annotatorHidden: true,
            launchText: '录制检查点',
        });
        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="launch"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const panelRoot = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const annotator = document.querySelector('#rpa-entity-annotator-host');
            return {
                setup: panelRoot?.querySelector('.checkpoint-recorder')?.classList.contains('setup') || false,
                visible: annotator instanceof HTMLElement && annotator.style.display === 'block',
            };
        `), {timeout: 20_000}).toEqual({setup: true, visible: true});

        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="start"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('.checkpoint-launch')?.textContent || '';
        `), {timeout: 10_000}).toBe('录制中');
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const panelRoot = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const annotator = document.querySelector('#rpa-entity-annotator-host');
            return {
                panelHidden: panelRoot?.querySelector('.checkpoint-recorder')?.hasAttribute('hidden') || false,
                annotatorHidden: annotator instanceof HTMLElement && annotator.style.display === 'none',
                launchText: panelRoot?.querySelector('.checkpoint-launch')?.textContent || '',
            };
        `), {timeout: 10_000}).toEqual({
            panelHidden: true,
            annotatorHidden: false,
            launchText: '录制中',
        });

        const fillOrder = await runStep(agent.endpoint, workspaceName, step('record-fill-order', 'browser.fill', {
            selector: '#order-no',
            value: 'SO-001',
        }));
        expect(fillOrder.ok, JSON.stringify(fillOrder.error || {})).toBe(true);
        const fillBuyer = await runStep(agent.endpoint, workspaceName, step('record-fill-buyer', 'browser.fill', {
            selector: '#buyer',
            value: '王小虎',
        }));
        expect(fillBuyer.ok, JSON.stringify(fillBuyer.error || {})).toBe(true);
        await clickPoint(agent, workspaceName, await pagePoint(agent, workspaceName, '#query-orders'));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return {
                result: document.querySelector('#query-result')?.textContent || '',
                pointerdown: Number(document.body.dataset.querypointerdown || '0'),
                mousedown: Number(document.body.dataset.querymousedown || '0'),
                pointerup: Number(document.body.dataset.querypointerup || '0'),
                mouseup: Number(document.body.dataset.querymouseup || '0'),
                click: Number(document.body.dataset.queryclick || '0'),
            };
        `)).toEqual({
            result: 'SO-001|王小虎',
            pointerdown: 1,
            mousedown: 1,
            pointerup: 1,
            mouseup: 1,
            click: 1,
        });

        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="launch"]',
        ));
        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="stop"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            return {
                title: root?.querySelector('.checkpoint-recorder header strong')?.textContent || '',
                order: root?.querySelector('[data-rpa-checkpoint-map]')?.value || '',
                mappings: [...(root?.querySelectorAll('[data-rpa-checkpoint-map]') || [])]
                    .map((item) => item.value),
                internal: /checkpointId|matchRules|resolveId|businessTag|profileName/.test(root?.querySelector('.checkpoint-recorder')?.textContent || ''),
                highlightVisible: document.querySelector('#rpa-entity-annotator-host') instanceof HTMLElement
                    && document.querySelector('#rpa-entity-annotator-host').style.display !== 'none',
            };
        `), {timeout: 25_000}).toEqual({
            title: '标注检查点',
            order: 'input:orderNo',
            mappings: ['input:orderNo', 'input:buyer', 'action:query'],
            internal: false,
            highlightVisible: false,
        });
        expect(await ordinaryRecordingSnapshot(agent, workspaceName)).toBe(ordinaryBefore);

        await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const name = root?.querySelector('[data-rpa-checkpoint-field="name"]');
            if (name instanceof HTMLInputElement) {
                name.value = '查询订单';
                name.dispatchEvent(new Event('input', {bubbles: true}));
            }
        `);
        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="save"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('.checkpoint-recorder header strong')?.textContent || '';
        `), {timeout: 20_000}).toBe('检查点已保存');
        expect(await ordinaryRecordingSnapshot(agent, workspaceName)).toBe(ordinaryBefore);

        const listed = await dispatch(agent.endpoint, action('checkpoint.list', workspaceName));
        expect(listed.type).toBe('checkpoint.list.result');
        const checkpoints = (listed.payload as {checkpoints?: Array<{
            checkpointId: string;
            checkpoint: {
                kind?: string;
                name?: string;
                input?: Record<string, unknown>;
                trigger?: {matchRules?: unknown[]};
                body?: {language?: string; source?: string};
                output?: unknown;
            };
        }>}).checkpoints || [];
        expect(checkpoints).toHaveLength(1);
        const checkpoint = checkpoints[0];
        expect(checkpoint.checkpoint.kind).toBe('procedure');
        expect(checkpoint.checkpoint.name).toBe('查询订单');
        expect(checkpoint.checkpoint.input).toEqual({orderNo: 'SO-001', buyer: '王小虎'});
        expect(checkpoint.checkpoint.output).toBeUndefined();
        expect(checkpoint.checkpoint.trigger?.matchRules).toEqual([{
            entityExists: {query: '', kind: 'form', businessTag: 'orders.query'},
        }]);
        expect(checkpoint.checkpoint.body).toEqual({language: 'dsl', source: 'body.dsl'});
        const loaded = await dispatch(agent.endpoint, action('checkpoint.get', workspaceName, {
            checkpointId: checkpoint.checkpointId,
        }));
        expect(loaded.type).toBe('checkpoint.get.result');
        const bodyDsl = (loaded.payload as {bodyDsl?: string}).bodyDsl || '';
        expect(bodyDsl).toContain('use entity_rules "order-query-rule" as entity');
        expect(bodyDsl).toContain('fill entity.ordersQuery.orderNo with input.orderNo');
        expect(bodyDsl).toContain('fill entity.ordersQuery.buyer with input.buyer');
        expect(bodyDsl).toContain('click entity.ordersQuery.query');
        expect(bodyDsl).not.toContain('SO-001');
        expect(bodyDsl).not.toContain('王小虎');
        expect(bodyDsl).not.toContain('#order-no');

        await evaluate(agent, workspaceName, `
            document.querySelector('#order-no').value = '';
            document.querySelector('#buyer').value = '';
            document.querySelector('#query-result').textContent = '';
        `);
        const executed = await runStep(
            agent.endpoint,
            workspaceName,
            step('run-recorded-checkpoint', 'browser.checkpoint', {
                checkpointId: checkpoint.checkpointId,
                input: {orderNo: 'SO-999', buyer: '李雷'},
            }),
        );
        expect(executed.ok, JSON.stringify(executed.error || {})).toBe(true);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return {
                orderNo: document.querySelector('#order-no').value,
                buyer: document.querySelector('#buyer').value,
                result: document.querySelector('#query-result')?.textContent || '',
            };
        `)).toEqual({orderNo: 'SO-999', buyer: '李雷', result: 'SO-999|李雷'});
    } finally {
        await agent.close();
        await fixture.close();
    }
});


test('records a homogeneous row action and replays it against another primary-key row', async ({}, testInfo) => {
    testInfo.setTimeout(180_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    const workspaceName = `checkpoint-row-action-${Date.now()}`;
    try {
        await createWorkspacePage(agent, workspaceName, `${fixture.baseURL}/checkpoint_recorder.html`);
        await saveOrderFulfillmentEntityRule(agent, workspaceName);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return Boolean(document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('[data-rpa-checkpoint-action="launch"]'));
        `), {timeout: 20_000}).toBe(true);

        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="launch"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            return {
                selected: root?.querySelector('[data-rpa-checkpoint-field="entity"]')?.selectedOptions?.[0]?.textContent || '',
                rowMarkers: document.querySelectorAll('.confirm-shipment[data-rpa-record-semantic]').length,
            };
        `), {timeout: 25_000}).toEqual({selected: '订单列表', rowMarkers: 3});

        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="start"]',
        ));
        const fillOrder = await runStep(agent.endpoint, workspaceName, step('row-fill-order', 'browser.fill', {
            selector: '#order-no',
            value: 'SO-002',
        }));
        expect(fillOrder.ok, JSON.stringify(fillOrder.error || {})).toBe(true);
        await clickPoint(agent, workspaceName, await pagePoint(agent, workspaceName, '#query-orders'));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return [...document.querySelectorAll('#orders-table tbody tr')]
                .filter((row) => getComputedStyle(row).display !== 'none')
                .map((row) => row.dataset.orderNo);
        `)).toEqual(['SO-002']);
        await evaluate(agent, workspaceName, `
            document.querySelector('tr[data-order-no="SO-002"] .confirm-shipment')
                ?.scrollIntoView({block: 'center'});
        `);
        const rowActionHit = await evaluate(agent, workspaceName, `
            const target = document.querySelector('tr[data-order-no="SO-002"] .confirm-shipment');
            const rect = target?.getBoundingClientRect();
            const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
            const annotator = document.querySelector('#rpa-entity-annotator-host');
            return {
                rect: rect ? {left: rect.left, top: rect.top, width: rect.width, height: rect.height} : null,
                viewport: {width: innerWidth, height: innerHeight},
                hitClass: hit instanceof HTMLElement ? hit.className : '',
                hitId: hit instanceof HTMLElement ? hit.id : '',
                targetMarker: target?.getAttribute('data-rpa-annotation-id') || '',
                targetSemantic: target?.getAttribute('data-rpa-record-semantic') || '',
                annotatorPointer: annotator ? getComputedStyle(annotator).pointerEvents : '',
            };
        `);
        expect(rowActionHit).toMatchObject({
            hitClass: expect.stringContaining('confirm-shipment'),
            targetMarker: 'confirm-shipment',
            annotatorPointer: 'none',
        });
        await clickPoint(agent, workspaceName, await pagePoint(
            agent,
            workspaceName,
            'tr[data-order-no="SO-002"] .confirm-shipment',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.body.dataset.shippedOrder || '';
        `)).toBe('SO-002');

        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="launch"]',
        ));
        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="stop"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            return {
                mappings: [...(root?.querySelectorAll('[data-rpa-checkpoint-map]') || [])].map((item) => item.value),
                targetRow: root?.querySelector('.checkpoint-recorder')?.textContent?.includes('目标行：订单编号 = SO-002') || false,
            };
        `), {timeout: 25_000}).toEqual({
            mappings: ['input:orderNo', 'action:query', 'row_action:confirmShipment'],
            targetRow: true,
        });

        await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const name = root?.querySelector('[data-rpa-checkpoint-field="name"]');
            if (name instanceof HTMLInputElement) {
                name.value = '查询并确认发货';
                name.dispatchEvent(new Event('input', {bubbles: true}));
            }
        `);
        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="save"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('.checkpoint-recorder header strong')?.textContent || '';
        `), {timeout: 20_000}).toBe('检查点已保存');

        const listed = await dispatch(agent.endpoint, action('checkpoint.list', workspaceName));
        const checkpoints = (listed.payload as {checkpoints?: Array<{
            checkpointId: string;
            checkpoint: {input?: Record<string, unknown>; body?: {language?: string; source?: string}};
        }>}).checkpoints || [];
        expect(checkpoints).toHaveLength(1);
        const checkpoint = checkpoints[0];
        expect(checkpoint.checkpoint.input).toEqual({orderNo: 'SO-002'});
        expect(checkpoint.checkpoint.body).toEqual({language: 'dsl', source: 'body.dsl'});
        const loaded = await dispatch(agent.endpoint, action('checkpoint.get', workspaceName, {
            checkpointId: checkpoint.checkpointId,
        }));
        expect(loaded.type).toBe('checkpoint.get.result');
        const bodyDsl = (loaded.payload as {bodyDsl?: string}).bodyDsl || '';
        expect(bodyDsl).toContain('use entity_rules "order-fulfillment-rule" as entity');
        expect(bodyDsl).toContain('click entity.ordersTable.row(input.orderNo).confirmShipment');
        expect(bodyDsl).not.toContain('SO-002');
        expect(bodyDsl).not.toContain('.confirm-shipment');

        await evaluate(agent, workspaceName, `
            document.querySelector('#order-no').value = '';
            document.querySelector('#buyer').value = '';
            document.querySelector('#query-result').textContent = '';
            delete document.body.dataset.shippedOrder;
            for (const row of document.querySelectorAll('#orders-table tbody tr')) {
                row.style.display = '';
                row.querySelector('.order-status').textContent = '待发货';
                row.querySelector('.order-status').classList.remove('shipped');
            }
        `);
        const directTarget = await runStep(
            agent.endpoint,
            workspaceName,
            {
                ...step('resolve-row-action-target', 'browser.query', {
                    op: 'entity.target',
                    businessTag: 'orders.table',
                    target: {
                        kind: 'table.row_action',
                        primaryKey: {fieldKey: 'orderNo', value: 'SO-003'},
                        actionIntent: 'confirmShipment',
                    },
                }),
                entityRules: {selection: 'explicit', profiles: ['order-fulfillment-rule'], strict: true},
            },
        );
        expect(directTarget.ok, JSON.stringify(directTarget.error || {})).toBe(true);
        const executed = await runStep(
            agent.endpoint,
            workspaceName,
            step('run-row-action-checkpoint', 'browser.checkpoint', {
                checkpointId: checkpoint.checkpointId,
                input: {orderNo: 'SO-003'},
            }),
        );
        expect(executed.ok, JSON.stringify(executed.error || {})).toBe(true);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return {
                shippedOrder: document.body.dataset.shippedOrder || '',
                result: document.querySelector('#query-result')?.textContent || '',
                statuses: Object.fromEntries([...document.querySelectorAll('#orders-table tbody tr')]
                    .map((row) => [row.dataset.orderNo, row.querySelector('.order-status')?.textContent || ''])),
            };
        `), {timeout: 20_000}).toEqual({
            shippedOrder: 'SO-003',
            result: 'SO-003|',
            statuses: {'SO-001': '待发货', 'SO-002': '待发货', 'SO-003': '已发货'},
        });
    } finally {
        await agent.close();
        await fixture.close();
    }
});

test('records an entity-rule driven recovery checkpoint and retries the original operation', async ({}, testInfo) => {
    testInfo.setTimeout(180_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    const workspaceName = `checkpoint-recovery-${Date.now()}`;
    try {
        await createWorkspacePage(agent, workspaceName, `${fixture.baseURL}/checkpoint_recorder.html`);
        await saveExpiredSessionEntityRule(agent, workspaceName);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return Boolean(document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('[data-rpa-checkpoint-action="launch"]'));
        `), {timeout: 20_000}).toBe(true);

        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="launch"]',
        ));
        await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const kind = root?.querySelector('[data-rpa-checkpoint-field="kind"]');
            if (!(kind instanceof HTMLSelectElement)) return false;
            kind.value = 'recovery';
            kind.dispatchEvent(new Event('change', {bubbles: true}));
            return true;
        `);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const panelRoot = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const annotator = document.querySelector('#rpa-entity-annotator-host');
            const dismiss = document.querySelector('#dismiss-session');
            const rect = dismiss?.getBoundingClientRect();
            const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
            return {
                title: panelRoot?.querySelector('.checkpoint-recorder header strong')?.textContent || '',
                selected: panelRoot?.querySelector('[data-rpa-checkpoint-field="entity"]')?.selectedOptions?.[0]?.textContent || '',
                highlightOnly: annotator?.hasAttribute('data-rpa-highlight-only') || false,
                interaction: annotator?.getAttribute('data-rpa-interaction-mode') || '',
                pointer: annotator ? getComputedStyle(annotator).pointerEvents : '',
                marker: document.querySelector('#dismiss-session')?.getAttribute('data-rpa-annotation-kind') || '',
                hitId: hit instanceof HTMLElement ? hit.id : '',
            };
        `), {timeout: 25_000}).toEqual({
            title: '选择错误状态',
            selected: '登录失效提示',
            highlightOnly: true,
            interaction: 'passthrough',
            pointer: 'none',
            marker: 'action',
            hitId: 'dismiss-session',
        });

        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="start"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('.checkpoint-recorder')?.hasAttribute('hidden') || false;
        `), {timeout: 10_000}).toBe(true);
        await clickPoint(agent, workspaceName, await pagePoint(agent, workspaceName, '#dismiss-session'));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return {
                alert: getComputedStyle(document.querySelector('#session-alert')).display,
                protected: getComputedStyle(document.querySelector('#protected-message')).display,
            };
        `)).toEqual({alert: 'none', protected: 'block'});

        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="launch"]',
        ));
        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="stop"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            return {
                title: root?.querySelector('.checkpoint-recorder header strong')?.textContent || '',
                errorState: [...(root?.querySelectorAll('label') || [])]
                    .some((label) => label.firstChild?.textContent?.trim() === '错误状态'),
                selected: root?.querySelector('[data-rpa-checkpoint-field="entity"]')?.selectedOptions?.[0]?.textContent || '',
            };
        `), {timeout: 20_000}).toEqual({
            title: '标注检查点',
            errorState: true,
            selected: '登录失效提示',
        });
        await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const name = root?.querySelector('[data-rpa-checkpoint-field="name"]');
            if (name instanceof HTMLInputElement) {
                name.value = '恢复登录失效状态';
                name.dispatchEvent(new Event('input', {bubbles: true}));
            }
        `);
        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '[data-rpa-checkpoint-action="save"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('.checkpoint-recorder header strong')?.textContent || '';
        `), {timeout: 20_000}).toBe('检查点已保存');

        const listed = await dispatch(agent.endpoint, action('checkpoint.list', workspaceName));
        expect(listed.type).toBe('checkpoint.list.result');
        const checkpoints = (listed.payload as {checkpoints?: Array<{
            checkpointId: string;
            checkpoint: {kind?: string; name?: string; trigger?: {matchRules?: unknown[]}; body?: {language?: string; source?: string}};
        }>}).checkpoints || [];
        expect(checkpoints).toHaveLength(1);
        const checkpoint = checkpoints[0];
        expect(checkpoint.checkpoint.kind).toBe('recovery');
        expect(checkpoint.checkpoint.trigger?.matchRules).toEqual([{
            entityExists: {query: '', kind: 'panel', businessTag: 'auth.expired'},
        }]);
        expect(checkpoint.checkpoint.body).toEqual({language: 'dsl', source: 'body.dsl'});
        const loaded = await dispatch(agent.endpoint, action('checkpoint.get', workspaceName, {
            checkpointId: checkpoint.checkpointId,
        }));
        expect(loaded.type).toBe('checkpoint.get.result');
        const bodyDsl = (loaded.payload as {bodyDsl?: string}).bodyDsl || '';
        expect(bodyDsl).toContain('use entity_rules "expired-session-rule" as entity');
        expect(bodyDsl).toContain('click entity.authExpired.dismiss');
        expect(bodyDsl).not.toContain('#dismiss-session');

        await evaluate(agent, workspaceName, `
            document.querySelector('#session-alert').style.display = 'flex';
            document.querySelector('#protected-message').style.display = 'none';
        `);
        const recovered = await runStep(
            agent.endpoint,
            workspaceName,
            step('protected-original-operation', 'browser.assert', {textVisible: '恢复后的页面'}),
        );
        expect(recovered.ok, JSON.stringify(recovered.error || {})).toBe(true);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return {
                alert: getComputedStyle(document.querySelector('#session-alert')).display,
                visible: getComputedStyle(document.querySelector('#protected-message')).display,
            };
        `), {timeout: 20_000}).toEqual({alert: 'none', visible: 'block'});
    } finally {
        await agent.close();
        await fixture.close();
    }
});
