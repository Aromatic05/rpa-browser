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

        const ws1 = expectOk<{ workspaceName: string; tabId: string; tabName: string }>(
            await client.sendAction({ type: 'workspace.create' }),
            'workspace.create(ws1)',
        );
        timeline('ws1.created', ws1);

        const ws1TabA = expectOk<{ workspaceName: string; tabId: string; tabName: string }>(
            await client.sendAction({
                type: 'tab.create',
                tabName: ws1.tabName,
                scope: { workspaceName: ws1.workspaceName, tabId: ws1.tabId, tabName: ws1.tabName },
                payload: { workspaceName: ws1.workspaceName, startUrl: `${fixtureBaseUrl}/run_steps_fixture_a.html` },
            }),
            'tab.create(ws1.a)',
        );
        const ws1TabB = expectOk<{ workspaceName: string; tabId: string; tabName: string }>(
            await client.sendAction({
                type: 'tab.create',
                tabName: ws1TabA.tabName,
                scope: { workspaceName: ws1.workspaceName, tabId: ws1TabA.tabId, tabName: ws1TabA.tabName },
                payload: { workspaceName: ws1.workspaceName, startUrl: `${fixtureBaseUrl}/run_steps_fixture_b.html` },
            }),
            'tab.create(ws1.b)',
        );
        timeline('ws1.tabs.created', { ws1TabA, ws1TabB });

        expectOk(
            await client.sendAction({
                type: 'tab.close',
                tabName: ws1TabA.tabName,
                scope: { workspaceName: ws1.workspaceName, tabId: ws1TabA.tabId, tabName: ws1TabA.tabName },
                payload: { workspaceName: ws1.workspaceName, tabId: ws1.tabId },
            }),
            'tab.close(ws1.initial)',
        );

        expectOk(
            await client.sendAction({
                type: 'tab.setActive',
                tabName: ws1TabB.tabName,
                scope: { workspaceName: ws1.workspaceName, tabId: ws1TabB.tabId, tabName: ws1TabB.tabName },
                payload: { workspaceName: ws1.workspaceName, tabId: ws1TabB.tabId },
            }),
            'tab.setActive(ws1.b)',
        );

        expectOk(
            await client.sendAction({
                type: 'record.start',
                tabName: ws1TabA.tabName,
                scope: { workspaceName: ws1.workspaceName, tabId: ws1TabA.tabId, tabName: ws1TabA.tabName },
            }),
            'record.start(ws1)',
        );
        expectOk(
            await client.sendAction({
                type: 'record.event',
                tabName: ws1TabA.tabName,
                scope: { workspaceName: ws1.workspaceName, tabId: ws1TabA.tabId, tabName: ws1TabA.tabName },
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
                tabName: ws1TabA.tabName,
                scope: { workspaceName: ws1.workspaceName, tabId: ws1TabA.tabId, tabName: ws1TabA.tabName },
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
                tabName: ws1TabB.tabName,
                scope: { workspaceName: ws1.workspaceName, tabId: ws1TabB.tabId, tabName: ws1TabB.tabName },
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
                tabName: ws1TabA.tabName,
                scope: { workspaceName: ws1.workspaceName, tabId: ws1TabA.tabId, tabName: ws1TabA.tabName },
            }),
            'record.stop(ws1)',
        );

        const ws1Saved = expectOk<{ workspaceName: string; tabCount: number; stepCount: number; saved: boolean }>(
            await client.sendAction({
                type: 'workspace.save',
                tabName: ws1TabA.tabName,
                scope: { workspaceName: ws1.workspaceName, tabId: ws1TabA.tabId, tabName: ws1TabA.tabName },
                payload: { workspaceName: ws1.workspaceName },
            }),
            'workspace.save(ws1)',
        );
        assert.ok(ws1Saved.saved, 'workspace.save did not report saved=true');
        assert.ok(ws1Saved.tabCount >= 2, `workspace.save expected >=2 tabs, got ${ws1Saved.tabCount}`);
        assert.ok(ws1Saved.stepCount >= 3, `workspace.save expected >=3 steps, got ${ws1Saved.stepCount}`);
        timeline('ws1.saved', ws1Saved);

        const ws2 = expectOk<{ workspaceName: string; tabId: string; tabName: string }>(
            await client.sendAction({ type: 'workspace.create' }),
            'workspace.create(ws2)',
        );
        const ws2TabA = expectOk<{ workspaceName: string; tabId: string; tabName: string }>(
            await client.sendAction({
                type: 'tab.create',
                tabName: ws2.tabName,
                scope: { workspaceName: ws2.workspaceName, tabId: ws2.tabId, tabName: ws2.tabName },
                payload: { workspaceName: ws2.workspaceName, startUrl: `${fixtureBaseUrl}/choices.html` },
            }),
            'tab.create(ws2.a)',
        );
        timeline('ws2.created', { ws2, ws2TabA });

        expectOk(
            await client.sendAction({
                type: 'workspace.setActive',
                tabName: ws2TabA.tabName,
                scope: { workspaceName: ws2.workspaceName, tabId: ws2TabA.tabId, tabName: ws2TabA.tabName },
                payload: { workspaceName: ws1.workspaceName },
            }),
            'workspace.setActive(ws1)',
        );
        expectOk(
            await client.sendAction({
                type: 'workspace.setActive',
                scope: { workspaceName: ws2.workspaceName },
                payload: { workspaceName: ws2.workspaceName },
            }),
            'workspace.setActive(ws2)',
        );

        const restored = expectOk<{
            restored: boolean;
            sourceWorkspaceName: string;
            workspaceName: string;
            tabId: string;
            tabName: string;
            tabCount: number;
            stepCount: number;
        }>(
            await client.sendAction({
                type: 'workspace.restore',
                tabName: ws2TabA.tabName,
                scope: { workspaceName: ws2.workspaceName, tabId: ws2TabA.tabId, tabName: ws2TabA.tabName },
                payload: { workspaceName: ws1.workspaceName },
            }),
            'workspace.restore(ws1->new)',
        );
        assert.ok(restored.restored, 'workspace.restore did not report restored=true');
        assert.equal(restored.sourceWorkspaceName, ws1.workspaceName);
        assert.notEqual(restored.workspaceName, ws1.workspaceName);
        assert.notEqual(restored.workspaceName, ws2.workspaceName);
        assert.ok(restored.tabCount >= ws1Saved.tabCount, `restored.tabCount mismatch: ${restored.tabCount}`);
        assert.ok(restored.stepCount >= ws1Saved.stepCount, `restored.stepCount mismatch: ${restored.stepCount}`);
        timeline('workspace.restored', restored);

        const restoredTabs = expectOk<{
            workspaceName: string;
            tabs: Array<{ tabId: string; url: string; active: boolean }>;
        }>(
            await client.sendAction({
                type: 'tab.list',
                tabName: restored.tabName,
                scope: { workspaceName: restored.workspaceName, tabId: restored.tabId, tabName: restored.tabName },
                payload: { workspaceName: restored.workspaceName },
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
                scope: { workspaceName: restored.workspaceName, tabId: restoredTabA!.tabId },
                payload: { workspaceName: restored.workspaceName, tabId: restoredTabA!.tabId },
            }),
            'tab.setActive(restored.a)',
        );
        expectOk(
            await client.sendAction({
                type: 'tab.setActive',
                scope: { workspaceName: restored.workspaceName, tabId: restoredTabB!.tabId },
                payload: { workspaceName: restored.workspaceName, tabId: restoredTabB!.tabId },
            }),
            'tab.setActive(restored.b)',
        );
        expectOk(
            await client.sendAction({
                type: 'workspace.setActive',
                scope: { workspaceName: ws2.workspaceName },
                payload: { workspaceName: ws2.workspaceName },
            }),
            'workspace.setActive(ws2,again)',
        );
        expectOk(
            await client.sendAction({
                type: 'workspace.setActive',
                scope: { workspaceName: restored.workspaceName },
                payload: { workspaceName: restored.workspaceName },
            }),
            'workspace.setActive(restored,again)',
        );

        const restoredRecording = expectOk<{ steps: Array<{ id: string; name: string }> }>(
            await client.sendAction({
                type: 'record.get',
                tabName: restored.tabName,
                scope: { workspaceName: restored.workspaceName, tabId: restored.tabId, tabName: restored.tabName },
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

        const workspaces = expectOk<{ workspaces: Array<{ workspaceName: string }>; activeWorkspaceName: string | null }>(
            await client.sendAction({
                type: 'workspace.list',
                scope: { workspaceName: restored.workspaceName },
            }),
            'workspace.list(final)',
        );
        const ids = new Set(workspaces.workspaces.map((item) => item.workspaceName));
        assert.ok(ids.has(ws1.workspaceName), 'workspace.list missing ws1');
        assert.ok(ids.has(ws2.workspaceName), 'workspace.list missing ws2');
        assert.ok(ids.has(restored.workspaceName), 'workspace.list missing restored workspace');
        assert.equal(workspaces.activeWorkspaceName, restored.workspaceName);

        timeline('scenario.workspace-restore.done', {
            ws1: ws1.workspaceName,
            ws2: ws2.workspaceName,
            restored: restored.workspaceName,
            workspaceCount: workspaces.workspaces.length,
        });
    },
};
