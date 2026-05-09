import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabEffectRegisterForTest, recordClosedTabEffectForTest, recordCreatedTabEffectForTest, replayRecording } from '../../src/record/replay';
import type { StepUnion } from '../../src/runner/steps/types';
import { loadRunnerConfig } from '../../src/config/loader';
import type { RunStepsDeps } from '../../src/runner/run_steps';

const createReplayRuntime = () => ({
    ensureExecutableTab: async () => ({ page: { url: () => 'about:blank' }, tabName: 'x' }),
});

const createReplayWorkspace = (tabs: Array<{ name: string; url: string }>) => ({
    tabs: {
        listTabs: () => tabs.map((item) => ({ ...item })),
        hasTab: (tabName: string) => tabs.some((item) => item.name === tabName),
        getTab: (tabName: string) => tabs.find((item) => item.name === tabName) || null,
    },
}) as any;

test('replayRecording creates and switches tab when recorded tabName is missing (cold replay)', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 's1',
            name: 'browser.click',
            args: { selector: '#a' },
            meta: { source: 'record', tabName: 'tab-a', workspaceName: 'old-ws' },
        },
        {
            id: 's-switch',
            name: 'browser.switch_tab',
            args: { tabName: 'tab-b' },
            meta: { source: 'record', tabName: 'tab-b', tabRef: 'tab-b', workspaceName: 'old-ws' },
        },
        {
            id: 's2',
            name: 'browser.click',
            args: { selector: '#b' },
            meta: { source: 'record', tabName: 'tab-b', workspaceName: 'old-ws' },
        },
    ];

    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps,
        enrichments: {
            s1: {
                version: 1,
                eventType: 'click',
                resolveHint: { raw: { selector: '#a' } },
                resolvePolicy: { preferDirect: true },
            },
            s2: {
                version: 1,
                eventType: 'click',
                resolveHint: { raw: { selector: '#b' } },
                resolvePolicy: { preferDirect: true },
            },
        },
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () =>
                    ({
                        'browser.click': async (step: StepUnion) => {
                            assert.equal(step.resolve?.hint?.raw?.selector === '#a' || step.resolve?.hint?.raw?.selector === '#b', true);
                            assert.equal(step.resolve?.policy?.preferDirect, true);
                            executed.push(step);
                            return { stepId: step.id, ok: true };
                        },
                        'browser.create_tab': async (step: StepUnion) => {
                            executed.push(step);
                            return { stepId: step.id, ok: true, data: { tab_id: 'tab-new-1' } };
                        },
                        'browser.switch_tab': async (step: StepUnion) => {
                            executed.push(step);
                            return { stepId: step.id, ok: true };
                        },
                    }) as any,
            } as any,
        } as RunStepsDeps,
    });

    assert.equal(result.ok, true);
    assert.equal(executed[0].name, 'browser.create_tab');
    assert.equal(executed.some((step) => step.name === 'browser.switch_tab'), true);
    assert.equal(executed.some((step) => step.name === 'browser.create_tab'), true);
    assert.equal(executed[executed.length - 1].name, 'browser.click');
});

test('replayRecording force switches when tabName changes without browser.switch_tab', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 's1',
            name: 'browser.click',
            args: { selector: '#a' },
            meta: { source: 'record', tabName: 'tab-a', workspaceName: 'old-ws' },
        },
        {
            id: 's2',
            name: 'browser.click',
            args: { selector: '#b' },
            meta: { source: 'record', tabName: 'tab-b', workspaceName: 'old-ws' },
        },
    ];

    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps,
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () =>
                    ({
                        'browser.click': async (step: StepUnion) => {
                            executed.push(step);
                            return { stepId: step.id, ok: true };
                        },
                        'browser.create_tab': async (step: StepUnion) => {
                            executed.push(step);
                            return { stepId: 'create', ok: true, data: { tab_id: 'tab-new-1' } };
                        },
                        'browser.switch_tab': async (step: StepUnion) => {
                            executed.push(step);
                            return { stepId: 'switch', ok: true };
                        },
                    }) as any,
            } as any,
        } as RunStepsDeps,
    });

    assert.equal(result.ok, true);
    assert.equal(executed.some((step) => step.name === 'browser.create_tab'), true);
    assert.equal(executed.some((step) => step.name === 'browser.switch_tab'), false);
});

test('replayRecording reuses existing tab by token mapping in hot replay', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 'h1',
            name: 'browser.click',
            args: { selector: '#from-a' },
            meta: { source: 'record', tabName: 'tab-a', workspaceName: 'ws-now' },
        },
        {
            id: 'h-switch',
            name: 'browser.switch_tab',
            args: { tabName: 'legacy-tab-b' },
            meta: { source: 'record', tabName: 'tab-b', workspaceName: 'ws-now', tabRef: 'tab-b' },
        },
        {
            id: 'h2',
            name: 'browser.click',
            args: { selector: '#from-b' },
            meta: { source: 'record', tabName: 'tab-b', workspaceName: 'ws-now' },
        },
    ];

    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-a',
        steps,
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-a', url: 'about:blank' }, { name: 'tab-b', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () =>
                    ({
                        'browser.click': async (step: StepUnion) => {
                            executed.push(step);
                            return { stepId: step.id, ok: true };
                        },
                        'browser.create_tab': async (step: StepUnion) => {
                            executed.push(step);
                            return { stepId: step.id, ok: true, data: { tab_id: 'unexpected' } };
                        },
                        'browser.switch_tab': async (step: StepUnion) => {
                            executed.push(step);
                            return { stepId: step.id, ok: true };
                        },
                    }) as any,
            } as any,
        } as RunStepsDeps,
    });

    assert.equal(result.ok, true);
    assert.equal(executed.some((step) => step.name === 'browser.create_tab'), false);
    const switched = executed.find((step) => step.id === 'h-switch');
    assert.equal((switched?.args as any)?.tabName, 'tab-b');
});

test('replayRecording creates tab with recorded switch url when target tab is missing', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 's-switch-missing',
            name: 'browser.switch_tab',
            args: { tabName: 'legacy-tab-b', tabUrl: 'https://example.com/target' },
            meta: { source: 'record', tabName: 'tab-b', tabRef: 'tab-b', workspaceName: 'old-ws' },
        },
    ];

    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps,
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () =>
                    ({
                        'browser.create_tab': async (step: StepUnion) => {
                            executed.push(step);
                            return { stepId: step.id, ok: true, data: { tab_id: 'tab-created' } };
                        },
                        'browser.switch_tab': async (step: StepUnion) => {
                            executed.push(step);
                            return { stepId: step.id, ok: true };
                        },
                    }) as any,
            } as any,
        } as RunStepsDeps,
    });

    assert.equal(result.ok, true);
    assert.equal(executed[0].name, 'browser.create_tab');
    assert.equal((executed[0].args as any).url, 'https://example.com/target');
    assert.equal(executed[1].name, 'browser.switch_tab');
    assert.equal((executed[1].args as any).tabName, 'tab-created');
});

test('replayRecording does not inject resolve from empty enhancement', async () => {
    const steps: StepUnion[] = [{ id: 'x1', name: 'browser.click', args: { selector: '#x' }, meta: { source: 'record', tabName: 'tab-now' } }];
    const seen: Array<StepUnion> = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps,
        enrichments: { x1: { version: 1, eventType: 'click', resolveHint: {} as any } },
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: { getExecutors: () => ({ 'browser.click': async (step: StepUnion) => { seen.push(step); return { stepId: step.id, ok: true }; } }) as any } as any,
        } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(Boolean(seen[0].resolve), false);
});

test('replay interval pacing sleeps for short step', async () => {
    const events: any[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'p1', name: 'browser.scroll', args: { direction: 'down', amount: 1 }, meta: { source: 'record', tabName: 'tab-now' } },
        ] as any,
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        replayOptions: { clickDelayMs: 0, stepIntervalMs: 60, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () =>
                    ({
                        'browser.scroll': async (step: StepUnion) => ({ stepId: step.id, ok: true }),
                    }) as any,
            } as any,
        } as RunStepsDeps,
        onEvent: (event) => {
            if (event.type === 'step.finished') {events.push(event);}
        },
    });
    assert.equal(result.ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].stepIntervalMs, 60);
    assert.equal(events[0].sleepMs > 0, true);
});

test('replay interval pacing does not sleep for long step and ignores stepDelayMs', async () => {
    const events: any[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'p2', name: 'browser.scroll', args: { direction: 'down', amount: 1 }, meta: { source: 'record', tabName: 'tab-now' } },
        ] as any,
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        replayOptions: { clickDelayMs: 0, stepIntervalMs: 20, stepDelayMs: 9999, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } } as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () =>
                    ({
                        'browser.scroll': async (step: StepUnion) => {
                            await new Promise((resolve) => setTimeout(resolve, 40));
                            return { stepId: step.id, ok: true };
                        },
                    }) as any,
            } as any,
        } as RunStepsDeps,
        onEvent: (event) => {
            if (event.type === 'step.finished') {events.push(event);}
        },
    });
    assert.equal(result.ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].stepDurationMs >= 30, true);
    assert.equal(events[0].stepIntervalMs, 20);
    assert.equal(events[0].sleepMs, 0);
});

test('replay interval pacing counts highlight time in stepDuration without extra interval add-on', async () => {
    const events: any[] = [];
    const startedAt = Date.now();
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'p3', name: 'browser.click', args: { selector: '#x' }, meta: { source: 'record', tabName: 'tab-now' } },
        ] as any,
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        replayOptions: { clickDelayMs: 0, stepIntervalMs: 900, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () =>
                    ({
                        'browser.click': async (step: StepUnion) => {
                            await new Promise((resolve) => setTimeout(resolve, 250));
                            return { stepId: step.id, ok: true };
                        },
                    }) as any,
            } as any,
        } as RunStepsDeps,
        onEvent: (event) => {
            if (event.type === 'step.finished') {events.push(event);}
        },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.ok, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].stepDurationMs >= 250, true);
    assert.equal(events[0].sleepMs <= 700 && events[0].sleepMs >= 600, true);
    assert.equal(elapsedMs < 1100, true);
});

test('saved replay forwards stepResolves into runStepList resolveId injection', async () => {
    const steps: StepUnion[] = [{ id: 'x2', name: 'browser.click', args: { resolveId: 'rid-1' }, meta: { source: 'record', tabName: 'tab-now' } } as any];
    let resolvedSelector = '';
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps,
        stepResolves: { 'rid-1': { hint: { raw: { selector: '#from-resolve-file' } } } },
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () => ({
                    'browser.click': async (step: StepUnion) => {
                        resolvedSelector = step.resolve?.hint?.raw?.selector || '';
                        return { stepId: step.id, ok: true };
                    },
                }) as any,
            } as any,
        } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(resolvedSelector, '#from-resolve-file');
});

test('replayRecording initializes bindings from manifest initialTabs', async () => {
    const executed: StepUnion[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [{ id: 'sw-1', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'recorded-active', tabRef: 'recorded-active-ref' } } as any],
        recordingManifest: {
            recordingToken: 't-1',
            workspaceName: 'old-ws',
            entryTabRef: 'recorded-active-ref',
            activeTabRef: 'recorded-active-ref',
            initialTabs: [{ tabName: 'recorded-active', tabRef: 'recorded-active-ref', url: 'about:blank', title: 'x', active: true }],
            startedAt: Date.now(),
            tabs: [],
        },
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () => ({ 'browser.switch_tab': async (step: StepUnion) => (executed.push(step), { stepId: step.id, ok: true }) }) as any,
            } as any,
        } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal((executed[0].args as any).tabName, 'tab-now');
});

test('replayRecording keeps entryTabRef and activeTabRef binding usable for normal step', async () => {
    const executed: StepUnion[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [{ id: 'click-1', name: 'browser.click', args: { selector: '#a' }, meta: { source: 'record', tabName: 'recorded-entry', tabRef: 'recorded-entry-ref' } } as any],
        recordingManifest: {
            recordingToken: 't-2',
            workspaceName: 'old-ws',
            entryTabRef: 'recorded-entry-ref',
            activeTabRef: 'recorded-entry-ref',
            initialTabs: [{ tabName: 'recorded-entry', tabRef: 'recorded-entry-ref', url: 'about:blank', title: 'x', active: false }],
            startedAt: Date.now(),
            tabs: [],
        },
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () => ({
                    'browser.click': async (step: StepUnion) => (executed.push(step), { stepId: step.id, ok: true }),
                    'browser.create_tab': async () => ({ stepId: 'unexpected-create', ok: true, data: { tab_id: 'x' } }),
                }) as any,
            } as any,
        } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(executed.length, 1);
});

test('tab effect register accepts single created effect as ready', () => {
    const register = createTabEffectRegisterForTest();
    recordCreatedTabEffectForTest(register, 'tab-1');
    assert.equal(register.pendingCreatedTab.state, 'ready');
});

test('tab effect register marks created effect as conflict when second arrives', () => {
    const register = createTabEffectRegisterForTest();
    recordCreatedTabEffectForTest(register, 'tab-1');
    recordCreatedTabEffectForTest(register, 'tab-2');
    assert.equal(register.pendingCreatedTab.state, 'conflict');
});

test('tab effect register accepts single closed effect as ready', () => {
    const register = createTabEffectRegisterForTest();
    recordClosedTabEffectForTest(register, 'tab-1');
    assert.equal(register.pendingClosedTab.state, 'ready');
});

test('tab effect register marks closed effect as conflict when second arrives', () => {
    const register = createTabEffectRegisterForTest();
    recordClosedTabEffectForTest(register, 'tab-1');
    recordClosedTabEffectForTest(register, 'tab-2');
    assert.equal(register.pendingClosedTab.state, 'conflict');
});
