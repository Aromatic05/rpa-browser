import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTabEffectsFromDiffForTest, createTabEffectRegisterForTest, recordClosedTabEffectForTest, recordCreatedTabEffectForTest, replayRecording } from '../../src/record/replay';
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

test('replayRecording fails normal step when target tab is not bound in cold replay', async () => {
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

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');
    assert.equal(executed.some((step) => step.name === 'browser.create_tab'), false);
    assert.equal(executed.some((step) => step.id === 's1'), false);
});

test('replayRecording does not auto create when tabName changes without browser.switch_tab', async () => {
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

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');
    assert.equal(executed.some((step) => step.name === 'browser.create_tab'), false);
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

test('replayRecording does not create tab for missing switch target', async () => {
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

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');
    assert.equal(executed.some((step) => step.name === 'browser.create_tab'), false);
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

test('normal step created tab diff writes pendingCreatedTab', () => {
    const register = createTabEffectRegisterForTest();
    collectTabEffectsFromDiffForTest(register, new Set(['tab-a']), new Set(['tab-a', 'tab-b']), 'browser.click');
    assert.equal(register.pendingCreatedTab.state, 'ready');
});

test('browser.create_tab step created tab diff does not write pendingCreatedTab', () => {
    const register = createTabEffectRegisterForTest();
    collectTabEffectsFromDiffForTest(register, new Set(['tab-a']), new Set(['tab-a', 'tab-b']), 'browser.create_tab');
    assert.equal(register.pendingCreatedTab.state, 'empty');
});

test('normal step closed tab diff writes pendingClosedTab', () => {
    const register = createTabEffectRegisterForTest();
    collectTabEffectsFromDiffForTest(register, new Set(['tab-a', 'tab-b']), new Set(['tab-a']), 'browser.click');
    assert.equal(register.pendingClosedTab.state, 'ready');
});

test('browser.close_tab step closed tab diff does not write pendingClosedTab', () => {
    const register = createTabEffectRegisterForTest();
    collectTabEffectsFromDiffForTest(register, new Set(['tab-a', 'tab-b']), new Set(['tab-a']), 'browser.close_tab');
    assert.equal(register.pendingClosedTab.state, 'empty');
});

test('create_tab is no-op when recorded tab is already bound and exists', async () => {
    const executed: string[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [{ id: 'c1', name: 'browser.create_tab', args: { url: 'https://x' }, meta: { source: 'record', tabName: 'tab-a', tabRef: 'tab-a-ref' } } as any],
        recordingManifest: {
            recordingToken: 't-3',
            workspaceName: 'old-ws',
            initialTabs: [{ tabName: 'tab-a', tabRef: 'tab-a-ref', url: 'https://x', title: 'x', active: true }],
            startedAt: Date.now(),
            tabs: [],
        } as any,
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'https://x' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({ 'browser.create_tab': async () => (executed.push('create'), { stepId: 'x', ok: true, data: { tab_id: 'new' } }) }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(executed.length, 0);
});

test('create_tab consumes pending created effect and binds without executing create', async () => {
    const executed: string[] = [];
    const tabs = [{ name: 'tab-now', url: 'about:blank' }];
    const workspace = createReplayWorkspace(tabs);
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 's1', name: 'browser.click', args: {}, meta: { source: 'record', tabName: 'tab-now' } } as any,
            { id: 'c2', name: 'browser.create_tab', args: { url: 'https://x' }, meta: { source: 'record', tabName: 'tab-b', tabRef: 'tab-b-ref' } } as any,
            { id: 'sw2', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'tab-b', tabRef: 'tab-b-ref' } } as any,
        ],
        stopOnError: true,
        workspace,
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.click': async () => (tabs.push({ name: 'tab-runtime-b', url: 'https://x' }), { stepId: 's1', ok: true }),
            'browser.create_tab': async () => (executed.push('create'), { stepId: 'c2', ok: true, data: { tab_id: 'new' } }),
            'browser.switch_tab': async (step: StepUnion) => ({ stepId: step.id, ok: true, data: step.args }),
        }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(executed.length, 0);
});

test('create_tab binds existing runtime tab when pendingCreatedTab is empty', async () => {
    const executed: string[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [{ id: 'c-existing', name: 'browser.create_tab', args: { url: 'https://matched/x#hash' }, meta: { source: 'record', tabName: 'recorded-new', tabRef: 'recorded-new-ref', urlAtRecord: 'https://matched/x' } } as any],
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }, { name: 'runtime-tab-new', url: 'https://matched/x#z' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.create_tab': async () => (executed.push('create'), { stepId: 'c-existing', ok: true, data: { tab_id: 'should-not-run' } }),
            'browser.switch_tab': async (step: StepUnion) => ({ stepId: step.id, ok: true, data: step.args }),
        }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(executed.length, 0);
});

test('create_tab prefers pendingCreatedTab ready over workspace url match', async () => {
    const tabs = [{ name: 'tab-now', url: 'about:blank' }, { name: 'runtime-url-match', url: 'https://matched/x' }];
    let switchedTo = '';
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'pre-ready', name: 'browser.click', args: {}, meta: { source: 'record', tabName: 'tab-now' } } as any,
            { id: 'c-ready-priority', name: 'browser.create_tab', args: { url: 'https://matched/x' }, meta: { source: 'record', tabName: 'recorded-new', tabRef: 'recorded-new-ref', urlAtRecord: 'https://matched/x' } } as any,
            { id: 'sw-ready-priority', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'recorded-new', tabRef: 'recorded-new-ref' } } as any,
        ],
        stopOnError: true,
        workspace: createReplayWorkspace(tabs),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.click': async () => (tabs.push({ name: 'runtime-from-effect', url: 'https://effect/x' }), { stepId: 'pre-ready', ok: true }),
            'browser.create_tab': async () => ({ stepId: 'c-ready-priority', ok: true, data: { tab_id: 'should-not-create' } }),
            'browser.switch_tab': async (step: StepUnion) => (switchedTo = (step.args as any).tabName, { stepId: step.id, ok: true }),
        }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(switchedTo, 'runtime-from-effect');
});

test('create_tab fails on pending created effect conflict', async () => {
    const tabs = [{ name: 'tab-now', url: 'about:blank' }];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'p1', name: 'browser.click', args: {}, meta: { source: 'record', tabName: 'tab-now' } } as any,
            { id: 'p2', name: 'browser.click', args: {}, meta: { source: 'record', tabName: 'tab-now' } } as any,
            { id: 'c3', name: 'browser.create_tab', args: { url: 'https://conflict-no-match' }, meta: { source: 'record', tabName: 'tab-c', tabRef: 'tab-c-ref' } } as any,
        ],
        stopOnError: true,
        workspace: createReplayWorkspace(tabs),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.click': async (step: StepUnion) => (tabs.push({ name: `tab-${step.id}`, url: 'https://x' }), { stepId: step.id, ok: true }),
        }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_EFFECT_CONFLICT');
});

test('create_tab does not inject extra switch', async () => {
    const executed: string[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [{ id: 'c4', name: 'browser.create_tab', args: { url: 'https://x' }, meta: { source: 'record', tabName: 'tab-d' } } as any],
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.create_tab': async () => (executed.push('create'), { stepId: 'c4', ok: true, data: { tab_id: 'tab-d-runtime' } }),
            'browser.switch_tab': async () => (executed.push('switch'), { stepId: 'sw', ok: true }),
        }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(executed.includes('create'), true);
    assert.equal(executed.includes('switch'), false);
});

test('switch_tab works with existing binding', async () => {
    let switchedTo = '';
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [{ id: 'sw-ok', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'tab-a', tabRef: 'tab-a-ref' } } as any],
        recordingManifest: { recordingToken: 't-sw-1', initialTabs: [{ tabName: 'tab-a', tabRef: 'tab-a-ref', url: 'about:blank', title: 'x', active: true }], startedAt: Date.now(), tabs: [] } as any,
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({ 'browser.switch_tab': async (step: StepUnion) => (switchedTo = (step.args as any).tabName, { stepId: step.id, ok: true }) }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(switchedTo, 'tab-now');
});

test('switch_tab binds from pending created effect when unbound', async () => {
    const tabs = [{ name: 'tab-now', url: 'about:blank' }];
    let switchedTo = '';
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'pre', name: 'browser.click', args: {}, meta: { source: 'record', tabName: 'tab-now' } } as any,
            { id: 'sw-ready', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'tab-new', tabRef: 'tab-new-ref' } } as any,
        ],
        stopOnError: true,
        workspace: createReplayWorkspace(tabs),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.click': async () => (tabs.push({ name: 'tab-runtime-new', url: 'https://x' }), { stepId: 'pre', ok: true }),
            'browser.switch_tab': async (step: StepUnion) => (switchedTo = (step.args as any).tabName, { stepId: step.id, ok: true }),
        }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(switchedTo, 'tab-runtime-new');
});

test('switch_tab fails when unbound and no pending created effect', async () => {
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [{ id: 'sw-fail', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'tab-missing', tabRef: 'tab-missing-ref' } } as any],
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({ 'browser.switch_tab': async () => ({ stepId: 'sw-fail', ok: true }) }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');
});

test('switch_tab does not create tabs', async () => {
    const executed: string[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [{ id: 'sw-no-create', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'tab-missing', tabRef: 'tab-missing-ref' } } as any],
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.create_tab': async () => (executed.push('create'), { stepId: 'x', ok: true, data: { tab_id: 'x' } }),
            'browser.switch_tab': async () => ({ stepId: 'sw-no-create', ok: true }),
        }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, false);
    assert.equal(executed.includes('create'), false);
});

test('close_tab is no-op when tab already marked closed', async () => {
    const executed: string[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'close-1', name: 'browser.close_tab', args: { tabRef: 'tab-a-ref' }, meta: { source: 'record', tabName: 'tab-a', tabRef: 'tab-a-ref' } } as any,
            { id: 'close-2', name: 'browser.close_tab', args: { tabRef: 'tab-a-ref' }, meta: { source: 'record', tabName: 'tab-a', tabRef: 'tab-a-ref' } } as any,
        ],
        recordingManifest: { recordingToken: 't-close-1', initialTabs: [{ tabName: 'tab-a', tabRef: 'tab-a-ref', url: 'about:blank', title: 'x', active: true }], startedAt: Date.now(), tabs: [] } as any,
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({ 'browser.close_tab': async () => (executed.push('close'), { stepId: 'x', ok: true }) }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(executed.length, 1);
});

test('close_tab consumes matching pending closed effect', async () => {
    const tabs = [{ name: 'tab-now', url: 'about:blank' }];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'mk', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'tab-a', tabRef: 'tab-a-ref' } } as any,
            { id: 'pre-close', name: 'browser.click', args: {}, meta: { source: 'record', tabName: 'tab-now' } } as any,
            { id: 'close-match', name: 'browser.close_tab', args: { tabRef: 'tab-a-ref' }, meta: { source: 'record', tabName: 'tab-a', tabRef: 'tab-a-ref' } } as any,
        ],
        recordingManifest: { recordingToken: 't-close-2', initialTabs: [{ tabName: 'tab-a', tabRef: 'tab-a-ref', url: 'about:blank', title: 'x', active: true }], startedAt: Date.now(), tabs: [] } as any,
        stopOnError: true,
        workspace: createReplayWorkspace(tabs),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.switch_tab': async (step: StepUnion) => ({ stepId: step.id, ok: true }),
            'browser.click': async () => (tabs.splice(0, tabs.length, ...tabs.filter((t) => t.name !== 'tab-now')), { stepId: 'pre-close', ok: true }),
            'browser.close_tab': async () => ({ stepId: 'close-match', ok: true }),
        }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
});

test('close_tab fails when pending closed effect mismatches tab binding', async () => {
    const tabs = [{ name: 'tab-now', url: 'about:blank' }, { name: 'tab-other', url: 'about:blank' }];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'pre-mismatch', name: 'browser.click', args: {}, meta: { source: 'record', tabName: 'tab-now' } } as any,
            { id: 'close-mismatch', name: 'browser.close_tab', args: { tabRef: 'tab-a-ref' }, meta: { source: 'record', tabName: 'tab-a', tabRef: 'tab-a-ref' } } as any,
        ],
        recordingManifest: { recordingToken: 't-close-3', initialTabs: [{ tabName: 'tab-a', tabRef: 'tab-a-ref', url: 'about:blank', title: 'x', active: true }], startedAt: Date.now(), tabs: [] } as any,
        stopOnError: true,
        workspace: createReplayWorkspace(tabs),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.click': async () => (tabs.splice(0, tabs.length, { name: 'tab-now', url: 'about:blank' }), { stepId: 'pre-mismatch', ok: true }),
        }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_EFFECT_MISMATCH');
});

test('close_tab does not switch tabs implicitly', async () => {
    const executed: string[] = [];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [{ id: 'close-run', name: 'browser.close_tab', args: { tabRef: 'tab-a-ref' }, meta: { source: 'record', tabName: 'tab-a', tabRef: 'tab-a-ref' } } as any],
        recordingManifest: { recordingToken: 't-close-4', initialTabs: [{ tabName: 'tab-a', tabRef: 'tab-a-ref', url: 'about:blank', title: 'x', active: true }], startedAt: Date.now(), tabs: [] } as any,
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
            'browser.close_tab': async () => (executed.push('close'), { stepId: 'close-run', ok: true }),
            'browser.switch_tab': async () => (executed.push('switch'), { stepId: 'sw', ok: true }),
        }) as any } as any } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(executed.includes('close'), true);
    assert.equal(executed.includes('switch'), false);
});

test('normal click/fill/select_option fail when target tab is unbound and do not create tabs', async () => {
    const executed: string[] = [];
    for (const stepName of ['browser.click', 'browser.fill', 'browser.select_option'] as const) {
        const result = await replayRecording({
            workspaceName: 'ws-now',
            initialTabName: 'tab-now',
            steps: [{ id: `no-bind-${stepName}`, name: stepName as any, args: {}, meta: { source: 'record', tabName: 'tab-missing', tabRef: 'tab-missing-ref' } } as any],
            stopOnError: true,
            workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
            runtime: createReplayRuntime() as any,
            pageRegistry: {} as any,
            deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({
                'browser.create_tab': async () => (executed.push('create'), { stepId: 'create', ok: true, data: { tab_id: 'x' } }),
                [stepName]: async (step: StepUnion) => ({ stepId: step.id, ok: true }),
            }) as any } as any } as RunStepsDeps,
        });
        assert.equal(result.ok, false);
        assert.equal(result.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');
    }
    assert.equal(executed.includes('create'), false);
});

test('error codes remain stable for tab effect conflict mismatch and not bound', async () => {
    const notBound = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [{ id: 'nb', name: 'browser.switch_tab', args: {}, meta: { source: 'record', tabName: 'missing', tabRef: 'missing' } } as any],
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'tab-now', url: 'about:blank' }]),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({}) as any } as any } as RunStepsDeps,
    });
    assert.equal(notBound.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');

    const conflictTabs = [{ name: 'tab-now', url: 'about:blank' }];
    const conflict = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'c1', name: 'browser.click', args: {}, meta: { source: 'record', tabName: 'tab-now' } } as any,
            { id: 'c2', name: 'browser.click', args: {}, meta: { source: 'record', tabName: 'tab-now' } } as any,
            { id: 'create', name: 'browser.create_tab', args: {}, meta: { source: 'record', tabName: 'tab-x', tabRef: 'tab-x' } } as any,
        ],
        stopOnError: true,
        workspace: createReplayWorkspace(conflictTabs),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({ 'browser.click': async (step: StepUnion) => (conflictTabs.push({ name: `n-${step.id}`, url: 'u' }), { stepId: step.id, ok: true }) }) as any } as any } as RunStepsDeps,
    });
    assert.equal(conflict.error?.code, 'ERR_REPLAY_TAB_EFFECT_CONFLICT');

    const mismatchTabs = [{ name: 'tab-now', url: 'about:blank' }, { name: 'tab-other', url: 'about:blank' }];
    const mismatch = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        steps: [
            { id: 'pre', name: 'browser.click', args: {}, meta: { source: 'record', tabName: 'tab-now' } } as any,
            { id: 'close', name: 'browser.close_tab', args: {}, meta: { source: 'record', tabName: 'tab-a', tabRef: 'tab-a-ref' } } as any,
        ],
        recordingManifest: { recordingToken: 'x', initialTabs: [{ tabName: 'tab-a', tabRef: 'tab-a-ref', url: 'about:blank', title: 'x', active: true }], startedAt: Date.now(), tabs: [] } as any,
        stopOnError: true,
        workspace: createReplayWorkspace(mismatchTabs),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: { runtime: {} as any, config: loadRunnerConfig({ configPath: '__non_exist__.json' }), pluginHost: { getExecutors: () => ({ 'browser.click': async () => (mismatchTabs.splice(1, 1), { stepId: 'pre', ok: true }) }) as any } as any } as RunStepsDeps,
    });
    assert.equal(mismatch.error?.code, 'ERR_REPLAY_TAB_EFFECT_MISMATCH');
});

test('replay tab flow reuses runtime tab after click without calling create executor and keeps bindings for switch/close/switch', async () => {
    const executed: string[] = [];
    const tabs = [{ name: 'tab-old-runtime', url: 'https://old/page' }];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-old-runtime',
        steps: [
            { id: 'flow-click', name: 'browser.click', args: { selector: '#open' }, meta: { source: 'record', tabName: 'tab-old', tabRef: 'tab-old-ref' } } as any,
            { id: 'flow-create', name: 'browser.create_tab', args: { url: 'https://new/tab' }, meta: { source: 'record', tabName: 'tab-new', tabRef: 'tab-new-ref', urlAtRecord: 'https://new/tab' } } as any,
            { id: 'flow-switch-new', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'tab-new', tabRef: 'tab-new-ref' } } as any,
            { id: 'flow-close-new', name: 'browser.close_tab', args: { tabRef: 'tab-new-ref' }, meta: { source: 'record', tabName: 'tab-new', tabRef: 'tab-new-ref' } } as any,
            { id: 'flow-switch-old', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'tab-old', tabRef: 'tab-old-ref' } } as any,
        ],
        recordingManifest: {
            recordingToken: 'flow',
            initialTabs: [{ tabName: 'tab-old', tabRef: 'tab-old-ref', url: 'https://old/page', title: 'old', active: true }],
            startedAt: Date.now(),
            tabs: [],
        } as any,
        stopOnError: true,
        workspace: createReplayWorkspace(tabs),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () => ({
                    'browser.click': async () => (tabs.push({ name: 'tab-new-runtime', url: 'https://new/tab#1' }), { stepId: 'flow-click', ok: true }),
                    'browser.create_tab': async () => (executed.push('create'), { stepId: 'flow-create', ok: false, error: { code: 'ERR_SHOULD_NOT_RUN', message: 'should not run' } }),
                    'browser.switch_tab': async (step: StepUnion) => (executed.push(`switch:${(step.args as any).tabName}`), { stepId: step.id, ok: true }),
                    'browser.close_tab': async (step: StepUnion) => {
                        const tabName = (step.args as any).tabName;
                        const idx = tabs.findIndex((tab) => tab.name === tabName);
                        if (idx >= 0) {tabs.splice(idx, 1);}
                        executed.push(`close:${tabName}`);
                        return { stepId: step.id, ok: true };
                    },
                }) as any,
            } as any,
        } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(executed.includes('create'), false);
    assert.equal(executed.includes('switch:tab-new-runtime'), true);
    assert.equal(executed.includes('close:tab-new-runtime'), true);
    assert.equal(executed.includes('switch:tab-old-runtime'), true);
});

test('replay multi-tab sequence click/create/switch/close/switch succeeds without missing page registry', async () => {
    const executedSteps: string[] = [];
    const tabs = [{ name: 'runtime-old', url: 'https://old' }];
    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'runtime-old',
        steps: [
            { id: 's-click', name: 'browser.click', args: { selector: '#open' }, meta: { source: 'record', tabName: 'recorded-old', tabRef: 'recorded-old-ref' } } as any,
            { id: 's-create', name: 'browser.create_tab', args: { url: 'https://new' }, meta: { source: 'record', tabName: 'recorded-new', tabRef: 'recorded-new-ref', urlAtRecord: 'https://new' } } as any,
            { id: 's-switch-new', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'recorded-new', tabRef: 'recorded-new-ref' } } as any,
            { id: 's-close', name: 'browser.close_tab', args: { tabRef: 'recorded-new-ref' }, meta: { source: 'record', tabName: 'recorded-new', tabRef: 'recorded-new-ref' } } as any,
            { id: 's-switch-old', name: 'browser.switch_tab', args: { tabName: 'legacy' }, meta: { source: 'record', tabName: 'recorded-old', tabRef: 'recorded-old-ref' } } as any,
        ],
        recordingManifest: {
            recordingToken: 'flow-2',
            initialTabs: [{ tabName: 'recorded-old', tabRef: 'recorded-old-ref', url: 'https://old', title: 'old', active: true }],
            startedAt: Date.now(),
            tabs: [],
        } as any,
        stopOnError: true,
        workspace: createReplayWorkspace(tabs),
        runtime: createReplayRuntime() as any,
        pageRegistry: {} as any,
        deps: {
            runtime: {} as any,
            config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
            pluginHost: {
                getExecutors: () => ({
                    'browser.click': async () => (tabs.push({ name: 'runtime-new', url: 'https://new' }), executedSteps.push('browser.click'), { stepId: 's-click', ok: true }),
                    'browser.create_tab': async () => ({ stepId: 's-create', ok: false, error: { code: 'ERR_UNEXPECTED_CREATE', message: 'should not create' } }),
                    'browser.switch_tab': async (step: StepUnion) => (executedSteps.push(`browser.switch_tab:${(step.args as any).tabName}`), { stepId: step.id, ok: true }),
                    'browser.close_tab': async (step: StepUnion) => {
                        const tabName = (step.args as any).tabName;
                        const idx = tabs.findIndex((item) => item.name === tabName);
                        if (idx >= 0) {tabs.splice(idx, 1);}
                        executedSteps.push(`browser.close_tab:${tabName}`);
                        return { stepId: step.id, ok: true };
                    },
                }) as any,
            } as any,
        } as RunStepsDeps,
    });
    assert.equal(result.ok, true);
    assert.equal(executedSteps.includes('browser.switch_tab:runtime-new'), true);
    assert.equal(executedSteps.includes('browser.close_tab:runtime-new'), true);
    assert.equal(executedSteps.includes('browser.switch_tab:runtime-old'), true);
    assert.equal(result.error?.message?.includes('missing page registry') ?? false, false);
});
