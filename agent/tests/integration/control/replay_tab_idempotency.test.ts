import test from 'node:test';
import assert from 'node:assert/strict';
import type { StepUnion } from '../../../src/runner/steps/types';
import { replayRecording } from '../../../src/record/replay';
import { createWorkspaceTabs } from '../../../src/runtime/workspace/tabs';

type FakePage = {
    url: () => string;
    isClosed: () => boolean;
    close: () => Promise<void>;
    on: () => void;
    context: () => unknown;
};

const makePage = (url: string): FakePage => ({
    url: () => url,
    isClosed: () => false,
    close: async () => undefined,
    on: () => undefined,
    context: () => ({}),
});

const step = <T extends StepUnion['name']>(id: string, name: T, args: Extract<StepUnion, { name: T }>['args'], meta?: StepUnion['meta']): Extract<StepUnion, { name: T }> => ({
    id,
    name,
    args,
    meta,
});

const createHarness = () => {
    const tabs = createWorkspaceTabs({
        awaitPageBinding: async () => makePage('about:blank') as any,
        createPageBinding: async (_tabName, input) => makePage(input?.startUrl || 'about:blank') as any,
    });

    tabs.createTab({ tabName: 'tab-main' });
    tabs.setActiveTab('tab-main');

    const createdByExecutor: string[] = [];
    const switchedTabs: string[] = [];
    const closedTabs: string[] = [];
    let seq = 0;

    const workspace: any = {
        name: 'ws-test',
        tabs,
    };

    const runtime: any = {
        createExecutableTab: async ({ tabName, startUrl }: { tabName: string; startUrl?: string }) => {
            if (!tabs.hasTab(tabName)) {
                tabs.createTab({ tabName });
            }
            tabs.updateTab(tabName, { url: startUrl || 'about:blank' });
            return { workspaceName: workspace.name, tabName, page: makePage(startUrl || 'about:blank') };
        },
    };

    const deps: any = {
        runtime: {},
        pageRegistry: {},
        config: {},
        pluginHost: {
            getExecutors: () => ({
                'browser.create_tab': async (s: Extract<StepUnion, { name: 'browser.create_tab' }>) => {
                    const runtimeTabName = `rt-${++seq}`;
                    tabs.createTab({ tabName: runtimeTabName });
                    createdByExecutor.push(runtimeTabName);
                    return { stepId: s.id, ok: true, data: { tabName: runtimeTabName } };
                },
                'browser.switch_tab': async (s: Extract<StepUnion, { name: 'browser.switch_tab' }>) => {
                    switchedTabs.push(s.args.tabName);
                    tabs.setActiveTab(s.args.tabName);
                    return { stepId: s.id, ok: true };
                },
                'browser.close_tab': async (s: Extract<StepUnion, { name: 'browser.close_tab' }>) => {
                    closedTabs.push(s.args.tabName);
                    await tabs.closeTab(s.args.tabName);
                    return { stepId: s.id, ok: true };
                },
                'browser.click': async (s: Extract<StepUnion, { name: 'browser.click' }>) => {
                    if (s.args.selector === '#popup') {
                        tabs.createTab({ tabName: 'popup-runtime' });
                    }
                    if (s.args.selector === '#close-side') {
                        await tabs.closeTab('popup-runtime');
                    }
                    return { stepId: s.id, ok: true };
                },
                'browser.goto': async (s: Extract<StepUnion, { name: 'browser.goto' }>) => ({ stepId: s.id, ok: true, data: s.args.url }),
            }),
        },
    };

    return { workspace, runtime, deps, tabs, createdByExecutor, switchedTabs, closedTabs };
};

test('replay initializes full initialTabs mapping and does not rely on activeTabRef only', async () => {
    const h = createHarness();
    h.tabs.createTab({ tabName: 'tab-a' });

    const steps: StepUnion[] = [
        step('s1', 'browser.switch_tab', { tabName: 'recorded-a' }),
        step('s2', 'browser.switch_tab', { tabName: 'recorded-b' }),
    ];

    const result = await replayRecording({
        workspaceName: h.workspace.name,
        initialTabName: 'tab-main',
        steps,
        stopOnError: true,
        workspace: h.workspace,
        runtime: h.runtime,
        pageRegistry: {} as any,
        deps: h.deps,
        recordingManifest: {
            recordingToken: 'r1',
            initialTabs: [
                { tabName: 'recorded-a', tabRef: 'tab-a', url: 'https://a.test', title: '', active: false },
                { tabName: 'recorded-b', tabRef: 'tab-b', url: 'https://b.test', title: '', active: true },
            ],
            activeTabRef: 'tab-b',
            startedAt: Date.now(),
            tabs: [],
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(h.switchedTabs, ['tab-a', 'tab-b']);
    assert.equal(h.tabs.hasTab('tab-b'), true);
});

test('create_tab consumes pendingCreated effect before active create and overrides old binding', async () => {
    const h = createHarness();
    h.tabs.createTab({ tabName: 'tab-a' });

    const steps: StepUnion[] = [
        step('c1', 'browser.click', { selector: '#popup' }),
        step('c2', 'browser.create_tab', { tabName: 'popup-recorded' }),
        step('c3', 'browser.switch_tab', { tabName: 'popup-recorded' }),
        step('c4', 'browser.create_tab', { tabName: 'popup-recorded' }),
        step('c5', 'browser.switch_tab', { tabName: 'popup-recorded' }),
    ];

    const result = await replayRecording({
        workspaceName: h.workspace.name,
        initialTabName: 'tab-main',
        steps,
        stopOnError: true,
        workspace: h.workspace,
        runtime: h.runtime,
        pageRegistry: {} as any,
        deps: h.deps,
        recordingManifest: {
            recordingToken: 'r2',
            initialTabs: [{ tabName: 'tab-main-recorded', tabRef: 'tab-main', url: '', title: '', active: true }],
            activeTabRef: 'tab-main',
            startedAt: Date.now(),
            tabs: [],
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(h.switchedTabs, ['popup-runtime', 'rt-1']);
    assert.deepEqual(h.createdByExecutor, ['rt-1']);
});

test('switch_tab fails when binding missing or closed, close_tab validates pendingClosed effect', async () => {
    const h1 = createHarness();
    const missingSwitch = await replayRecording({
        workspaceName: h1.workspace.name,
        initialTabName: 'tab-main',
        steps: [step('x1', 'browser.switch_tab', { tabName: 'missing-recorded' })],
        stopOnError: true,
        workspace: h1.workspace,
        runtime: h1.runtime,
        pageRegistry: {} as any,
        deps: h1.deps,
        recordingManifest: { recordingToken: 'm1', initialTabs: [], startedAt: Date.now(), tabs: [] },
    });
    assert.equal(missingSwitch.ok, false);
    assert.equal(missingSwitch.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');

    const h2 = createHarness();
    h2.tabs.createTab({ tabName: 'tab-a' });
    h2.tabs.createTab({ tabName: 'popup-runtime' });
    const mismatchClose = await replayRecording({
        workspaceName: h2.workspace.name,
        initialTabName: 'tab-main',
        steps: [
            step('y1', 'browser.click', { selector: '#close-side' }),
            step('y2', 'browser.close_tab', { tabName: 'recorded-a' }),
        ],
        stopOnError: true,
        workspace: h2.workspace,
        runtime: h2.runtime,
        pageRegistry: {} as any,
        deps: h2.deps,
        recordingManifest: {
            recordingToken: 'm2',
            initialTabs: [{ tabName: 'recorded-a', tabRef: 'tab-a', url: '', title: '', active: true }],
            activeTabRef: 'tab-a',
            startedAt: Date.now(),
            tabs: [],
        },
    });
    assert.equal(mismatchClose.ok, false);
    assert.equal(mismatchClose.error?.code, 'ERR_REPLAY_TAB_EFFECT_MISMATCH');

    const h3 = createHarness();
    h3.tabs.createTab({ tabName: 'popup-runtime' });
    const okClose = await replayRecording({
        workspaceName: h3.workspace.name,
        initialTabName: 'tab-main',
        steps: [
            step('z1', 'browser.click', { selector: '#close-side' }),
            step('z2', 'browser.close_tab', { tabName: 'recorded-popup' }),
            step('z3', 'browser.close_tab', { tabName: 'recorded-popup' }),
        ],
        stopOnError: true,
        workspace: h3.workspace,
        runtime: h3.runtime,
        pageRegistry: {} as any,
        deps: h3.deps,
        recordingManifest: {
            recordingToken: 'm3',
            initialTabs: [{ tabName: 'recorded-popup', tabRef: 'popup-runtime', url: '', title: '', active: true }],
            activeTabRef: 'popup-runtime',
            startedAt: Date.now(),
            tabs: [],
        },
    });
    assert.equal(okClose.ok, true);

    const h4 = createHarness();
    h4.tabs.createTab({ tabName: 'tab-a' });
    const closedSwitch = await replayRecording({
        workspaceName: h4.workspace.name,
        initialTabName: 'tab-main',
        steps: [
            step('w1', 'browser.close_tab', { tabName: 'recorded-a' }),
            step('w2', 'browser.switch_tab', { tabName: 'recorded-a' }),
        ],
        stopOnError: true,
        workspace: h4.workspace,
        runtime: h4.runtime,
        pageRegistry: {} as any,
        deps: h4.deps,
        recordingManifest: {
            recordingToken: 'm4',
            initialTabs: [{ tabName: 'recorded-a', tabRef: 'tab-a', url: '', title: '', active: true }],
            activeTabRef: 'tab-a',
            startedAt: Date.now(),
            tabs: [],
        },
    });
    assert.equal(closedSwitch.ok, false);
    assert.equal(closedSwitch.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');
});
