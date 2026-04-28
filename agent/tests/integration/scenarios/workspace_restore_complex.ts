import assert from 'node:assert/strict';
import type { IntegrationScenario } from '../harness/types';

const nowIso = () => new Date().toISOString();
const timeline = (label: string, extra?: Record<string, unknown>) => {
    const payload = extra ? ` ${JSON.stringify(extra)}` : '';
    console.log(`[integration:timeline] ${nowIso()} ${label}${payload}`);
};

const expectOk = <T = any>(result: any, hint: string) => {
    assert.equal(result?.ok, true, `${hint}: ${JSON.stringify(result)}`);
    return (result as { ok: true; data: T }).data;
};

const assertIncludesUrl = (tabs: Array<{ url: string }>, fragment: string, hint: string) => {
    assert.ok(tabs.some((tab) => tab.url.includes(fragment)), `${hint}: missing ${fragment}`);
};

export const workspaceRestoreComplexScenario: IntegrationScenario = {
    name: 'workspace-restore-complex',
    run: async ({ client, fixtureBaseUrl }) => {
        timeline('scenario.workspace-restore.start', { fixtureBaseUrl });

        const ws1 = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({ type: 'workspace.create' }),
            'workspace.create(ws1)',
        );
        timeline('ws1.created', ws1);

        const ws1TabA = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({
                type: 'tab.create',
                tabToken: ws1.tabToken,
                scope: { workspaceId: ws1.workspaceId, tabId: ws1.tabId, tabToken: ws1.tabToken },
                payload: { workspaceId: ws1.workspaceId, startUrl: `${fixtureBaseUrl}/run_steps_fixture_a.html` },
            }),
            'tab.create(ws1.a)',
        );
        const ws1TabB = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({
                type: 'tab.create',
                tabToken: ws1TabA.tabToken,
                scope: { workspaceId: ws1.workspaceId, tabId: ws1TabA.tabId, tabToken: ws1TabA.tabToken },
                payload: { workspaceId: ws1.workspaceId, startUrl: `${fixtureBaseUrl}/run_steps_fixture_b.html` },
            }),
            'tab.create(ws1.b)',
        );
        timeline('ws1.tabs.created', { ws1TabA, ws1TabB });

        expectOk(
            await client.sendAction({
                type: 'tab.close',
                tabToken: ws1TabA.tabToken,
                scope: { workspaceId: ws1.workspaceId, tabId: ws1TabA.tabId, tabToken: ws1TabA.tabToken },
                payload: { workspaceId: ws1.workspaceId, tabId: ws1.tabId },
            }),
            'tab.close(ws1.initial)',
        );

        expectOk(
            await client.sendAction({
                type: 'tab.setActive',
                tabToken: ws1TabB.tabToken,
                scope: { workspaceId: ws1.workspaceId, tabId: ws1TabB.tabId, tabToken: ws1TabB.tabToken },
                payload: { workspaceId: ws1.workspaceId, tabId: ws1TabB.tabId },
            }),
            'tab.setActive(ws1.b)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.start',
                tabToken: ws1TabA.tabToken,
                scope: { workspaceId: ws1.workspaceId, tabId: ws1TabA.tabId, tabToken: ws1TabA.tabToken },
            }),
            'record.start(ws1)',
        );
        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: ws1TabA.tabToken,
                scope: { workspaceId: ws1.workspaceId, tabId: ws1TabA.tabId, tabToken: ws1TabA.tabToken },
                payload: {
                    id: 'ws1-rec-a-fill',
                    name: 'browser.fill',
                    args: { selector: '#input-a', value: 'ws1-a', timeout: 7000 },
                    meta: { source: 'record', ts: Date.now() },
                },
            }),
            'record.event(ws1.a.fill)',
        );
        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: ws1TabA.tabToken,
                scope: { workspaceId: ws1.workspaceId, tabId: ws1TabA.tabId, tabToken: ws1TabA.tabToken },
                payload: {
                    id: 'ws1-rec-switch-b',
                    name: 'browser.switch_tab',
                    args: { tabId: ws1TabB.tabId },
                    meta: { source: 'record', ts: Date.now() + 1 },
                },
            }),
            'record.event(ws1.switch.b)',
        );
        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabToken: ws1TabB.tabToken,
                scope: { workspaceId: ws1.workspaceId, tabId: ws1TabB.tabId, tabToken: ws1TabB.tabToken },
                payload: {
                    id: 'ws1-rec-b-fill',
                    name: 'browser.fill',
                    args: { selector: '#input-b', value: 'ws1-b', timeout: 7000 },
                    meta: { source: 'record', ts: Date.now() + 2 },
                },
            }),
            'record.event(ws1.b.fill)',
        );
        expectOk(
            await client.sendAction({
                type: 'record.stop',
                tabToken: ws1TabA.tabToken,
                scope: { workspaceId: ws1.workspaceId, tabId: ws1TabA.tabId, tabToken: ws1TabA.tabToken },
            }),
            'record.stop(ws1)',
        );

        const ws1Saved = expectOk<{ workspaceId: string; tabCount: number; stepCount: number; saved: boolean }>(
            await client.sendAction({
                type: 'workspace.save',
                tabToken: ws1TabA.tabToken,
                scope: { workspaceId: ws1.workspaceId, tabId: ws1TabA.tabId, tabToken: ws1TabA.tabToken },
                payload: { workspaceId: ws1.workspaceId },
            }),
            'workspace.save(ws1)',
        );
        assert.ok(ws1Saved.saved, 'workspace.save did not report saved=true');
        assert.ok(ws1Saved.tabCount >= 2, `workspace.save expected >=2 tabs, got ${ws1Saved.tabCount}`);
        assert.ok(ws1Saved.stepCount >= 3, `workspace.save expected >=3 steps, got ${ws1Saved.stepCount}`);
        timeline('ws1.saved', ws1Saved);

        const ws2 = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({ type: 'workspace.create' }),
            'workspace.create(ws2)',
        );
        const ws2TabA = expectOk<{ workspaceId: string; tabId: string; tabToken: string }>(
            await client.sendAction({
                type: 'tab.create',
                tabToken: ws2.tabToken,
                scope: { workspaceId: ws2.workspaceId, tabId: ws2.tabId, tabToken: ws2.tabToken },
                payload: { workspaceId: ws2.workspaceId, startUrl: `${fixtureBaseUrl}/choices.html` },
            }),
            'tab.create(ws2.a)',
        );
        timeline('ws2.created', { ws2, ws2TabA });

        expectOk(
            await client.sendAction({
                type: 'workspace.setActive',
                tabToken: ws2TabA.tabToken,
                scope: { workspaceId: ws2.workspaceId, tabId: ws2TabA.tabId, tabToken: ws2TabA.tabToken },
                payload: { workspaceId: ws1.workspaceId },
            }),
            'workspace.setActive(ws1)',
        );
        expectOk(
            await client.sendAction({
                type: 'workspace.setActive',
                scope: { workspaceId: ws2.workspaceId },
                payload: { workspaceId: ws2.workspaceId },
            }),
            'workspace.setActive(ws2)',
        );

        const restored = expectOk<{
            restored: boolean;
            sourceWorkspaceId: string;
            workspaceId: string;
            tabId: string;
            tabToken: string;
            tabCount: number;
            stepCount: number;
        }>(
            await client.sendAction({
                type: 'workspace.restore',
                tabToken: ws2TabA.tabToken,
                scope: { workspaceId: ws2.workspaceId, tabId: ws2TabA.tabId, tabToken: ws2TabA.tabToken },
                payload: { workspaceId: ws1.workspaceId },
            }),
            'workspace.restore(ws1->new)',
        );
        assert.ok(restored.restored, 'workspace.restore did not report restored=true');
        assert.equal(restored.sourceWorkspaceId, ws1.workspaceId);
        assert.notEqual(restored.workspaceId, ws1.workspaceId);
        assert.notEqual(restored.workspaceId, ws2.workspaceId);
        assert.ok(restored.tabCount >= ws1Saved.tabCount, `restored.tabCount mismatch: ${restored.tabCount}`);
        assert.ok(restored.stepCount >= ws1Saved.stepCount, `restored.stepCount mismatch: ${restored.stepCount}`);
        timeline('workspace.restored', restored);

        const restoredTabs = expectOk<{
            workspaceId: string;
            tabs: Array<{ tabId: string; url: string; active: boolean }>;
        }>(
            await client.sendAction({
                type: 'tab.list',
                tabToken: restored.tabToken,
                scope: { workspaceId: restored.workspaceId, tabId: restored.tabId, tabToken: restored.tabToken },
                payload: { workspaceId: restored.workspaceId },
            }),
            'tab.list(restored)',
        );
        assertIncludesUrl(restoredTabs.tabs, '/run_steps_fixture_a.html', 'restored tabs');
        assertIncludesUrl(restoredTabs.tabs, '/run_steps_fixture_b.html', 'restored tabs');
        const restoredTabA = restoredTabs.tabs.find((tab) => tab.url.includes('/run_steps_fixture_a.html'));
        const restoredTabB = restoredTabs.tabs.find((tab) => tab.url.includes('/run_steps_fixture_b.html'));
        assert.ok(restoredTabA?.tabId, 'restored tab A not found');
        assert.ok(restoredTabB?.tabId, 'restored tab B not found');

        expectOk(
            await client.sendAction({
                type: 'tab.setActive',
                scope: { workspaceId: restored.workspaceId, tabId: restoredTabA!.tabId },
                payload: { workspaceId: restored.workspaceId, tabId: restoredTabA!.tabId },
            }),
            'tab.setActive(restored.a)',
        );
        expectOk(
            await client.sendAction({
                type: 'tab.setActive',
                scope: { workspaceId: restored.workspaceId, tabId: restoredTabB!.tabId },
                payload: { workspaceId: restored.workspaceId, tabId: restoredTabB!.tabId },
            }),
            'tab.setActive(restored.b)',
        );
        expectOk(
            await client.sendAction({
                type: 'workspace.setActive',
                scope: { workspaceId: ws2.workspaceId },
                payload: { workspaceId: ws2.workspaceId },
            }),
            'workspace.setActive(ws2,again)',
        );
        expectOk(
            await client.sendAction({
                type: 'workspace.setActive',
                scope: { workspaceId: restored.workspaceId },
                payload: { workspaceId: restored.workspaceId },
            }),
            'workspace.setActive(restored,again)',
        );

        const restoredRecording = expectOk<{ steps: Array<{ id: string; name: string }> }>(
            await client.sendAction({
                type: 'record.get',
                tabToken: restored.tabToken,
                scope: { workspaceId: restored.workspaceId, tabId: restored.tabId, tabToken: restored.tabToken },
            }),
            'record.get(restored)',
        );
        assert.ok(
            restoredRecording.steps.some((step) => step.id === 'ws1-rec-a-fill' && step.name === 'browser.fill'),
            'restored recording missing ws1-rec-a-fill',
        );
        assert.ok(
            restoredRecording.steps.some((step) => step.id === 'ws1-rec-switch-b' && step.name === 'browser.switch_tab'),
            'restored recording missing ws1-rec-switch-b',
        );
        assert.ok(
            restoredRecording.steps.some((step) => step.id === 'ws1-rec-b-fill' && step.name === 'browser.fill'),
            'restored recording missing ws1-rec-b-fill',
        );

        const workspaces = expectOk<{ workspaces: Array<{ workspaceId: string }>; activeWorkspaceId: string | null }>(
            await client.sendAction({
                type: 'workspace.list',
                scope: { workspaceId: restored.workspaceId },
            }),
            'workspace.list(final)',
        );
        const ids = new Set(workspaces.workspaces.map((item) => item.workspaceId));
        assert.ok(ids.has(ws1.workspaceId), 'workspace.list missing ws1');
        assert.ok(ids.has(ws2.workspaceId), 'workspace.list missing ws2');
        assert.ok(ids.has(restored.workspaceId), 'workspace.list missing restored workspace');
        assert.equal(workspaces.activeWorkspaceId, restored.workspaceId);

        timeline('scenario.workspace-restore.done', {
            ws1: ws1.workspaceId,
            ws2: ws2.workspaceId,
            restored: restored.workspaceId,
            workspaceCount: workspaces.workspaces.length,
        });
    },
};
