import { test, expect } from '@playwright/test';
import { startFixtureServer } from '../../helpers/server';
import { startProductAgent } from '../../helpers/agent_product_e2e';
import { openPanelTab, panelEval, waitForPanel } from '../../helpers/agent_e2e_panel';
import { runStep } from '../../helpers/e2e_multitab_helper';
import type { StepUnion } from '../../../src/automation/runner/steps/types';

const st = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args']): Extract<StepUnion, { name: T }> =>
    ({ id, name, args } as unknown as Extract<StepUnion, { name: T }>);

const shortPoll = async (fn: () => Promise<boolean | string>, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    let last: boolean | string = false;
    while (Date.now() < deadline) {
        last = await fn();
        if (last) {return last;}
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return last;
};

const readDomValue = async (endpoint: string, ws: string, selector: string): Promise<string> => {
    const expression = `return document.querySelector(${JSON.stringify(selector)})?.value ?? '';`;
    const result = await runStep(endpoint, ws, st(`read-${selector}`, 'browser.evaluate', {expression}));
    expect(result.ok, JSON.stringify(result.error || {})).toBe(true);
    return result.data as string;
};

for (const mode of ['program', 'react-baseline'] as const) {
    test(`extension panel mode selection: ${mode} executes against the real page and reports completion`, async () => {
        test.setTimeout(180_000);

        const fixture = await startFixtureServer();
        const agent = await startProductAgent();
        try {
            const pageUrl = `${fixture.baseURL}/step_actions/customer_profile.html`;
            const ws = 'default';

            const tabName = await openPanelTab(agent.endpoint, ws, pageUrl);
            expect(tabName).toBeTruthy();
            await waitForPanel(agent.endpoint, ws);

            const prompt = mode === 'program' ? 'program mode task' : 'baseline mode task';
            const seeded = await panelEval(agent.endpoint, ws, 'set-inputs', {
                prompt,
                provider: agent.model.provider,
                model: agent.model.model,
                mode,
            });
            expect(seeded.ok).toBeTruthy();

            const started = await panelEval(agent.endpoint, ws, 'click', {label: 'Start'});
            expect(started.ok).toBeTruthy();

            const completedId = await shortPoll(async () => {
                const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
                return snapshot.sessions?.find((session) => session.state === 'completed' && session.reportAvailable === 'true')?.sessionId ?? '';
            }, 60_000);
            expect(completedId).toBeTruthy();

            const expectedValue = mode === 'program' ? 'ProgramAlice' : 'BaselineBob';
            await shortPoll(async () => {
                const value = await readDomValue(agent.endpoint, ws, '#customerName');
                return value === expectedValue;
            }, 20_000);
            expect(await readDomValue(agent.endpoint, ws, '#customerName')).toBe(expectedValue);

            const opened = await panelEval(agent.endpoint, ws, 'click-session', {sessionId: completedId, label: 'Report'});
            expect(opened.ok, JSON.stringify(opened)).toBeTruthy();
            const reportText = await shortPoll(async () => {
                const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
                return (snapshot.reports ?? []).join('\n');
            }, 15_000) as string;
            expect(reportText).toContain('terminal: completed');
        } finally {
            await agent.close();
            await fixture.close();
        }
    });
}