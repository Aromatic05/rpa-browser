import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingState, getWorkspaceUnsavedToken } from '../../src/record/recording';
import { replayRecording } from '../../src/record/replay';
import { createWorkflowOnFs } from '../../src/workflow';
import { createWorkspaceHarness } from '../helpers/workspace_harness';
import { loadRunnerConfig } from '../../src/config/loader';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import type { StepUnion } from '../../src/runner/steps/types';

const createMockPage = (url: string) => ({
    url: () => url,
    on: () => {},
    mainFrame: () => ({ url: () => url }),
    frames: () => [],
    exposeBinding: async () => {},
    addInitScript: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => {},
    goto: async () => {},
    isClosed: () => false,
    close: async () => {},
}) as any;

const createReplayRuntime = () => ({
    ensureExecutableTab: async () => ({ page: { url: () => 'about:blank' }, tabName: 'runtime-catos' }),
});

const createReplayWorkspace = (tabs: Array<{ name: string; url: string }>) => ({
    tabs: {
        listTabs: () => tabs.map((item) => ({ ...item })),
        hasTab: (tabName: string) => tabs.some((item) => item.name === tabName),
        getTab: (tabName: string) => tabs.find((item) => item.name === tabName) || null,
    },
}) as any;

test('new tab first navigation records and replays as explicit goto before click', async () => {
    const recordingState = createRecordingState();
    const { registry } = createWorkspaceHarness({ recordingState });
    const workspaceName = `ws-new-tab-first-navigation-${Date.now()}`;
    const ws = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    ws.tabs.createTab({ tabName: 'tab-old', page: createMockPage('https://old'), url: 'https://old' });
    ws.tabs.setActiveTab('tab-old');
    await ws.record.handle({ action: { v: 1, id: 'start', type: 'record.start', workspaceName } as any, workspace: ws as any, workspaceRegistry: registry as any });

    await ws.router.handle({ v: 1, id: 'open', type: 'tab.opened', workspaceName, payload: { tabName: 'tab-new', url: 'about:blank', source: 'cdp' } } as any, ws as any, registry as any);
    ws.tabs.bindPage('tab-new', createMockPage('https://catos.info/'));
    ws.tabs.setActiveTab('tab-new');

    const baseTs = Date.now();
    await ws.record.handle({
        action: { v: 1, id: 'click', type: 'record.event', workspaceName, payload: { tabName: 'tab-new', ts: baseTs + 10, type: 'click', selector: '#intro' } } as any,
        workspace: ws as any,
        workspaceRegistry: registry as any,
    });
    await ws.record.handle({
        action: { v: 1, id: 'docs-goto', type: 'record.event', workspaceName, payload: { tabName: 'tab-new', ts: baseTs + 2000, type: 'navigate', url: 'https://catos.info/docs/intro' } } as any,
        workspace: ws as any,
        workspaceRegistry: registry as any,
    });

    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.deepEqual(steps.map((step) => step.name), ['browser.create_tab', 'browser.switch_tab', 'browser.goto', 'browser.click', 'browser.goto']);
    assert.equal(Object.hasOwn(steps[0].args as Record<string, unknown>, 'url'), false);
    assert.equal((steps[2].args as { url?: string }).url, 'https://catos.info/');
    assert.equal((steps[4].args as { url?: string }).url, 'https://catos.info/docs/intro');
    assert.equal(steps.findIndex((step) => step.name === 'browser.goto' && (step.args as { url?: string }).url === 'https://catos.info/') < steps.findIndex((step) => step.name === 'browser.click'), true);

    const runtimeTabs = [{ name: 'runtime-old', url: 'https://old' }];
    const replayEvents: string[] = [];
    const replay = await replayRecording({
        workspaceName: 'ws-replay',
        initialTabName: 'runtime-old',
        steps,
        recordingManifest: {
            recordingToken: 'recorded',
            initialTabs: [{ tabName: 'tab-old', tabRef: 'tab-old', url: 'https://old', title: 'old', active: true }],
            startedAt: Date.now(),
            tabs: [],
        } as any,
        stopOnError: true,
        workspace: createReplayWorkspace(runtimeTabs),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.create_tab': async (step: StepUnion) => {
                assert.deepEqual(step.args, { tabName: 'tab-new' });
                replayEvents.push('create:about:blank');
                runtimeTabs.push({ name: 'runtime-catos', url: 'about:blank' });
                return { stepId: step.id, ok: true, data: { tab_id: 'runtime-catos' } };
            },
            'browser.switch_tab': async (step: StepUnion) => (replayEvents.push(`switch:${(step.args as any).tabName}`), { stepId: step.id, ok: true }),
            'browser.goto': async (step: StepUnion) => {
                const url = (step.args as { url: string }).url;
                const tab = runtimeTabs.find((item) => item.name === 'runtime-catos');
                assert.ok(tab);
                tab.url = url;
                replayEvents.push(`goto:${url}`);
                return { stepId: step.id, ok: true };
            },
            'browser.click': async (step: StepUnion) => {
                assert.equal(runtimeTabs.find((item) => item.name === 'runtime-catos')?.url, 'https://catos.info/');
                replayEvents.push(`click:${(step.args as any).selector}`);
                return { stepId: step.id, ok: true };
            },
        }) as any } as any } as RunStepsDeps,
    });

    assert.equal(replay.ok, true);
    assert.deepEqual(replayEvents, [
        'create:about:blank',
        'switch:runtime-catos',
        'goto:https://catos.info/',
        'click:#intro',
        'goto:https://catos.info/docs/intro',
    ]);
});
