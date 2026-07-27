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
    } finally {
        await agent.close();
        await fixture.close();
    }
});
