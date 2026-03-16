import assert from 'node:assert/strict';
import type { IntegrationScenario } from '../harness/types';

const nowIso = () => new Date().toISOString();
const timeline = (label: string, extra?: Record<string, unknown>) => {
    const payload = extra ? ` ${JSON.stringify(extra)}` : '';
    // Keep this log always visible in integration output for manual race debugging.
    console.log(`[integration:timeline] ${nowIso()} ${label}${payload}`);
};

const expectOk = <T = any>(result: any, hint: string) => {
    assert.equal(result?.ok, true, `${hint}: ${JSON.stringify(result)}`);
    return (result as { ok: true; data: T }).data;
};

export const multiTabRecordingScenario: IntegrationScenario = {
    name: 'multi-tab-recording-consistency',
    run: async ({ client, fixtureBaseUrl }) => {
        const headed = ['1', 'true', 'yes'].includes((process.env.RPA_INTEGRATION_HEADED || '').toLowerCase());

        timeline('scenario.start', { fixtureBaseUrl, headed });
        const created = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({
                type: 'workspace.create',
                payload: { startUrl: `${fixtureBaseUrl}/run_steps_fixture_a.html` },
            }),
            'workspace.create',
        );
        timeline('workspace.created', created);

        const secondTab = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({
                type: 'tab.create',
                scope: { workspaceId: created.workspaceId, tabToken: created.tabToken },
                tabToken: created.tabToken,
                payload: { workspaceId: created.workspaceId, startUrl: `${fixtureBaseUrl}/run_steps_fixture_b.html` },
            }),
            'tab.create',
        );
        timeline('tab.created.b', secondTab);

        const tabList = expectOk<{ workspaceId: string; tabs: Array<{ tabId: string; url: string; active: boolean }> }>(
            await client.sendAction({
                type: 'tab.list',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
                payload: { workspaceId: created.workspaceId },
            }),
            'tab.list(after-create)',
        );
        const tabA = tabList.tabs.find((tab) => tab.tabId === created.tabId);
        const tabB = tabList.tabs.find((tab) => tab.tabId === secondTab.tabId);
        assert.ok(tabA?.url.includes('/run_steps_fixture_a.html'), `tab A url mismatch: ${tabA?.url}`);
        assert.ok(tabB?.url.includes('/run_steps_fixture_b.html'), `tab B url mismatch: ${tabB?.url}`);

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

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
                payload: {
                    id: 'rec-page-info-a',
                    name: 'browser.get_page_info',
                    args: {},
                    meta: { source: 'record', ts: Date.now() + 2 },
                },
            }),
            'record.event(page-info-a)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: {
                    id: 'rec-switch-b',
                    name: 'browser.switch_tab',
                    args: { tab_id: secondTab.tabId },
                    meta: { source: 'record', ts: Date.now() + 3 },
                },
            }),
            'record.event(switch-tab)',
        );
        // Human-like recording invariant:
        // while recording B steps, focus must be on B.
        expectOk(
            await client.sendAction({
                type: 'tab.setActive',
                tabToken: secondTab.tabToken,
                scope: {
                    workspaceId: created.workspaceId,
                    tabId: secondTab.tabId,
                    tabToken: secondTab.tabToken,
                },
                payload: { workspaceId: created.workspaceId, tabId: secondTab.tabId },
            }),
            'tab.setActive(second,record-b)',
        );
        timeline('tab.setActive.b(record-phase)', { tabId: secondTab.tabId });
        const tabListAfterSwitch = expectOk<{
            workspaceId: string;
            tabs: Array<{ tabId: string; active: boolean; url: string }>;
        }>(
            await client.sendAction({
                type: 'tab.list',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: { workspaceId: created.workspaceId },
            }),
            'tab.list(after-switch-to-b)',
        );
        const activeAfterSwitch = tabListAfterSwitch.tabs.find((tab) => tab.active);
        assert.equal(
            activeAfterSwitch?.tabId,
            secondTab.tabId,
            `active tab mismatch after switch: ${activeAfterSwitch?.tabId} vs ${secondTab.tabId}`,
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: {
                    id: 'rec-page-info-b',
                    name: 'browser.get_page_info',
                    args: {},
                    meta: { source: 'record', ts: Date.now() + 4 },
                },
            }),
            'record.event(page-info-b)',
        );

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
                    meta: { source: 'record', ts: Date.now() + 5 },
                },
            }),
            'record.event(fill-b)',
        );

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
                    meta: { source: 'record', ts: Date.now() + 6 },
                },
            }),
            'record.event(select-b)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: secondTab.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: secondTab.tabId, tabToken: secondTab.tabToken },
                payload: {
                    id: 'rec-fill-b-final',
                    name: 'browser.fill',
                    args: { target: { selector: '#input-b' }, value: 'bravo-b-final', timeout: 7000 },
                    meta: { source: 'record', ts: Date.now() + 7 },
                },
            }),
            'record.event(fill-b-final)',
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
        assert.equal(recording.steps.length, 9);
        assert.deepEqual(
            recording.steps.map((s) => s.name),
            [
                'browser.fill',
                'browser.click',
                'browser.scroll',
                'browser.get_page_info',
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

        const playStartTs = Date.now();
        timeline('play.start.request', { at: playStartTs });
        const replay = expectOk<{ results: Array<{ ok: boolean }> }>(
            await client.sendAction({
                type: 'play.start',
                tabToken: created.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: created.tabId, tabToken: created.tabToken },
                payload: { stopOnError: true },
            }),
            'play.start',
        );
        timeline('play.start.done', { at: Date.now(), elapsedMs: Date.now() - playStartTs });

        assert.ok(
            replay.results.length >= recording.steps.length,
            `replay results should include at least recorded steps: replay=${replay.results.length}, recorded=${recording.steps.length}`,
        );
        assert.ok(replay.results.every((item) => item.ok));
        const replayById = new Map(replay.results.map((item: any, index) => [item.stepId, { ...item, index }]));
        const mustPassB = ['rec-switch-b', 'rec-page-info-b', 'rec-fill-b', 'rec-select-b', 'rec-fill-b-final'];
        for (const id of mustPassB) {
            const item = replayById.get(id);
            assert.ok(item, `missing replay step for B phase: ${id}`);
            assert.equal(item?.ok, true, `B phase step failed: ${id}`);
        }
        const idxSwitch = replayById.get('rec-switch-b')!.index;
        const idxInfoB = replayById.get('rec-page-info-b')!.index;
        const idxFillB = replayById.get('rec-fill-b')!.index;
        const idxSelectB = replayById.get('rec-select-b')!.index;
        const idxFillBFinal = replayById.get('rec-fill-b-final')!.index;
        assert.ok(idxSwitch < idxInfoB, `order violated: switch->page_info_b (${idxSwitch} !< ${idxInfoB})`);
        assert.ok(idxInfoB < idxFillB, `order violated: page_info_b->fill_b (${idxInfoB} !< ${idxFillB})`);
        assert.ok(idxFillB < idxSelectB, `order violated: fill_b->select_b (${idxFillB} !< ${idxSelectB})`);
        assert.ok(
            idxSelectB < idxFillBFinal,
            `order violated: select_b->fill_b_final (${idxSelectB} !< ${idxFillBFinal})`,
        );
        const beforeSwitchInfo = replay.results.find((item) => item.stepId === 'rec-page-info-a');
        assert.ok(beforeSwitchInfo?.ok, 'missing successful page info step before switch');
        const beforeInfo = beforeSwitchInfo?.data as { tab_id?: string } | undefined;
        assert.equal(beforeInfo?.tab_id, created.tabId);
        const switchedInfo = replay.results.find((item) => item.stepId === 'rec-page-info-b');
        assert.ok(switchedInfo?.ok, 'missing successful page info step after switch');
        const info = switchedInfo?.data as { tab_id?: string } | undefined;
        assert.equal(info?.tab_id, secondTab.tabId);
        timeline('assert.b.phase.done', {
            recSwitchB: idxSwitch,
            recPageInfoB: idxInfoB,
            recFillB: idxFillB,
            recSelectB: idxSelectB,
            recFillBFinal: idxFillBFinal,
            pageInfoBTabId: info?.tab_id,
            expectedBTabId: secondTab.tabId,
        });
        timeline('scenario.done');
    },
};
