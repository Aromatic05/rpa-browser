import {test, expect} from '@playwright/test';
import crypto from 'node:crypto';
import {dispatch, runStep, startAgent} from '../../helpers/e2e_multitab_helper';
import {startFixtureServer} from '../../helpers/server';
import {startMockApp} from '../../integration/entity_rules/verify/helper';
import {loadEntityRuleArtifact} from '../../integration/entity_rules/profile_fixture';
import type {Action} from '../../../src/actions/action_protocol';
import type {StepUnion} from '../../../src/runner/steps/types';

const action = (
    type: string,
    workspaceName: string,
    payload: Record<string, unknown> = {},
): Action => ({
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

type AgentHandle = Awaited<ReturnType<typeof startAgent>>;
type Point = {x: number; y: number};

const createWorkspacePage = async (
    agent: AgentHandle,
    workspaceName: string,
    url: string,
): Promise<string> => {
    expect(
        (await dispatch(agent.endpoint, controlAction('workspace.create', {workspaceName}))).type,
    ).toBe('workspace.create.result');
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

    expect((await runStep(
        agent.endpoint,
        workspaceName,
        step(`switch-${Date.now()}`, 'browser.switch_tab', {tabName}),
    )).ok).toBe(true);
    expect((await runStep(
        agent.endpoint,
        workspaceName,
        step(`goto-${Date.now()}`, 'browser.goto', {url}),
    )).ok).toBe(true);
    return tabName;
};

const evaluate = async <T>(
    agent: AgentHandle,
    workspaceName: string,
    expression: string,
): Promise<T> => (
    await runStep(
        agent.endpoint,
        workspaceName,
        step(`evaluate-${Date.now()}-${crypto.randomUUID()}`, 'browser.evaluate', {expression}),
    )
).data as T;

const click = async (
    agent: AgentHandle,
    workspaceName: string,
    point: Point,
): Promise<void> => {
    expect((await runStep(
        agent.endpoint,
        workspaceName,
        step(`click-${Date.now()}-${crypto.randomUUID()}`, 'browser.mouse', {
            action: 'click',
            ...point,
        }),
    )).ok).toBe(true);
};

const shadowButtonPoint = async (
    agent: AgentHandle,
    workspaceName: string,
    selector: string,
): Promise<Point> => {
    const point = await evaluate<Point | null>(agent, workspaceName, `
        const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
        const button = root?.querySelector(${JSON.stringify(selector)});
        if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
        const rect = button.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    `);
    expect(point, `${selector} should be visible and enabled`).not.toBeNull();
    return point!;
};

const pageElementPoint = async (
    agent: AgentHandle,
    workspaceName: string,
    selector: string,
    text?: string,
): Promise<Point> => {
    const point = await evaluate<Point | null>(agent, workspaceName, `
        const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const element = ${text ? `candidates.find((item) => (item.textContent || '').replace(/\\s+/g, '').includes(${JSON.stringify(text)}))` : 'candidates[0]'};
        if (!(element instanceof HTMLElement)) return null;
        element.scrollIntoView({block: 'center', inline: 'center'});
        const rect = element.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    `);
    expect(point, `${selector}${text ? ` containing ${text}` : ''} should be visible`).not.toBeNull();
    return point!;
};

const openAnnotator = async (agent: AgentHandle, workspaceName: string): Promise<void> => {
    let point: Point | null = null;
    await expect.poll(async () => {
        point = await evaluate<Point | null>(agent, workspaceName, `
            const button = document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('.annotate-launch');
            if (!(button instanceof HTMLButtonElement)) return null;
            const rect = button.getBoundingClientRect();
            return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
        `);
        return point;
    }, {timeout: 20_000}).not.toBeNull();
    await click(agent, workspaceName, point!);
};

const closeEditCard = async (agent: AgentHandle, workspaceName: string): Promise<void> => {
    await click(agent, workspaceName, await shadowButtonPoint(
        agent,
        workspaceName,
        '.annotator-edit-card .close-card',
    ));
    await expect.poll(async () => await evaluate<boolean>(agent, workspaceName, `
        return !document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
            ?.querySelector('.annotator-edit-card');
    `), {timeout: 10_000}).toBe(true);
};

test('selects an entity, recognizes presets automatically, and edits the page directly', async ({}, testInfo) => {
    testInfo.setTimeout(180_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    const workspaceName = `annotator-entity-first-${Date.now()}`;
    try {
        await createWorkspacePage(
            agent,
            workspaceName,
            `${fixture.baseURL}/workflow/order_query.html`,
        );
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return {
                rows: document.querySelectorAll('.orders-results tbody tr').length,
                module: Boolean(document.querySelector('.orders-module')),
            };
        `), {timeout: 20_000}).toEqual({rows: 2, module: true});

        await openAnnotator(agent, workspaceName);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const host = document.querySelector('#rpa-entity-annotator-host');
            const root = host?.shadowRoot;
            const shell = root?.querySelector('.annotator-shell');
            return {
                mode: shell?.getAttribute('data-annotator-mode') || '',
                draft: shell?.getAttribute('data-annotator-draft') || '',
                selectText: root?.querySelector('[data-annotator-action="select-entity"]')
                    ?.textContent?.trim() || '',
                recognizeButton: Boolean(root?.querySelector('[data-annotator-action="recognize"]')),
                hostPointer: host ? getComputedStyle(host).pointerEvents : '',
            };
        `), {timeout: 20_000}).toEqual({
            mode: 'editing',
            draft: 'empty',
            selectText: '开始选择',
            recognizeButton: false,
            hostPointer: 'none',
        });

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[data-annotator-action="select-entity"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return root?.querySelector('.annotator-shell')?.getAttribute('data-pick-mode') || '';
        `), {timeout: 10_000}).toBe('active');

        await click(agent, workspaceName, await pageElementPoint(
            agent,
            workspaceName,
            '.orders-results tbody td',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return {
                open: Boolean(root?.querySelector('.annotator-pick-overlay')),
                text: root?.querySelector('.annotator-pick-overlay')?.textContent
                    ?.replace(/\\s+/g, ' ').trim() || '',
            };
        `), {timeout: 20_000}).toEqual({
            open: true,
            text: expect.stringContaining('订单查询列表'),
        });

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.annotator-pick-confirm',
        ));

        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const host = document.querySelector('#rpa-entity-annotator-host');
            const root = host?.shadowRoot;
            const shell = root?.querySelector('.annotator-shell');
            return {
                stage: shell?.getAttribute('data-product-stage') || '',
                draft: shell?.getAttribute('data-annotator-draft') || '',
                hostPointer: host ? getComputedStyle(host).pointerEvents : '',
                dimmed: Boolean(root?.querySelector('.annotator-dim')),
                entityFocused: Boolean(root?.querySelector('.annotator-box.kind-entity')),
                recognizeButton: Boolean(root?.querySelector('[data-annotator-action="recognize"]')),
                dockText: root?.querySelector('.edit-dock')?.textContent
                    ?.replace(/\\s+/g, ' ').trim() || '',
                markers: {
                    field: document.querySelectorAll('[data-rpa-annotation-kind="field"]').length,
                    column: document.querySelectorAll('[data-rpa-annotation-kind="column"]').length,
                    action: document.querySelectorAll('[data-rpa-annotation-kind="action"]').length,
                    pagination: document.querySelectorAll('[data-rpa-annotation-kind="pagination"]').length,
                },
                labels: root?.querySelectorAll('.annotator-label').length || 0,
            };
        `), {timeout: 30_000}).toEqual({
            stage: 'edit',
            draft: 'present',
            hostPointer: 'none',
            dimmed: true,
            entityFocused: true,
            recognizeButton: false,
            dockText: expect.stringContaining('检查标注'),
            markers: {field: 2, column: 5, action: 0, pagination: 2},
            labels: 0,
        });

        const entityAlignment = async (): Promise<number | null> => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const actual = document.querySelector('.orders-module')?.getBoundingClientRect();
            const visual = root?.querySelector('.annotator-box.kind-entity rect')?.getBoundingClientRect();
            if (!actual || !visual) return null;
            return Math.max(
                Math.abs(actual.left - visual.left),
                Math.abs(actual.top - visual.top),
                Math.abs(actual.width - visual.width),
                Math.abs(actual.height - visual.height),
            );
        `);
        await expect.poll(entityAlignment, {timeout: 10_000}).toBeLessThanOrEqual(2);
        expect(await evaluate(agent, workspaceName, `
            document.body.style.minHeight = '1800px';
            window.scrollTo(0, 120);
            return window.scrollY;
        `)).toBe(120);
        await expect.poll(entityAlignment, {timeout: 15_000}).toBeLessThanOrEqual(2);
        await evaluate(agent, workspaceName, `window.scrollTo(0, 0); return window.scrollY;`);

        const headerPoint = await pageElementPoint(agent, workspaceName, 'th', '订单编号');
        const headerHit = await evaluate(agent, workspaceName, `
            const point = ${JSON.stringify(headerPoint)};
            const hit = document.elementFromPoint(point.x, point.y);
            return {tag: hit?.tagName || '', host: hit?.id || ''};
        `);
        expect(headerHit).toEqual({tag: 'TH', host: ''});
        await click(agent, workspaceName, headerPoint);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card')?.textContent
                ?.replace(/\\s+/g, ' ').trim() || '';
        `), {timeout: 10_000}).toEqual(expect.stringContaining('表格列订单编号'));
        expect(await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card')?.textContent?.includes('业务区域') || false;
        `)).toBe(false);
        await closeEditCard(agent, workspaceName);

        await click(agent, workspaceName, await pageElementPoint(
            agent,
            workspaceName,
            '#orderNoQuery',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card')?.textContent
                ?.replace(/\\s+/g, ' ').trim() || '';
        `), {timeout: 10_000}).toEqual(expect.stringContaining('字段订单编号'));
        await closeEditCard(agent, workspaceName);

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.annotator-save-action',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return {
                saveText: root?.querySelector('.annotator-save-action')?.textContent
                    ?.replace(/\\s+/g, ' ').trim() || '',
                error: root?.querySelector('.annotator-error-banner p')?.textContent?.trim() || '',
            };
        `), {timeout: 30_000}).toEqual({saveText: '✓ 已保存', error: ''});

        const listedRules = await dispatch(agent.endpoint, action('entity_rules.list', workspaceName));
        expect(listedRules.type).toBe('entity_rules.list.result');
        expect(((listedRules.payload as {entityRules?: Array<{name?: string}>})?.entityRules || [])
            .some((rule) => Boolean(rule.name))).toBe(true);

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[aria-label="退出"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const host = document.querySelector('#rpa-entity-annotator-host');
            return host instanceof HTMLElement && host.style.display === 'none';
        `), {timeout: 10_000}).toBe(true);

        await openAnnotator(agent, workspaceName);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return {
                draft: root?.querySelector('.annotator-shell')?.getAttribute('data-annotator-draft') || '',
                stage: root?.querySelector('.annotator-shell')?.getAttribute('data-product-stage') || '',
                saveText: root?.querySelector('.annotator-save-action')?.textContent
                    ?.replace(/\\s+/g, ' ').trim() || '',
                columns: document.querySelectorAll('[data-rpa-annotation-kind="column"]').length,
            };
        `), {timeout: 20_000}).toEqual({
            draft: 'present',
            stage: 'edit',
            saveText: '✓ 已保存',
            columns: 5,
        });
    } finally {
        await agent.close();
        await fixture.close();
    }
});

test('uses direct DOM markers for saved table rules and edits one representative action', async ({}, testInfo) => {
    testInfo.setTimeout(150_000);
    const mock = await startMockApp('ant');
    const agent = await startAgent();
    const workspaceName = `annotator-table-${Date.now()}`;
    try {
        await createWorkspacePage(agent, workspaceName, 'about:blank');
        const artifact = await loadEntityRuleArtifact('oa-ant-orders');
        expect((await dispatch(
            agent.endpoint,
            action('entity_rules.save', workspaceName, {entityRules: artifact}),
        )).type).toBe('entity_rules.save.result');
        expect((await runStep(
            agent.endpoint,
            workspaceName,
            step(`goto-orders-${Date.now()}`, 'browser.goto', {
                url: `${mock.baseUrl}/entity-rules/fixtures/order-list`,
            }),
        )).ok).toBe(true);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelectorAll('table tbody tr').length;
        `), {timeout: 20_000}).toBeGreaterThan(0);

        await openAnnotator(agent, workspaceName);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const host = document.querySelector('#rpa-entity-annotator-host');
            const root = host?.shadowRoot;
            const headers = [...document.querySelectorAll('th')];
            const headerRow = document.querySelector('thead tr');
            const actions = [...document.querySelectorAll('[data-rpa-annotation-kind="action"]')];
            return {
                stage: root?.querySelector('.annotator-shell')?.getAttribute('data-product-stage') || '',
                hostPointer: host ? getComputedStyle(host).pointerEvents : '',
                markers: {
                    columns: document.querySelectorAll('[data-rpa-annotation-kind="column"]').length,
                    actions: actions.length,
                    pagination: document.querySelectorAll('[data-rpa-annotation-kind="pagination"]').length,
                },
                labels: root?.querySelectorAll('.annotator-label').length || 0,
                headerOutline: headerRow ? getComputedStyle(headerRow).outlineStyle : '',
                separators: headers.map((header) => getComputedStyle(header).boxShadow),
                actionTexts: actions
                    .map((item) => (item.textContent || '').replace(/\\s+/g, ''))
                    .sort(),
            };
        `), {timeout: 20_000}).toEqual({
            stage: 'edit',
            hostPointer: 'none',
            markers: {columns: 5, actions: 2, pagination: 2},
            labels: 0,
            headerOutline: 'dashed',
            separators: [
                expect.stringContaining('-1px 0px'),
                expect.stringContaining('-1px 0px'),
                expect.stringContaining('-1px 0px'),
                expect.stringContaining('-1px 0px'),
                'none',
            ],
            actionTexts: ['删除', '编辑'],
        });

        const buyerPoint = await pageElementPoint(agent, workspaceName, 'th', '采购人');
        await click(agent, workspaceName, buyerPoint);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card')?.textContent
                ?.replace(/\\s+/g, ' ').trim() || '';
        `), {timeout: 10_000}).toEqual(expect.stringContaining('表格列采购人'));

        let primaryKeyPoint: (Point & {pressed: string | null}) | null = null;
        await expect.poll(async () => {
            primaryKeyPoint = await evaluate(agent, workspaceName, `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const card = root?.querySelector('.annotator-edit-card');
                const button = card?.querySelector('.primary-key-choice');
                if (!(button instanceof HTMLButtonElement)) return null;
                const rect = button.getBoundingClientRect();
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    pressed: button.getAttribute('aria-pressed'),
                };
            `);
            return primaryKeyPoint;
        }, {timeout: 10_000}).not.toBeNull();
        expect(primaryKeyPoint!.pressed).toBe('false');
        await click(agent, workspaceName, primaryKeyPoint!);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.primary-key-choice')?.getAttribute('aria-pressed') || '';
        `), {timeout: 10_000}).toBe('true');
        await closeEditCard(agent, workspaceName);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const headers = [...document.querySelectorAll('th')];
            const byText = (text) => headers.find((item) => (item.textContent || '').includes(text));
            return {
                buyer: byText('采购人')?.getAttribute('data-rpa-primary-key') || '',
                orderNo: byText('订单编号')?.getAttribute('data-rpa-primary-key') || '',
            };
        `), {timeout: 10_000}).toEqual({buyer: 'true', orderNo: ''});

        const editPoint = await pageElementPoint(
            agent,
            workspaceName,
            '[data-rpa-annotation-kind="action"]',
            '编辑',
        );
        await click(agent, workspaceName, editPoint);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const inputs = root?.querySelectorAll('.annotator-edit-card .card-fields input');
            return {
                card: root?.querySelector('.annotator-edit-card')?.textContent
                    ?.replace(/\\s+/g, ' ').trim() || '',
                key: inputs?.[1] instanceof HTMLInputElement ? inputs[1].value : '',
            };
        `), {timeout: 10_000}).toEqual({
            card: expect.stringContaining('编辑'),
            key: 'edit',
        });

        expect(await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const input = root?.querySelectorAll('.annotator-edit-card .card-fields input')?.[1];
            if (!(input instanceof HTMLInputElement)) return false;
            input.value = 'EDITROW';
            input.dispatchEvent(new Event('input', {bubbles: true}));
            return true;
        `)).toBe(true);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const input = root?.querySelectorAll('.annotator-edit-card .card-fields input')?.[1];
            const marker = [...document.querySelectorAll('[data-rpa-annotation-kind="action"]')]
                .find((item) => (item.textContent || '').replace(/\\s+/g, '').includes('编辑'));
            return {
                value: input instanceof HTMLInputElement ? input.value : '',
                state: marker?.getAttribute('data-rpa-annotation-state') || '',
            };
        `), {timeout: 10_000}).toEqual({value: 'EDITROW', state: 'selected'});
        await closeEditCard(agent, workspaceName);

        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const marker = [...document.querySelectorAll('[data-rpa-annotation-kind="action"]')]
                .find((item) => (item.textContent || '').replace(/\\s+/g, '').includes('编辑'));
            return marker?.getAttribute('data-rpa-annotation-state') || '';
        `), {timeout: 10_000}).toBe('confirmed');

        expect(await evaluate(agent, workspaceName, `
            const actions = [...document.querySelectorAll('[data-rpa-annotation-kind="action"]')];
            const counts = new Map();
            for (const item of actions) {
                const id = item.getAttribute('data-rpa-annotation-id') || '';
                counts.set(id, (counts.get(id) || 0) + 1);
            }
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return {
                actionCount: actions.length,
                oneRepresentativeEach: [...counts.values()].every((count) => count === 1),
                labels: root?.querySelectorAll('.annotator-label').length || 0,
            };
        `)).toEqual({
            actionCount: 2,
            oneRepresentativeEach: true,
            labels: 0,
        });
    } finally {
        await agent.close();
        await mock.close();
    }
});
