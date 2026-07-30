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

const mouse = async (
    agent: AgentHandle,
    workspaceName: string,
    actionName: 'move' | 'down' | 'up' | 'click',
    point: Point,
): Promise<void> => {
    expect((await runStep(
        agent.endpoint,
        workspaceName,
        step(`mouse-${Date.now()}-${crypto.randomUUID()}`, 'browser.mouse', {
            action: actionName,
            ...point,
        }),
    )).ok).toBe(true);
};

const click = async (
    agent: AgentHandle,
    workspaceName: string,
    point: Point,
): Promise<void> => await mouse(agent, workspaceName, 'click', point);

const pressKey = async (
    agent: AgentHandle,
    workspaceName: string,
    key: string,
): Promise<void> => {
    expect((await runStep(
        agent.endpoint,
        workspaceName,
        step(`key-${Date.now()}-${crypto.randomUUID()}`, 'browser.press_key', {key}),
    )).ok).toBe(true);
};

const entityRuleSnapshot = async (
    agent: AgentHandle,
    workspaceName: string,
): Promise<string> => {
    const reply = await dispatch(agent.endpoint, action('entity_rules.list', workspaceName));
    expect(reply.type).toBe('entity_rules.list.result');
    const profiles = ((reply.payload as {profiles?: unknown[]})?.profiles ?? []);
    return JSON.stringify(profiles);
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

const floatingPanelButtonPoint = async (
    agent: AgentHandle,
    workspaceName: string,
    selector: string,
    text?: string,
): Promise<Point> => {
    const point = await evaluate<Point | null>(agent, workspaceName, `
        const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
        const candidates = [...(root?.querySelectorAll(${JSON.stringify(selector)}) || [])];
        const button = ${text
            ? `candidates.find((item) => item.textContent?.trim() === ${JSON.stringify(text)})`
            : 'candidates[0]'};
        if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
        const rect = button.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    `);
    expect(point, `${selector}${text ? ` with text ${text}` : ''} should be visible`).not.toBeNull();
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
        const initialRules = await entityRuleSnapshot(agent, workspaceName);

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
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[data-annotator-action="hide-pick-guide"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const guide = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.pick-guide');
            return {
                compact: guide?.classList.contains('compact') || false,
                exitVisible: Boolean(guide?.querySelector('[data-annotator-action="cancel-pick"]')),
                copyVisible: Boolean(guide?.querySelector('.pick-guide-icon')),
            };
        `), {timeout: 10_000}).toEqual({compact: true, exitVisible: true, copyVisible: false});

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
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);

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
                guideInDock: Boolean(root?.querySelector('.edit-dock .dock-guide')),
                separateGuide: Boolean(root?.querySelector('.pick-guide')),
                markers: {
                    field: document.querySelectorAll('[data-rpa-annotation-kind="field"]').length,
                    column: document.querySelectorAll('[data-rpa-annotation-kind="column"]').length,
                    action: document.querySelectorAll('[data-rpa-annotation-kind="action"]').length,
                    pagination: document.querySelectorAll('[data-rpa-annotation-kind="pagination"]').length,
                },
                labels: root?.querySelectorAll('.annotator-label').length || 0,
            };
        `), {timeout: 30_000}).toEqual({
            stage: 'review',
            draft: 'present',
            hostPointer: 'none',
            dimmed: true,
            entityFocused: true,
            recognizeButton: false,
            dockText: expect.stringContaining('识别完成'),
            guideInDock: true,
            separateGuide: false,
            markers: {field: 2, column: 5, action: 4, pagination: 2},
            labels: 0,
        });
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.dock-guide button',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return {
                guide: Boolean(root?.querySelector('.dock-guide')),
                stage: root?.querySelector('.annotator-shell')?.getAttribute('data-product-stage') || '',
            };
        `), {timeout: 10_000}).toEqual({guide: false, stage: 'edit'});

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
            const text = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card')?.textContent || '';
            return {
                contentType: text.includes('内容类型'),
                primaryKey: text.includes('主键列'),
                internalField: text.includes('业务标识'),
            };
        `)).toEqual({contentType: true, primaryKey: true, internalField: false});
        expect(await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card')?.textContent?.includes('业务区域') || false;
        `)).toBe(false);
        expect(await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const card = root?.querySelector('.annotator-edit-anchor')?.getBoundingClientRect();
            const target = document.querySelector('th')?.getBoundingClientRect();
            if (!card || !target) return false;
            return !(Math.min(card.right, target.right) > Math.max(card.left, target.left) &&
                Math.min(card.bottom, target.bottom) > Math.max(card.top, target.top));
        `)).toBe(true);

        const cardBeforeDrag = await evaluate<{x: number; y: number}>(agent, workspaceName, `
            const card = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-anchor');
            const rect = card?.getBoundingClientRect();
            return {x: rect?.left || 0, y: rect?.top || 0};
        `);
        const dragHandlePoint = await evaluate<Point | null>(agent, workspaceName, `
            const handle = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.edit-card-drag-handle');
            if (!(handle instanceof HTMLElement)) return null;
            const rect = handle.getBoundingClientRect();
            return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
        `);
        expect(dragHandlePoint).not.toBeNull();
        await mouse(agent, workspaceName, 'move', dragHandlePoint!);
        await mouse(agent, workspaceName, 'down', dragHandlePoint!);
        await mouse(agent, workspaceName, 'move', {x: dragHandlePoint!.x + 54, y: dragHandlePoint!.y + 28});
        await mouse(agent, workspaceName, 'up', {x: dragHandlePoint!.x + 54, y: dragHandlePoint!.y + 28});
        const cardAfterDrag = await evaluate<{x: number; y: number}>(agent, workspaceName, `
            const card = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-anchor');
            const rect = card?.getBoundingClientRect();
            return {x: rect?.left || 0, y: rect?.top || 0};
        `);
        expect(Math.abs(cardAfterDrag.x - cardBeforeDrag.x) + Math.abs(cardAfterDrag.y - cardBeforeDrag.y)).toBeGreaterThan(8);

        expect(await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const select = root?.querySelector('.annotator-edit-card select');
            if (!(select instanceof HTMLSelectElement)) return false;
            select.value = 'number';
            select.dispatchEvent(new Event('change', {bubbles: true}));
            return select.value === 'number';
        `)).toBe(true);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const button = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-save-action');
            return {
                enabled: button instanceof HTMLButtonElement && !button.disabled,
                text: button?.textContent?.replace(/\s+/g, ' ').trim() || '',
            };
        `), {timeout: 10_000}).toEqual({enabled: true, text: '先应用当前修改'});
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);
        await click(agent, workspaceName, await pageElementPoint(
            agent,
            workspaceName,
            '.orders-header h1',
        ));
        await expect.poll(async () => await evaluate<boolean>(agent, workspaceName, `
            return !document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card');
        `), {timeout: 10_000}).toBe(true);

        await click(agent, workspaceName, headerPoint);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const select = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card select');
            return select instanceof HTMLSelectElement ? select.value : '';
        `), {timeout: 10_000}).toBe('text');
        await evaluate(agent, workspaceName, `
            const select = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card select');
            if (select instanceof HTMLSelectElement) {
                select.value = 'number';
                select.dispatchEvent(new Event('change', {bubbles: true}));
            }
        `);
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.annotator-edit-card .apply',
        ));
        await expect.poll(async () => await evaluate<boolean>(agent, workspaceName, `
            return !document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card');
        `), {timeout: 10_000}).toBe(true);
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[aria-label="设置"]',
        ));
        await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const input = root?.querySelector('.settings-popover input');
            if (input instanceof HTMLInputElement) {
                input.value = '订单查询列表（已配置）';
                input.dispatchEvent(new Event('input', {bubbles: true}));
            }
        `);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const save = root?.querySelector('.annotator-save-action');
            return {
                open: Boolean(root?.querySelector('.settings-popover')),
                saveEnabled: save instanceof HTMLButtonElement && !save.disabled,
                saveText: save?.textContent?.replace(/\s+/g, ' ').trim() || '',
                dockNameChanged: root?.querySelector('.dock-copy')?.textContent?.includes('已配置') || false,
            };
        `), {timeout: 10_000}).toEqual({
            open: true,
            saveEnabled: true,
            saveText: '先应用当前修改',
            dockNameChanged: false,
        });
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[data-annotator-action="exit"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return {
                settingsOpen: Boolean(root?.querySelector('.settings-popover')),
                exitConfirm: Boolean(root?.querySelector('.exit-confirm')),
                guide: root?.querySelector('.dock-guide')?.textContent?.replace(/\s+/g, ' ').trim() || '',
            };
        `), {timeout: 10_000}).toEqual({
            settingsOpen: true,
            exitConfirm: false,
            guide: expect.stringContaining('请先应用或取消当前修改'),
        });
        await click(agent, workspaceName, await pageElementPoint(agent, workspaceName, '.orders-header h1'));
        await expect.poll(async () => await evaluate<boolean>(agent, workspaceName, `
            return !document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.settings-popover');
        `), {timeout: 10_000}).toBe(true);
        expect(await evaluate<boolean>(agent, workspaceName, `
            return document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.dock-copy')?.textContent?.includes('已配置') || false;
        `)).toBe(false);

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[aria-label="设置"]',
        ));
        await evaluate(agent, workspaceName, `
            const input = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.settings-popover input');
            if (input instanceof HTMLInputElement) {
                input.value = '订单查询列表（已配置）';
                input.dispatchEvent(new Event('input', {bubbles: true}));
            }
        `);
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.settings-popover .dock-primary',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return {
                open: Boolean(root?.querySelector('.settings-popover')),
                dockNameChanged: root?.querySelector('.dock-copy')?.textContent?.includes('已配置') || false,
            };
        `), {timeout: 10_000}).toEqual({open: false, dockNameChanged: true});
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);

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
                internalKeys: panel?.querySelectorAll('.object-copy small').length || 0,
            };
        `), {timeout: 10_000}).toEqual({
            open: true,
            text: expect.stringMatching(/筛选字段.*列表操作.*表格列.*行操作.*分页/s),
            internalKeys: 0,
        });
        const objectPanelBefore = await evaluate<{x: number; y: number}>(agent, workspaceName, `
            const panel = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.business-object-panel')?.getBoundingClientRect();
            return {x: panel?.left || 0, y: panel?.top || 0};
        `);
        const objectPanelHandle = await evaluate<Point | null>(agent, workspaceName, `
            const handle = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.panel-drag-handle');
            if (!(handle instanceof HTMLElement)) return null;
            const rect = handle.getBoundingClientRect();
            return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
        `);
        expect(objectPanelHandle).not.toBeNull();
        await mouse(agent, workspaceName, 'move', objectPanelHandle!);
        await mouse(agent, workspaceName, 'down', objectPanelHandle!);
        await mouse(agent, workspaceName, 'move', {x: objectPanelHandle!.x - 48, y: objectPanelHandle!.y - 24});
        await mouse(agent, workspaceName, 'up', {x: objectPanelHandle!.x - 48, y: objectPanelHandle!.y - 24});
        const objectPanelAfter = await evaluate<{x: number; y: number}>(agent, workspaceName, `
            const panel = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.business-object-panel')?.getBoundingClientRect();
            return {x: panel?.left || 0, y: panel?.top || 0};
        `);
        expect(Math.abs(objectPanelAfter.x - objectPanelBefore.x) + Math.abs(objectPanelAfter.y - objectPanelBefore.y)).toBeGreaterThan(8);
        await pressKey(agent, workspaceName, 'Escape');
        await expect.poll(async () => await evaluate<boolean>(agent, workspaceName, `
            return !document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.business-object-panel');
        `), {timeout: 10_000}).toBe(true);
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[data-annotator-action="business-objects"]',
        ));

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
        expect(await evaluate(agent, workspaceName, `
            const text = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-edit-card')?.textContent || '';
            return {
                fieldBinding: text.includes('对应表格列'),
                businessKey: text.includes('业务标识'),
                ruleName: text.includes('规则名称'),
            };
        `)).toEqual({fieldBinding: true, businessKey: false, ruleName: false});
        const countBeforeDeletePrompt = await evaluate<number>(agent, workspaceName, `
            const text = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('[data-annotator-action="business-objects"]')?.textContent || '';
            return Number(text.match(/[0-9]+/)?.[0] || 0);
        `);
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.annotator-edit-card .danger',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return {
                confirm: root?.querySelector('.delete-confirm')?.textContent?.replace(/\s+/g, ' ').trim() || '',
                count: Number(root?.querySelector('[data-annotator-action="business-objects"]')?.textContent?.match(/[0-9]+/)?.[0] || 0),
            };
        `), {timeout: 10_000}).toEqual({
            confirm: expect.stringContaining('确认删除这个对象'),
            count: countBeforeDeletePrompt,
        });
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.delete-confirm .secondary',
        ));
        await expect.poll(async () => await evaluate<boolean>(agent, workspaceName, `
            return !document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.delete-confirm');
        `), {timeout: 10_000}).toBe(true);
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
        await evaluate(agent, workspaceName, `
            window.__pickerEventCounts = {pointerdown: 0, mousedown: 0, pointerup: 0, mouseup: 0, click: 0};
            const button = document.querySelector('#searchOrders');
            for (const type of Object.keys(window.__pickerEventCounts)) {
                button?.addEventListener(type, () => { window.__pickerEventCounts[type] += 1; });
            }
        `);
        await click(agent, workspaceName, await pageElementPoint(
            agent,
            workspaceName,
            '#searchOrders',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.pick-guide strong')?.textContent?.trim() || '';
        `), {timeout: 10_000}).toContain('不能作为筛选字段');
        expect(await evaluate(agent, workspaceName, `window.__pickerEventCounts`)).toEqual({
            pointerdown: 0,
            mousedown: 0,
            pointerup: 0,
            mouseup: 0,
            click: 0,
        });
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[data-annotator-action="cancel-pick"]',
        ));

        let objectCountBeforeAdd = 0;
        await expect.poll(async () => {
            const state = await evaluate<{
                count: number;
                mode: string;
                stage: string;
                pickMode: string;
                dock: boolean;
                error: string;
            }>(agent, workspaceName, `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const text = root?.querySelector('[data-annotator-action="business-objects"]')?.textContent || '';
                const shell = root?.querySelector('.annotator-shell');
                return {
                    count: Number(text.match(/[0-9]+/)?.[0] || 0),
                    mode: shell?.getAttribute('data-annotator-mode') || '',
                    stage: shell?.getAttribute('data-product-stage') || '',
                    pickMode: shell?.getAttribute('data-pick-mode') || '',
                    dock: Boolean(root?.querySelector('.edit-dock')),
                    error: root?.querySelector('.annotator-error-banner')?.textContent?.trim() || '',
                };
            `);
            objectCountBeforeAdd = state.count;
            return state;
        }, {timeout: 10_000}).toEqual({
            count: expect.any(Number),
            mode: 'editing',
            stage: 'edit',
            pickMode: 'inactive',
            dock: true,
            error: '',
        });
        expect(objectCountBeforeAdd).toBeGreaterThan(0);
        await evaluate(agent, workspaceName, `
            const form = document.querySelector('.orders-query');
            const wrapper = document.createElement('div');
            wrapper.className = 'field extra-field';
            wrapper.innerHTML = '<label for="remarkQuery">备注</label><input id="remarkQuery" name="remark" />';
            form?.appendChild(wrapper);
        `);
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
            '#remarkQuery',
        ));
        await expect.poll(async () => await evaluate<boolean>(agent, workspaceName, `
            return Boolean(document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-pick-confirm'));
        `), {timeout: 10_000}).toBe(true);
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.annotator-pick-confirm',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const pending = root?.querySelector('.pending-edit-anchor');
            const countText = root?.querySelector('[data-annotator-action="business-objects"]')?.textContent || '';
            return {
                pending: Boolean(pending),
                editor: pending?.querySelector('.annotator-edit-card')?.textContent?.replace(/\s+/g, ' ').trim() || '',
                count: Number(countText.match(/[0-9]+/)?.[0] || 0),
            };
        `), {timeout: 10_000}).toEqual({
            pending: true,
            editor: expect.stringContaining('筛选字段'),
            count: objectCountBeforeAdd,
        });
        expect(await evaluate(agent, workspaceName, `
            const button = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.annotator-save-action');
            return {
                enabled: button instanceof HTMLButtonElement && !button.disabled,
                text: button?.textContent?.replace(/\s+/g, ' ').trim() || '',
            };
        `)).toEqual({enabled: true, text: '先应用当前修改'});
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.annotator-save-action',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            return {
                pending: Boolean(root?.querySelector('.pending-edit-anchor')),
                guide: root?.querySelector('.dock-guide')?.textContent?.replace(/\s+/g, ' ').trim() || '',
            };
        `), {timeout: 10_000}).toEqual({
            pending: true,
            guide: expect.stringContaining('请先应用或取消当前修改'),
        });
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);
        await evaluate(agent, workspaceName, `
            const input = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.pending-edit-anchor input');
            if (input instanceof HTMLInputElement) {
                input.value = '备注';
                input.dispatchEvent(new Event('input', {bubbles: true}));
            }
        `);
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.pending-edit-anchor .apply',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const shell = root?.querySelector('.annotator-shell');
            const countText = root?.querySelector('[data-annotator-action="business-objects"]')?.textContent || '';
            return {
                pending: Boolean(root?.querySelector('.pending-edit-anchor')),
                button: Boolean(root?.querySelector('[data-annotator-action="business-objects"]')),
                countText: countText.trim(),
                stage: shell?.getAttribute('data-product-stage') || '',
                draft: shell?.getAttribute('data-annotator-draft') || '',
            };
        `), {timeout: 10_000}).toEqual({
            pending: false,
            button: true,
            countText: expect.stringContaining(String(objectCountBeforeAdd + 1)),
            stage: 'edit',
            draft: 'present',
        });
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[data-annotator-action="exit"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const host = document.querySelector('#rpa-entity-annotator-host');
            const root = host?.shadowRoot;
            return {
                visible: host instanceof HTMLElement && host.style.display !== 'none',
                confirm: root?.querySelector('.exit-confirm')?.textContent?.replace(/\s+/g, ' ').trim() || '',
            };
        `), {timeout: 10_000}).toEqual({
            visible: true,
            confirm: expect.stringContaining('有未保存修改'),
        });
        await pressKey(agent, workspaceName, 'Escape');
        await expect.poll(async () => await evaluate<boolean>(agent, workspaceName, `
            return !document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                ?.querySelector('.exit-confirm');
        `), {timeout: 10_000}).toBe(true);

        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '[data-annotator-action="exit"]',
        ));
        await click(agent, workspaceName, await shadowButtonPoint(
            agent,
            workspaceName,
            '.exit-confirm-action',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const host = document.querySelector('#rpa-entity-annotator-host');
            return host instanceof HTMLElement && host.style.display === 'none';
        `), {timeout: 10_000}).toBe(true);
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);

        await openAnnotator(agent, workspaceName);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
            const text = root?.querySelector('[data-annotator-action="business-objects"]')?.textContent || '';
            return {
                draft: root?.querySelector('.annotator-shell')?.getAttribute('data-annotator-draft') || '',
                stage: root?.querySelector('.annotator-shell')?.getAttribute('data-product-stage') || '',
                count: Number(text.match(/[0-9]+/)?.[0] || 0),
                saveText: root?.querySelector('.annotator-save-action')?.textContent?.replace(/\s+/g, ' ').trim() || '',
            };
        `), {timeout: 20_000}).toEqual({
            draft: 'present',
            stage: 'edit',
            count: objectCountBeforeAdd + 1,
            saveText: '保存规则',
        });
        expect(await entityRuleSnapshot(agent, workspaceName)).toBe(initialRules);

        await click(agent, workspaceName, await floatingPanelButtonPoint(
            agent,
            workspaceName,
            '.ball',
        ));
        await expect.poll(async () => await evaluate<boolean>(agent, workspaceName, `
            return document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('.panel')?.classList.contains('open') || false;
        `), {timeout: 10_000}).toBe(true);
        await click(agent, workspaceName, await floatingPanelButtonPoint(
            agent,
            workspaceName,
            '.tabs button',
            'ER',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const text = root?.querySelector('.debug-json')?.textContent || '';
            return {
                canvasDraft: text.includes('canvasDraft'),
                businessTag: text.includes('businessTag'),
                fieldKey: text.includes('fieldKey'),
                latestCheck: text.includes('latestCheck'),
                pageBridge: Boolean(document.getElementById('rpa-annotator-debug-state')),
            };
        `), {timeout: 10_000}).toEqual({
            canvasDraft: true,
            businessTag: true,
            fieldKey: true,
            latestCheck: true,
            pageBridge: false,
        });
        await click(agent, workspaceName, await floatingPanelButtonPoint(
            agent,
            workspaceName,
            '.ball',
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
        expect(await entityRuleSnapshot(agent, workspaceName)).not.toBe(initialRules);

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
