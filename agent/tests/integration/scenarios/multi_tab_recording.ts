import assert from 'node:assert/strict';
import type { IntegrationScenario } from '../harness/types';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
        await sleep(300);

        expectOk(
            await client.sendAction({
                type: 'record.start',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
            }),
            'record.start',
        );
        await sleep(200);

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
                payload: {
                    id: 'rec-fill-a',
                    name: 'browser.fill',
                    args: {
                        target: { selector: '#input-a' },
                        value: 'alpha-a',
                        timeout: 7000,
                    },
                    meta: { source: 'record', ts: Date.now() },
                },
            }),
            'record.event(fill-a)',
        );
        await sleep(180);

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
                payload: {
                    id: 'rec-click-a',
                    name: 'browser.click',
                    args: { target: { selector: '#btn-a' }, timeout: 7000 },
                    meta: { source: 'record', ts: Date.now() },
                },
            }),
            'record.event(click-a)',
        );
        await sleep(180);

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
                payload: {
                    id: 'rec-scroll-a',
                    name: 'browser.scroll',
                    args: { direction: 'down', amount: 260 },
                    meta: { source: 'record', ts: Date.now() + 1 },
                },
            }),
            'record.event(scroll-a)',
        );
        await sleep(220);

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: {
                    id: 'rec-switch-b',
                    name: 'browser.switch_tab',
                    args: { tab_id: secondTab.tabId },
                    meta: { source: 'record', ts: Date.now() + 2 },
                },
            }),
            'record.event(switch-tab)',
        );
        await sleep(280);

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: {
                    id: 'rec-page-info-b',
                    name: 'browser.get_page_info',
                    args: {},
                    meta: { source: 'record', ts: Date.now() + 3 },
                },
            }),
            'record.event(page-info-b)',
        );
        await sleep(120);

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: {
                    id: 'rec-fill-b',
                    name: 'browser.fill',
                    args: {
                        target: { selector: '#input-b' },
                        value: 'bravo-b',
                        timeout: 7000,
                    },
                    meta: { source: 'record', ts: Date.now() + 4 },
                },
            }),
            'record.event(fill-b)',
        );
        await sleep(180);

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: {
                    id: 'rec-select-b',
                    name: 'browser.select_option',
                    args: {
                        target: { selector: '#select-b' },
                        values: ['opt-b-2'],
                        timeout: 7000,
                    },
                    meta: { source: 'record', ts: Date.now() + 5 },
                },
            }),
            'record.event(select-b)',
        );
        await sleep(180);

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: {
                    id: 'rec-fill-b-final',
                    name: 'browser.fill',
                    args: { target: { selector: '#input-b' }, value: 'bravo-b-final', timeout: 7000 },
                    meta: { source: 'record', ts: Date.now() + 6 },
                },
            }),
            'record.event(fill-b-final)',
        );
        await sleep(220);

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
        assert.equal(recording.steps.length, 8);
        assert.deepEqual(
            recording.steps.map((s) => s.name),
            [
                'browser.fill',
                'browser.click',
                'browser.scroll',
                'browser.switch_tab',
                'browser.get_page_info',
                'browser.fill',
                'browser.select_option',
                'browser.fill',
            ],
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
        await sleep(300);

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
        const switchedInfo = replay.results.find((item) => item.stepId === 'rec-page-info-b');
        assert.ok(switchedInfo?.ok, 'missing successful page info step after switch');
        const info = switchedInfo?.data as { tab_id?: string } | undefined;
        assert.equal(info?.tab_id, secondTab.tabId);
    },
};
