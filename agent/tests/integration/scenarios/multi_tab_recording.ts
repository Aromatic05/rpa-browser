import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { IntegrationScenario } from '../harness/types';

const expectOk = <T = any>(result: any, hint: string) => {
    assert.equal(result?.ok, true, `${hint}: ${JSON.stringify(result)}`);
    return (result as { ok: true; data: T }).data;
};

export const multiTabRecordingScenario: IntegrationScenario = {
    name: 'multi-tab-recording-consistency',
    run: async ({ client, fixtureBaseUrl }) => {
        const created = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({
                type: 'workspace.create',
                payload: { startUrl: `${fixtureBaseUrl}/run_steps_fixture_a.html` },
            }),
            'workspace.create',
        );

        const secondTab = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({
                type: 'tab.create',
                scope: { workspaceId: created.workspaceId, tabToken: created.tabToken },
                tabToken: created.tabToken,
                payload: { workspaceId: created.workspaceId, startUrl: `${fixtureBaseUrl}/run_steps_fixture_b.html` },
            }),
            'tab.create',
        );

        expectOk(
            await client.sendAction({
                type: 'tab.setActive',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
                payload: { workspaceId: created.workspaceId, tabId: created.tabId },
            }),
            'tab.setActive(first)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.start',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
            }),
            'record.start',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
                payload: {
                    id: crypto.randomUUID(),
                    name: 'browser.click',
                    args: { target: { selector: '#btn-a' } },
                    meta: { source: 'record', ts: Date.now() },
                },
            }),
            'record.event(click-a)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: {
                    id: crypto.randomUUID(),
                    name: 'browser.switch_tab',
                    args: { tab_id: secondTab.tabId },
                    meta: { source: 'record', ts: Date.now() + 1 },
                },
            }),
            'record.event(switch-tab)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: {
                    id: crypto.randomUUID(),
                    name: 'browser.click',
                    args: { target: { selector: '#btn-b' } },
                    meta: { source: 'record', ts: Date.now() + 2 },
                },
            }),
            'record.event(click-b)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.stop',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
            }),
            'record.stop',
        );

        const recording = expectOk<{ steps: Array<{ name: string }> }>(
            await client.sendAction({
                type: 'record.get',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
            }),
            'record.get',
        );
        assert.equal(recording.steps.length, 3);
        assert.deepEqual(
            recording.steps.map((s) => s.name),
            ['browser.click', 'browser.switch_tab', 'browser.click'],
        );

        expectOk(
            await client.sendAction({
                type: 'tab.setActive',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
                payload: { workspaceId: created.workspaceId, tabId: created.tabId },
            }),
            'tab.setActive(before-play)',
        );

        const replay = expectOk<{ results: Array<{ ok: boolean }> }>(
            await client.sendAction({
                type: 'play.start',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
                payload: { stopOnError: true },
            }),
            'play.start',
        );

        assert.ok(
            replay.results.length >= recording.steps.length,
            `replay results should include at least recorded steps: replay=${replay.results.length}, recorded=${recording.steps.length}`,
        );
        assert.ok(replay.results.every((item) => item.ok));
    },
};
