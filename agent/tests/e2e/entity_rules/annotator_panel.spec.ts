import {test, expect} from '@playwright/test';
import crypto from 'node:crypto';
import {dispatch, runStep, startAgent} from '../../helpers/e2e_multitab_helper';
import {startFixtureServer} from '../../helpers/server';
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
                pickMode: shell?.getAttribute('data-pick-mode') || '',
                selectAction: Boolean(root?.querySelector('[data-annotator-action="select-entity"]')),
                recognizeButton: Boolean(root?.querySelector('[data-annotator-action="recognize"]')),
                hostPointer: host ? getComputedStyle(host).pointerEvents : '',
            };
        `), {timeout: 20_000}).toEqual({
            mode: 'editing',
            draft: 'empty',
            pickMode: 'active',
            selectAction: false,
            recognizeButton: false,
            hostPointer: 'none',
        });

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
            dockText: expect.stringContaining('订单查询列表'),
            markers: {field: 2, column: 5, action: 4, pagination: 2},
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
        await expect.poll(entityAlignment, {timeout: 10_000}).toBeLessThanOrEqual(3);
        expect(await evaluate(agent, workspaceName, `
            document.body.style.minHeight = '1800px';
            window.scrollTo(0, 120);
            return window.scrollY;
        `)).toBe(120);
        await expect.poll(entityAlignment, {timeout: 15_000}).toBeLessThanOrEqual(3);
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

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[data-annotator-action="business-objects"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const panel = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.business-object-panel');
            return {
                open: Boolean(panel),
                text: panel?.textContent?.replace(/\\s+/g, ' ').trim() || '',
            };
        `), {timeout: 10_000}).toEqual({
            open: true,
            text: expect.stringMatching(/筛选字段.*区域操作.*表格列.*行操作.*翻页操作/s),
        });

        const orderFieldPoint = await evaluate<Point | null>(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const item = [...(root?.querySelectorAll('[data-business-object-role="field"]') || [])]
                .find((candidate) => candidate.textContent?.includes('订单编号'));
            const button = item?.querySelector('.object-main');
            if (!(button instanceof HTMLButtonElement)) return null;
            const rect = button.getBoundingClientRect();
            return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
        `);
        expect(orderFieldPoint).not.toBeNull();
        await click(agent, workspaceName, orderFieldPoint!);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return {
                panelOpen: Boolean(root?.querySelector('.business-object-panel')),
                editText: root?.querySelector('.annotator-edit-card')?.textContent
                    ?.replace(/\\s+/g, ' ').trim() || '',
            };
        `), {timeout: 10_000}).toEqual({
            panelOpen: false,
            editText: expect.stringContaining('筛选字段订单编号'),
        });
        await closeEditCard(agent, workspaceName);

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[data-annotator-action="business-objects"]',
        ));
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[data-business-object-add="field"]',
        ));
        await click(agent, workspaceName, await pageElementPoint(
            agent,
            workspaceName,
            '#searchOrders',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.pick-guide strong')?.textContent?.trim() || '';
        `), {timeout: 10_000}).toContain('不能作为筛选字段');
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.pick-guide button',
        ));

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
        expect(((listedRules.payload as {profiles?: Array<{name?: string}>})?.profiles || [])
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
