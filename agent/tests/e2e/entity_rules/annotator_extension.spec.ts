import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { dispatch, runStep, startAgent } from '../../helpers/e2e_multitab_helper';
import { startFixtureServer } from '../../helpers/server';
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
