import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { dispatch, runStep, startAgent } from '../../helpers/e2e_multitab_helper';
import { startFixtureServer } from '../../helpers/server';
import { startMockApp } from '../../integration/entity_rules/verify/helper';
import { loadEntityRuleArtifact } from '../../integration/entity_rules/profile_fixture';
import type { Action } from '../../../src/actions/action_protocol';
import type { StepUnion } from '../../../src/runner/steps/types';

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

test('loads the built extension and opens the annotator through the Debug panel', async ({}, testInfo) => {
    testInfo.setTimeout(150_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    const workspaceName = `annotator-extension-${Date.now()}`;
    try {
        expect((await dispatch(agent.endpoint, controlAction('workspace.create', {workspaceName}))).type)
            .toBe('workspace.create.result');
        const before = await dispatch(agent.endpoint, action('tab.list', workspaceName));
        const beforeNames = new Set(((before.payload as {tabs?: Array<{tabName: string}>})?.tabs || []).map((tab) => tab.tabName));
        const opened = await dispatch(agent.endpoint, action('tab.open', workspaceName));
        expect(opened.type).toBe('tab.open.result');
        let tabName = '';
        await expect.poll(async () => {
            const listed = await dispatch(agent.endpoint, action('tab.list', workspaceName));
            tabName = ((listed.payload as {tabs?: Array<{tabName: string}>})?.tabs || [])
                .find((tab) => !beforeNames.has(tab.tabName))?.tabName || '';
            return tabName;
        }, {timeout: 10_000}).toBeTruthy();
        expect((await runStep(agent.endpoint, workspaceName, step('switch', 'browser.switch_tab', {tabName}))).ok)
            .toBe(true);
        expect((await runStep(agent.endpoint, workspaceName, step('goto', 'browser.goto', {
            url: `${fixture.baseURL}/workflow/customer_intake.html`,
        }))).ok).toBe(true);

        const clickPanel = `
            const host = document.querySelector('#rpa-floating-panel');
            const root = host?.shadowRoot;
            if (!root?.querySelector('.panel')?.classList.contains('open')) root?.querySelector('.ball')?.click();
            [...(root?.querySelectorAll('.tabs button') || [])]
                .find((button) => button.textContent?.trim() === 'Flow')?.click();
            const button = [...(root?.querySelectorAll('button') || [])]
                .find((item) => item.textContent?.trim() === '进入标注模式');
            button?.click();
            return Boolean(button);
        `;
        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `open-${Date.now()}`, 'browser.evaluate', {expression: clickPanel},
        ))).data, {timeout: 20_000}).toBe(true);

        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `inspect-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return {
                    style: Boolean(root?.querySelector('style[data-rpa-annotator-style]')),
                    canvas: Boolean(root?.querySelector('svg.annotator-canvas')),
                    toolbar: Boolean(root?.querySelector('.annotator-toolbar')),
                    mode: root?.querySelector('.annotator-root')?.getAttribute('data-annotator-mode'),
                };
            `},
        ))).data, {timeout: 20_000}).toEqual({style: true, canvas: true, toolbar: true, mode: 'editing'});

        const recognizePoint = (await runStep(agent.endpoint, workspaceName, step(
            `recognize-point-${Date.now()}`, 'browser.evaluate', {expression: `
                const button = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                    ?.querySelector('[data-annotator-action="recognize"]');
                if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
                const rect = button.getBoundingClientRect();
                return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
            `},
        ))).data as {x: number; y: number} | null;
        expect(recognizePoint).not.toBeNull();
        expect((await runStep(agent.endpoint, workspaceName, step(
            `recognize-${Date.now()}`, 'browser.mouse', {
                action: 'click',
                x: recognizePoint!.x,
                y: recognizePoint!.y,
            },
        ))).ok).toBe(true);

        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `recognized-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const app = root?.querySelector('.annotator-root');
                const add = [...(root?.querySelectorAll('button') || [])]
                    .find((button) => button.textContent?.trim() === '新增标注');
                return {
                    draft: app?.getAttribute('data-annotator-draft'),
                    profile: app?.getAttribute('data-annotator-profile') || '',
                    addEnabled: add instanceof HTMLButtonElement && !add.disabled,
                    error: root?.querySelector('.annotator-flag-error')?.textContent?.trim() || '',
                };
            `},
        ))).data, {timeout: 20_000}).toEqual({
            draft: 'present',
            profile: expect.any(String),
            addEnabled: true,
            error: '',
        });

        const addPoint = (await runStep(agent.endpoint, workspaceName, step(
            `add-point-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const add = [...(root?.querySelectorAll('button') || [])]
                    .find((button) => button.textContent?.trim() === '新增标注');
                if (!(add instanceof HTMLButtonElement) || add.disabled) return null;
                const rect = add.getBoundingClientRect();
                return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
            `},
        ))).data as {x: number; y: number} | null;
        expect(addPoint).not.toBeNull();
        expect((await runStep(agent.endpoint, workspaceName, step(
            `pick-mode-${Date.now()}`, 'browser.mouse', {
                action: 'click',
                x: addPoint!.x,
                y: addPoint!.y,
            },
        ))).ok).toBe(true);

        const inputPoint = (await runStep(agent.endpoint, workspaceName, step(
            `input-point-${Date.now()}`, 'browser.evaluate', {expression: `
                const input = document.querySelector('#customerName');
                if (!(input instanceof HTMLElement)) return null;
                const rect = input.getBoundingClientRect();
                return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
            `},
        ))).data as {x: number; y: number} | null;
        expect(inputPoint).not.toBeNull();
        expect((await runStep(agent.endpoint, workspaceName, step(
            `page-hit-${Date.now()}`, 'browser.evaluate', {expression: `
                return document.elementFromPoint(${inputPoint!.x}, ${inputPoint!.y})?.id || '';
            `},
        ))).data).toBe('customerName');

        expect((await runStep(agent.endpoint, workspaceName, step(
            `page-click-${Date.now()}`, 'browser.mouse', {
                action: 'click',
                x: inputPoint!.x,
                y: inputPoint!.y,
            },
        ))).ok).toBe(true);

        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `candidate-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return Boolean(root?.querySelector('.annotator-pick-overlay .annotator-pick-confirm'));
            `},
        ))).data, {timeout: 20_000}).toBe(true);

        const confirmPoint = (await runStep(agent.endpoint, workspaceName, step(
            `confirm-point-${Date.now()}`, 'browser.evaluate', {expression: `
                const button = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                    ?.querySelector('.annotator-pick-confirm');
                if (!(button instanceof HTMLButtonElement)) return null;
                const rect = button.getBoundingClientRect();
                return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
            `},
        ))).data as {x: number; y: number} | null;
        expect(confirmPoint).not.toBeNull();
        expect((await runStep(agent.endpoint, workspaceName, step(
            `confirm-${Date.now()}`, 'browser.mouse', {
                action: 'click',
                x: confirmPoint!.x,
                y: confirmPoint!.y,
            },
        ))).ok).toBe(true);

        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `confirmed-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return {
                    pickOpen: Boolean(root?.querySelector('.annotator-pick-overlay')),
                    labels: root?.querySelectorAll('.annotator-label').length || 0,
                };
            `},
        ))).data, {timeout: 20_000}).toEqual({pickOpen: false, labels: expect.any(Number)});

        const buttonPoint = async (label: string): Promise<{x: number; y: number}> => {
            const point = (await runStep(agent.endpoint, workspaceName, step(
                `button-${label}-${Date.now()}`, 'browser.evaluate', {expression: `
                    const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                    const button = [...(root?.querySelectorAll('button') || [])]
                        .find((item) => item.textContent?.trim() === ${JSON.stringify(label)});
                    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
                    const rect = button.getBoundingClientRect();
                    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
                `},
            ))).data as {x: number; y: number} | null;
            expect(point, `${label} should be enabled`).not.toBeNull();
            return point!;
        };

        const checkPoint = await buttonPoint('检查');
        expect((await runStep(agent.endpoint, workspaceName, step(
            `check-${Date.now()}`, 'browser.mouse', {action: 'click', ...checkPoint},
        ))).ok).toBe(true);
        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `checked-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return {
                    mode: root?.querySelector('.annotator-root')?.getAttribute('data-annotator-mode'),
                    error: root?.querySelector('.annotator-flag-error')?.textContent?.trim() || '',
                    statusCount: root?.querySelectorAll('.annotator-status-glyph').length || 0,
                };
            `},
        ))).data, {timeout: 20_000}).toEqual({mode: 'editing', error: '', statusCount: expect.any(Number)});

        const savePoint = await buttonPoint('保存');
        expect((await runStep(agent.endpoint, workspaceName, step(
            `save-${Date.now()}`, 'browser.mouse', {action: 'click', ...savePoint},
        ))).ok).toBe(true);
        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `saved-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return {
                    mode: root?.querySelector('.annotator-root')?.getAttribute('data-annotator-mode'),
                    error: root?.querySelector('.annotator-flag-error')?.textContent?.trim() || '',
                    saved: Boolean(root?.querySelector('.annotator-flag-saved')),
                    profile: root?.querySelector('.annotator-root')?.getAttribute('data-annotator-profile') || '',
                };
            `},
        ))).data, {timeout: 20_000}).toEqual({
            mode: 'editing',
            error: '',
            saved: true,
            profile: expect.stringMatching(/.+/),
        });

        const listedRules = await dispatch(agent.endpoint, action('entity_rules.list', workspaceName));
        expect(listedRules.type).toBe('entity_rules.list.result');
        const savedRules = (listedRules.payload as {entityRules?: Array<{name?: string}>})?.entityRules || [];
        expect(savedRules.some((rule) => typeof rule.name === 'string' && rule.name.length > 0)).toBe(true);

        const exitPoint = await buttonPoint('退出');
        expect((await runStep(agent.endpoint, workspaceName, step(
            `exit-${Date.now()}`, 'browser.mouse', {action: 'click', ...exitPoint},
        ))).ok).toBe(true);
        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `exited-${Date.now()}`, 'browser.evaluate', {expression: `
                const annotator = document.querySelector('#rpa-entity-annotator-host');
                const debug = document.querySelector('#rpa-floating-panel');
                return {
                    annotatorHidden: annotator instanceof HTMLElement && annotator.style.display === 'none',
                    debugPresent: Boolean(debug?.shadowRoot),
                };
            `},
        ))).data, {timeout: 10_000}).toEqual({annotatorHidden: true, debugPresent: true});

        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `reopen-${Date.now()}`, 'browser.evaluate', {expression: clickPanel},
        ))).data, {timeout: 20_000}).toBe(true);
        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `reopened-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return {
                    mode: root?.querySelector('.annotator-root')?.getAttribute('data-annotator-mode'),
                    draft: root?.querySelector('.annotator-root')?.getAttribute('data-annotator-draft'),
                    saved: Boolean(root?.querySelector('.annotator-flag-saved')),
                };
            `},
        ))).data, {timeout: 20_000}).toEqual({mode: 'editing', draft: 'present', saved: true});
    } finally {
        await agent.close();
        await fixture.close();
    }
});

test('renders table columns, repeated row actions and pagination from saved rules', async ({}, testInfo) => {
    testInfo.setTimeout(150_000);
    const mock = await startMockApp('ant');
    const agent = await startAgent();
    const workspaceName = `annotator-table-${Date.now()}`;
    try {
        expect((await dispatch(agent.endpoint, controlAction('workspace.create', {workspaceName}))).type)
            .toBe('workspace.create.result');
        const before = await dispatch(agent.endpoint, action('tab.list', workspaceName));
        const previousNames = new Set(
            (((before.payload as {tabs?: Array<{tabName?: string}>})?.tabs) || [])
                .map((tab) => tab.tabName)
                .filter((name): name is string => Boolean(name)),
        );
        expect((await dispatch(agent.endpoint, action('tab.open', workspaceName))).type)
            .toBe('tab.open.result');
        let tabName = '';
        await expect.poll(async () => {
            const listed = await dispatch(agent.endpoint, action('tab.list', workspaceName));
            const tabs = ((listed.payload as {tabs?: Array<{tabName?: string}>})?.tabs) || [];
            tabName = tabs.find((tab) => tab.tabName && !previousNames.has(tab.tabName))?.tabName || '';
            return tabName;
        }, {timeout: 20_000}).not.toBe('');
        expect((await runStep(agent.endpoint, workspaceName, step(
            `switch-${Date.now()}`, 'browser.switch_tab', {tabName},
        ))).ok).toBe(true);

        const artifact = await loadEntityRuleArtifact('oa-ant-orders');
        expect((await dispatch(agent.endpoint, action(
            'entity_rules.save', workspaceName, {entityRules: artifact},
        ))).type).toBe('entity_rules.save.result');
        expect((await runStep(agent.endpoint, workspaceName, step(
            `goto-${Date.now()}`, 'browser.goto', {url: `${mock.baseUrl}/entity-rules/fixtures/order-list`},
        ))).ok).toBe(true);
        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `table-ready-${Date.now()}`, 'browser.evaluate', {expression: `
                return document.querySelectorAll('table tbody tr').length;
            `},
        ))).data, {timeout: 20_000}).toBeGreaterThan(0);

        const clickPanel = `
            const host = document.querySelector('#rpa-floating-panel');
            const root = host?.shadowRoot;
            if (!root) return false;
            if (!root.querySelector('.panel')?.classList.contains('open')) root.querySelector('.ball')?.click();
            [...root.querySelectorAll('.tabs button')].find((button) => button.textContent?.trim() === 'Flow')?.click();
            const enter = [...root.querySelectorAll('button')]
                .find((button) => button.textContent?.trim() === '进入标注模式');
            if (!(enter instanceof HTMLButtonElement)) return false;
            enter.click();
            return true;
        `;
        expect((await runStep(agent.endpoint, workspaceName, step(
            `open-${Date.now()}`, 'browser.evaluate', {expression: clickPanel},
        ))).data).toBe(true);

        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `labels-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return [...(root?.querySelectorAll('.annotator-label') || [])]
                    .map((label) => label.textContent?.replace(/\\s+/g, ' ').trim() || '');
            `},
        ))).data, {timeout: 20_000}).toEqual(expect.arrayContaining([
            expect.stringContaining('订单编号'),
            expect.stringContaining('采购人'),
            expect.stringContaining('金额'),
            expect.stringContaining('状态'),
            expect.stringContaining('操作'),
            expect.stringContaining('编辑'),
            expect.stringContaining('删除'),
            expect.stringContaining('nextPage'),
        ]));

        const actionSummary = (await runStep(agent.endpoint, workspaceName, step(
            `action-summary-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const labels = [...(root?.querySelectorAll('.annotator-label') || [])]
                    .map((label) => ({
                        id: label.getAttribute('data-annotation-id') || '',
                        text: label.textContent?.replace(/\\s+/g, ' ').trim() || '',
                    }));
                return {
                    edit: labels.filter((label) => label.text.includes('编辑')),
                    remove: labels.filter((label) => label.text.includes('删除')),
                };
            `},
        ))).data as {edit: Array<{id: string; text: string}>; remove: Array<{id: string; text: string}>};
        expect(actionSummary.edit).toHaveLength(1);
        expect(actionSummary.remove).toHaveLength(1);
        expect(actionSummary.edit[0].text).toMatch(/x\d+/);
        expect(actionSummary.remove[0].text).toMatch(/x\d+/);

        const editLabelPoint = (await runStep(agent.endpoint, workspaceName, step(
            `edit-label-point-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const label = [...(root?.querySelectorAll('.annotator-label') || [])]
                    .find((item) => item.textContent?.includes('编辑'));
                if (!(label instanceof HTMLElement)) return null;
                const rect = label.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                return {
                    x,
                    y,
                    hitClass: root?.elementFromPoint?.(x, y)?.getAttribute('class') || '',
                };
            `},
        ))).data as {x: number; y: number; hitClass: string} | null;
        expect(editLabelPoint).not.toBeNull();
        expect(editLabelPoint!.hitClass).toContain('annotator-label');
        expect((await runStep(agent.endpoint, workspaceName, step(
            `select-edit-${Date.now()}`, 'browser.mouse', {action: 'click', ...editLabelPoint!},
        ))).ok).toBe(true);

        const selectedDiagnostic = (await runStep(agent.endpoint, workspaceName, step(
            `selected-diagnostic-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const hit = root?.elementFromPoint?.(${editLabelPoint!.x}, ${editLabelPoint!.y});
                const label = root?.querySelector('[data-annotation-id="${actionSummary.edit[0].id}"]');
                return {
                    hitClass: hit?.getAttribute('class') || '',
                    selected: label?.classList.contains('selected') || false,
                    card: Boolean(root?.querySelector('.annotator-edit-card')),
                };
            `},
        ))).data;
        expect(selectedDiagnostic).toEqual({
            hitClass: expect.stringContaining('annotator-label'),
            selected: true,
            card: true,
        });

        let businessKeyPoint: {x: number; y: number; value: string} | null = null;
        await expect.poll(async () => {
            businessKeyPoint = (await runStep(
                agent.endpoint,
                workspaceName,
                step(`edit-card-${Date.now()}`, 'browser.evaluate', {expression: `
                    const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                    const inputs = root?.querySelectorAll('.annotator-edit-card input');
                    const input = inputs?.[1];
                    if (!(input instanceof HTMLInputElement)) return null;
                    const rect = input.getBoundingClientRect();
                    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, value: input.value};
                `}),
            )).data as {x: number; y: number; value: string} | null;
            return businessKeyPoint;
        }, {timeout: 10_000}).not.toBeNull();
        expect(businessKeyPoint!.value).toBe('edit');
        expect((await runStep(agent.endpoint, workspaceName, step(
            `focus-key-${Date.now()}`, 'browser.mouse', {
                action: 'click',
                x: businessKeyPoint!.x,
                y: businessKeyPoint!.y,
            },
        ))).ok).toBe(true);
        for (const key of ['Control+A', 'E', 'D', 'I', 'T', 'R', 'O', 'W']) {
            expect((await runStep(agent.endpoint, workspaceName, step(
                `key-${key}-${Date.now()}`, 'browser.press_key', {key},
            ))).ok).toBe(true);
        }
        await expect.poll(async () => (await runStep(agent.endpoint, workspaceName, step(
            `edited-label-${Date.now()}`, 'browser.evaluate', {expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const label = root?.querySelector('.annotator-label[data-annotation-id="${actionSummary.edit[0].id}"]');
                const box = root?.querySelector('.annotator-box[data-annotation-id="${actionSummary.edit[0].id}"] rect');
                return {
                    text: label?.textContent?.replace(/\\s+/g, ' ').trim() || '',
                    dash: box?.getAttribute('stroke-dasharray') || '',
                };
            `},
        ))).data, {timeout: 10_000}).toEqual({text: expect.stringContaining('EDITROW'), dash: ''});
    } finally {
        await agent.close();
        await mock.close();
    }
});
