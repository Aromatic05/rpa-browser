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
            }),
            'workspace.create',
        );
        timeline('workspace.created', created);

        const tabA = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({
                type: 'tab.create',
                scope: { workspaceId: created.workspaceId, tabToken: created.tabToken },
                tabToken: created.tabToken,
                payload: { workspaceId: created.workspaceId, startUrl: `${fixtureBaseUrl}/run_steps_fixture_a.html` },
            }),
            'tab.create',
        );
        timeline('tab.created.a', tabA);

        const tabB = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({
                type: 'tab.create',
                scope: { workspaceId: created.workspaceId, tabToken: tabA.tabToken },
                tabToken: tabA.tabToken,
                payload: { workspaceId: created.workspaceId, startUrl: `${fixtureBaseUrl}/run_steps_fixture_b.html` },
            }),
            'tab.create(second)',
        );
        timeline('tab.created.b', tabB);

        const tabList = expectOk<{ workspaceId: string; tabs: Array<{ tabId: string; url: string; active: boolean }> }>(
            await client.sendAction({
                type: 'tab.list',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
                payload: { workspaceId: created.workspaceId },
            }),
            'tab.list(after-create)',
        );
        const listedA = tabList.tabs.find((tab) => tab.tabId === tabA.tabId);
        const listedB = tabList.tabs.find((tab) => tab.tabId === tabB.tabId);
        assert.ok(listedA?.url.includes('/run_steps_fixture_a.html'), `tab A url mismatch: ${listedA?.url}`);
        assert.ok(listedB?.url.includes('/run_steps_fixture_b.html'), `tab B url mismatch: ${listedB?.url}`);

        expectOk(
            await client.sendAction({
                type: 'tab.setActive',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
                payload: { workspaceId: created.workspaceId, tabId: tabA.tabId },
            }),
            'tab.setActive(first)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.start',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
            }),
            'record.start',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
                payload: {
                    id: 'rec-fill-a',
                    name: 'browser.fill',
                    args: {
                        selector: '#input-a',
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
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
                payload: {
                    id: 'rec-select-a',
                    name: 'browser.select_option',
                    args: {
                        selector: '#select-a',
                        values: ['opt-a-2'],
                        timeout: 7000,
                    },
                    meta: { source: 'record', ts: Date.now() + 1 },
                },
            }),
            'record.event(select-a)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
                payload: {
                    id: 'rec-click-a',
                    name: 'browser.click',
                    args: { selector: '#btn-a', timeout: 7000 },
                    meta: { source: 'record', ts: Date.now() },
                },
            }),
            'record.event(click-a)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
                payload: {
                    id: 'rec-scroll-a',
                    name: 'browser.scroll',
                    args: { direction: 'down', amount: 260 },
                    meta: { source: 'record', ts: Date.now() + 2 },
                },
            }),
            'record.event(scroll-a)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
                payload: {
                    id: 'rec-page-info-a',
                    name: 'browser.get_page_info',
                    args: {},
                    meta: { source: 'record', ts: Date.now() + 3 },
                },
            }),
            'record.event(page-info-a)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
                payload: {
                    id: 'rec-switch-b',
                    name: 'browser.switch_tab',
                    args: { tab_id: tabB.tabId },
                    meta: { source: 'record', ts: Date.now() + 4 },
                },
            }),
            'record.event(switch-tab)',
        );
        // Human-like recording invariant:
        // while recording B steps, focus must be on B.
        expectOk(
            await client.sendAction({
                type: 'tab.setActive',
                tabToken: tabB.tabToken,
                scope: {
                    workspaceId: created.workspaceId,
                    tabId: tabB.tabId,
                    tabToken: tabB.tabToken,
                },
                payload: { workspaceId: created.workspaceId, tabId: tabB.tabId },
            }),
            'tab.setActive(second,record-b)',
        );
        timeline('tab.setActive.b(record-phase)', { tabId: tabB.tabId });
        const tabListAfterSwitch = expectOk<{
            workspaceId: string;
            tabs: Array<{ tabId: string; active: boolean; url: string }>;
        }>(
            await client.sendAction({
                type: 'tab.list',
                tabToken: tabB.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabB.tabId, tabToken: tabB.tabToken },
                payload: { workspaceId: created.workspaceId },
            }),
            'tab.list(after-switch-to-b)',
        );
        const activeAfterSwitch = tabListAfterSwitch.tabs.find((tab) => tab.active);
        assert.equal(
            activeAfterSwitch?.tabId,
            tabB.tabId,
            `active tab mismatch after switch: ${activeAfterSwitch?.tabId} vs ${tabB.tabId}`,
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: tabB.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabB.tabId, tabToken: tabB.tabToken },
                payload: {
                    id: 'rec-page-info-b',
                    name: 'browser.get_page_info',
                    args: {},
                    meta: { source: 'record', ts: Date.now() + 5 },
                },
            }),
            'record.event(page-info-b)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: tabB.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabB.tabId, tabToken: tabB.tabToken },
                payload: {
                    id: 'rec-fill-b',
                    name: 'browser.fill',
                    args: {
                        selector: '#input-b',
                        value: 'bravo-b',
                        timeout: 7000,
                    },
                    meta: { source: 'record', ts: Date.now() + 6 },
                },
            }),
            'record.event(fill-b)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: tabB.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabB.tabId, tabToken: tabB.tabToken },
                payload: {
                    id: 'rec-select-b',
                    name: 'browser.select_option',
                    args: {
                        selector: '#select-b',
                        values: ['opt-b-2'],
                        timeout: 7000,
                    },
                    meta: { source: 'record', ts: Date.now() + 7 },
                },
            }),
            'record.event(select-b)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: tabB.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabB.tabId, tabToken: tabB.tabToken },
                payload: {
                    id: 'rec-fill-b-final',
                    name: 'browser.fill',
                    args: { selector: '#input-b', value: 'bravo-b-final', timeout: 7000 },
                    meta: { source: 'record', ts: Date.now() + 8 },
                },
            }),
            'record.event(fill-b-final)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.stop',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
            }),
            'record.stop',
        );

        const recording = expectOk<{ steps: Array<{ name: string }> }>(
            await client.sendAction({
                type: 'record.get',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
            }),
            'record.get',
        );
        assert.equal(recording.steps.length, 10);
        assert.deepEqual(
            recording.steps.map((s) => s.name),
            [
                'browser.fill',
                'browser.select_option',
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
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
                payload: { workspaceId: created.workspaceId, tabId: tabA.tabId },
            }),
            'tab.setActive(before-play)',
        );

        const playStartTs = Date.now();
        timeline('play.start.request', { at: playStartTs });
        const replay = expectOk<{ results: Array<{ ok: boolean }> }>(
            await client.sendAction({
                type: 'play.start',
                tabToken: tabA.tabToken,
                scope: { workspaceId: created.workspaceId, tabId: tabA.tabId, tabToken: tabA.tabToken },
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
        assert.equal(beforeInfo?.tab_id, tabA.tabId);
        const switchedInfo = replay.results.find((item) => item.stepId === 'rec-page-info-b');
        assert.ok(switchedInfo?.ok, 'missing successful page info step after switch');
        const info = switchedInfo?.data as { tab_id?: string } | undefined;
        assert.equal(info?.tab_id, tabB.tabId);
        timeline('assert.b.phase.done', {
            recSwitchB: idxSwitch,
            recPageInfoB: idxInfoB,
            recFillB: idxFillB,
            recSelectB: idxSelectB,
            recFillBFinal: idxFillBFinal,
            pageInfoBTabId: info?.tab_id,
            expectedBTabId: tabB.tabId,
        });
        timeline('scenario.done');
    },
};
