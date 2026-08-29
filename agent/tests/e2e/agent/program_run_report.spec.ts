import { test, expect } from '@playwright/test';
import { startAgentWithFauxModel } from '../../helpers/agent_e2e_runtime';
import { startFixtureServer } from '../../helpers/server';
import { runStep } from '../../helpers/e2e_multitab_helper';
import { openPanelTab, panelEval, waitForPanel } from '../../helpers/agent_e2e_panel';
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

test('agent program task runs through the real floating UI to a durable report', async () => {
    test.setTimeout(180_000);

    const fixture = await startFixtureServer();
    const agent = await startAgentWithFauxModel({firstTurnDelayMs: 1200});
    try {
        const pageUrl = `${fixture.baseURL}/agent/agent_task.html`;
        const ws = 'default';

        const tabName = await openPanelTab(agent.endpoint, ws, pageUrl);
        expect(tabName).toBeTruthy();
        await waitForPanel(agent.endpoint, ws);

        const seeded = await panelEval(agent.endpoint, ws, 'set-inputs', {
            prompt: 'produce a deterministic output program',
            provider: agent.model.provider,
            model: agent.model.model,
            mode: 'program',
        });
        expect(seeded.ok).toBeTruthy();

        const started = await panelEval(agent.endpoint, ws, 'click', {label: 'Start'});
        expect(started.ok).toBeTruthy();

        // The task stays visibly running before it settles.
        const observedRunning = await shortPoll(async () => {
            const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
            return snapshot.sessions?.some((session) => session.state === 'running') || false;
        }, 30_000);
        expect(observedRunning).toBe(true);

        // The same task then settles as completed with a durable report.
        const completedId = await shortPoll(async () => {
            const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
            return snapshot.sessions?.find((session) => session.state === 'completed' && session.reportAvailable === 'true')?.sessionId ?? '';
        }, 60_000);
        expect(completedId).toBeTruthy();

        // The deterministic faux model executed exactly one program.
        expect(agent.faux.toolCallCount()).toBe(1);

        // Inspect the report through the panel report surface.
        const opened = await panelEval(agent.endpoint, ws, 'click-session', {sessionId: completedId, label: 'Report'});
        expect(opened.ok, JSON.stringify(opened)).toBeTruthy();
        const reportText = await shortPoll(async () => {
            const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
            return (snapshot.reports ?? []).join('\n');
        }, 15_000) as string;
        expect(reportText).toContain('terminal: completed');
        expect(reportText).toContain('program 0');
        expect(reportText).not.toContain('sk-');

        // Reopen the UI (new page reload), then recover the durable report again.
        const navigated = await runStep(agent.endpoint, ws, st('agent-reopen', 'browser.goto', {url: pageUrl}));
        expect(navigated.ok).toBeTruthy();
        await waitForPanel(agent.endpoint, ws);

        const remount = await panelEval(agent.endpoint, ws, 'panel', {});
        expect(remount.panelCount).toBe(1);

        const revivedId = await shortPoll(async () => {
            const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
            return snapshot.sessions?.find((session) => session.state === 'completed' && session.reportAvailable === 'true')?.sessionId ?? '';
        }, 30_000);
        expect(revivedId).toBe(completedId);

        const reopened = await panelEval(agent.endpoint, ws, 'click-session', {sessionId: revivedId, label: 'Report'});
        expect(reopened.ok, JSON.stringify(reopened)).toBeTruthy();
        const revivedReport = await shortPoll(async () => {
            const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
            return (snapshot.reports ?? []).join('\n');
        }, 15_000) as string;
        expect(revivedReport).toContain('terminal: completed');
        expect(revivedReport).toContain('program 0');

        // Repeated refreshes keep the settled session intact and single-paneled.
        for (let index = 0; index < 3; index += 1) {
            const refreshed = await panelEval(agent.endpoint, ws, 'click', {label: 'Refresh'});
            expect(refreshed.ok).toBeTruthy();
            await shortPoll(async () => {
                const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
                return snapshot.sessions?.some((session) => session.sessionId === revivedId) ?? false;
            }, 10_000);
        }
        const finalSnapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
        expect(finalSnapshot.panelCount).toBe(1);
        expect(finalSnapshot.sessions?.some((session) => session.sessionId === revivedId)).toBe(true);
    } finally {
        await agent.close();
        await fixture.close();
    }
});