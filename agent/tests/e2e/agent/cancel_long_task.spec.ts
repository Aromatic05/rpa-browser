import { test, expect } from '@playwright/test';
import { startAgentWithFauxModel } from '../../helpers/agent_e2e_runtime';
import { startFixtureServer } from '../../helpers/server';
import { openPanelTab, panelEval, waitForPanel } from '../../helpers/agent_e2e_panel';

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

test('a long task started from the UI can be cancelled and stays cancelled', async () => {
    test.setTimeout(180_000);

    const fixture = await startFixtureServer();
    const agent = await startAgentWithFauxModel({firstTurnDelayMs: 1500});
    try {
        const pageUrl = `${fixture.baseURL}/agent/agent_task.html`;
        const ws = 'default';

        const tabName = await openPanelTab(agent.endpoint, ws, pageUrl);
        expect(tabName).toBeTruthy();
        await waitForPanel(agent.endpoint, ws);

        const seeded = await panelEval(agent.endpoint, ws, 'set-inputs', {
            prompt: 'long-running drain task',
            provider: agent.model.provider,
            model: agent.model.model,
            mode: 'react-baseline',
        });
        expect(seeded.ok).toBeTruthy();

        const started = await panelEval(agent.endpoint, ws, 'click', {label: 'Start'});
        expect(started.ok).toBeTruthy();

        const runningId = await shortPoll(async () => {
            const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
            return snapshot.sessions?.find((session) => session.state === 'running')?.sessionId ?? '';
        }, 30_000);
        expect(runningId).toBeTruthy();
        expect(agent.faux.requestCount()).toBeGreaterThanOrEqual(1);

        // The faux model is now holding the long turn open.
        const cachedRequests = agent.faux.requestCount();

        const cancelled = await panelEval(agent.endpoint, ws, 'click-session', {sessionId: runningId, label: 'Cancel'});
        expect(cancelled.ok, JSON.stringify(cancelled)).toBeTruthy();

        const settledId = await shortPoll(async () => {
            const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
            if (snapshot.sessions?.some((session) => session.state === 'running')) {return '';}
            return snapshot.sessions?.find((session) => session.state === 'cancelled')?.sessionId ?? '';
        }, 30_000);
        expect(settledId).toBe(runningId);

        // The cancelled session never reverts to running on later refreshes.
        for (let index = 0; index < 3; index += 1) {
            await panelEval(agent.endpoint, ws, 'click', {label: 'Refresh'});
            await new Promise((resolve) => setTimeout(resolve, 400));
            const snapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
            expect(snapshot.sessions?.some((session) => session.state === 'running') ?? false).toBe(false);
            const cancelledItem = snapshot.sessions?.find((session) => session.sessionId === runningId);
            expect(cancelledItem?.state).toBe('cancelled');
        }

        // No further model turns started after the cancellation; the hold is terminal.
        const finalRequests = agent.faux.requestCount();
        expect(finalRequests).toBe(cachedRequests);

        // The panel stays single-paneled throughout, including the post-cancel poll window.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const finalSnapshot = await panelEval(agent.endpoint, ws, 'snapshot', {});
        expect(finalSnapshot.panelCount).toBe(1);
        expect(finalSnapshot.sessions?.some((session) => session.state === 'running') ?? false).toBe(false);
    } finally {
        await agent.close();
        await fixture.close();
    }
});