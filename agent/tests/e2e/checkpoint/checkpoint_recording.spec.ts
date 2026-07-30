import {test, expect} from '@playwright/test';
import crypto from 'node:crypto';
import {dispatch, runStep, startAgent} from '../../helpers/e2e_multitab_helper';
import {startFixtureServer} from '../../helpers/server';
import type {Action} from '../../../src/actions/action_protocol';
import type {StepUnion} from '../../../src/runner/steps/types';

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

const evaluate = async <T>(agent: AgentHandle, workspaceName: string, expression: string): Promise<T> => (
    await runStep(
        agent.endpoint,
        workspaceName,
        step(`evaluate-${crypto.randomUUID()}`, 'browser.evaluate', {expression}),
    )
).data as T;

const clickPoint = async (agent: AgentHandle, workspaceName: string, point: Point): Promise<void> => {
    expect((await runStep(
        agent.endpoint,
        workspaceName,
        step(`click-${crypto.randomUUID()}`, 'browser.mouse', {action: 'click', ...point}),
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

test('records and annotates a recovery checkpoint without changing the ordinary recording', async ({}, testInfo) => {
    testInfo.setTimeout(150_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    const workspaceName = `checkpoint-recorder-${Date.now()}`;
    try {
        await createWorkspacePage(agent, workspaceName, `${fixture.baseURL}/checkpoint_recorder.html`);
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
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            return {
                title: root?.querySelector('.checkpoint-recorder header strong')?.textContent || '',
                annotateHidden: root?.querySelector('.annotate-launch')?.hasAttribute('hidden') || false,
            };
        `), {timeout: 15_000}).toEqual({title: '正在录制恢复步骤', annotateHidden: true});

        await clickPoint(agent, workspaceName, await floatingPoint(
            agent,
            workspaceName,
            '.checkpoint-recorder [aria-label="收起恢复步骤面板"]',
        ));
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('.checkpoint-recorder')?.hasAttribute('hidden') || false;
        `)).toBe(true);

        await evaluate(agent, workspaceName, `
            setTimeout(() => location.reload(), 120);
            return true;
        `);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return Number(document.body.dataset.loadCount || '0');
        `), {timeout: 20_000}).toBeGreaterThanOrEqual(2);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            return {
                launcher: root?.querySelector('[data-rpa-checkpoint-action="launch"]')?.textContent || '',
                title: root?.querySelector('.checkpoint-recorder header strong')?.textContent || '',
                annotateHidden: root?.querySelector('.annotate-launch')?.hasAttribute('hidden') || false,
            };
        `), {timeout: 20_000}).toEqual({
            launcher: '录制中',
            title: '正在录制恢复步骤',
            annotateHidden: true,
        });
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return document.querySelector('#rpa-floating-panel')?.shadowRoot
                ?.querySelector('.checkpoint-recorder')?.hasAttribute('hidden') || false;
        `), {timeout: 10_000}).toBe(true);
        const dismissPoint = await pagePoint(agent, workspaceName, '#dismiss-session');
        await clickPoint(agent, workspaceName, dismissPoint);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return getComputedStyle(document.querySelector('#session-alert')).display;
        `)).toBe('none');
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
                subtitle: root?.querySelector('.checkpoint-recorder header small')?.textContent || '',
                internal: /checkpointId|matchRules|resolveId/.test(root?.querySelector('.checkpoint-recorder')?.textContent || ''),
            };
        `), {timeout: 20_000}).toEqual({title: '标注恢复步骤', subtitle: '2 个操作', internal: false});
        expect(await ordinaryRecordingSnapshot(agent, workspaceName)).toBe(ordinaryBefore);

        await evaluate(agent, workspaceName, `
            const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
            const texts = [...(root?.querySelectorAll('.checkpoint-recorder input[type="text"]') || [])];
            const selects = [...(root?.querySelectorAll('.checkpoint-recorder select') || [])];
            const name = texts[0];
            if (name instanceof HTMLInputElement) {
                name.value = '关闭登录失效提示';
                name.dispatchEvent(new Event('input', {bubbles: true}));
            }
            const trigger = selects[0];
            if (trigger instanceof HTMLSelectElement) {
                trigger.value = 'text_visible';
                trigger.dispatchEvent(new Event('change', {bubbles: true}));
            }
            const updatedTexts = [...(root?.querySelectorAll('.checkpoint-recorder input[type="text"]') || [])];
            const value = updatedTexts[1];
            if (value instanceof HTMLInputElement) {
                value.value = '登录已失效';
                value.dispatchEvent(new Event('input', {bubbles: true}));
            }
            const operation = selects[1];
            if (operation instanceof HTMLSelectElement) {
                operation.value = 'click';
                operation.dispatchEvent(new Event('change', {bubbles: true}));
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
        `), {timeout: 20_000}).toBe('恢复步骤已保存');
        expect(await ordinaryRecordingSnapshot(agent, workspaceName)).toBe(ordinaryBefore);

        const listed = await dispatch(agent.endpoint, action('checkpoint.list', workspaceName));
        expect(listed.type).toBe('checkpoint.list.result');
        const checkpoints = (listed.payload as {checkpoints?: Array<{
            checkpointId: string;
            checkpoint: {name?: string; trigger?: {matchRules?: unknown[]}; content?: unknown[]};
        }>}).checkpoints || [];
        expect(checkpoints).toHaveLength(1);
        expect(checkpoints[0].checkpoint.name).toBe('关闭登录失效提示');
        expect(checkpoints[0].checkpoint.trigger?.matchRules).toEqual([
            {textVisible: '登录已失效'},
            {stepName: 'browser.click'},
        ]);
        expect(checkpoints[0].checkpoint.content).toHaveLength(2);

        await evaluate(agent, workspaceName, `
            document.querySelector('#session-alert').style.display = 'flex';
        `);
        const executed = await runStep(
            agent.endpoint,
            workspaceName,
            step('run-recorded-checkpoint', 'browser.checkpoint', {checkpointId: checkpoints[0].checkpointId}),
        );
        expect(executed.ok, JSON.stringify(executed.error || {})).toBe(true);
        await expect.poll(async () => await evaluate(agent, workspaceName, `
            return getComputedStyle(document.querySelector('#session-alert')).display;
        `)).toBe('none');
    } finally {
        await agent.close();
        await fixture.close();
    }
});
