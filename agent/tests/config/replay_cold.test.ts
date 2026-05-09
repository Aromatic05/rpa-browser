import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRecording } from '../../src/record/replay';
import type { RecordingManifest } from '../../src/record/recording';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import type { StepName, StepUnion } from '../../src/runner/steps/types';
import { loadRunnerConfig } from '../../src/config/loader';

type RuntimeTab = { name: string; url: string; title?: string };
type StepHandler = (step: StepUnion) => Promise<{ stepId: string; ok: boolean; data?: unknown }> | { stepId: string; ok: boolean; data?: unknown };

const step = <TName extends StepName>(id: string, name: TName, args: Extract<StepUnion, { name: TName }>['args']): StepUnion =>
    ({ id, name, args }) as StepUnion;

const createManifest = (overrides?: Partial<RecordingManifest>): RecordingManifest => ({
    recordingToken: 'recording-test',
    workspaceName: 'recorded-ws',
    activeTabRef: 'tab-b',
    initialTabs: [],
    startedAt: 1,
    tabs: [],
    ...overrides,
});

const createReplayWorkspace = (tabs: RuntimeTab[]) => ({
    tabs: {
        listTabs: () => tabs.map((item) => ({ ...item })),
        hasTab: (tabName: string) => tabs.some((item) => item.name === tabName),
        getTab: (tabName: string) => tabs.find((item) => item.name === tabName) || null,
    },
}) as any;

const createReplayRuntime = (ensuredTabs: string[]) => ({
    ensureExecutableTab: async ({ tabName }: { tabName: string }) => {
        ensuredTabs.push(tabName);
        return { page: { url: () => 'about:blank' }, tabName };
    },
});

const createDeps = (handlers: Partial<Record<StepName, StepHandler>>): RunStepsDeps => ({
    runtime: {} as any,
    config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
    pluginHost: {
        getExecutors: () => handlers as any,
    } as any,
});

const replay = async (input: {
    steps: StepUnion[];
    tabs: RuntimeTab[];
    ensuredTabs?: string[];
    handlers: Partial<Record<StepName, StepHandler>>;
    manifestOverrides?: Partial<RecordingManifest>;
}) => replayRecording({
    workspaceName: 'runtime-ws',
    initialTabName: 'runtime-b',
    steps: input.steps,
    stopOnError: true,
    workspace: createReplayWorkspace(input.tabs),
    runtime: createReplayRuntime(input.ensuredTabs || []) as any,
    pageRegistry: {} as any,
    recordingManifest: createManifest(input.manifestOverrides),
    deps: createDeps(input.handlers),
});

test('canonical persisted replay follows recorded tab bindings', async () => {
    const tabs: RuntimeTab[] = [{ name: 'runtime-b', url: 'https://b.example/' }];
    const ensuredTabs: string[] = [];
    const executed: StepUnion[] = [];
    const steps = [
        step('create-a', 'browser.create_tab', { tabName: 'tab-a' }),
        step('switch-a', 'browser.switch_tab', { tabName: 'tab-a' }),
        step('goto-a', 'browser.goto', { url: 'https://a.example/', timeout: 1000 }),
        step('click-a', 'browser.click', { selector: '#a' }),
        step('switch-b1', 'browser.switch_tab', { tabName: 'tab-b' }),
        step('create-c', 'browser.create_tab', { tabName: 'tab-c' }),
        step('switch-c', 'browser.switch_tab', { tabName: 'tab-c' }),
        step('goto-c', 'browser.goto', { url: 'https://c.example/' }),
        step('close-c', 'browser.close_tab', { tabName: 'tab-c' }),
        step('switch-b2', 'browser.switch_tab', { tabName: 'tab-b' }),
    ];

    const result = await replay({
        tabs,
        ensuredTabs,
        steps,
        handlers: {
            'browser.create_tab': async (item) => {
                executed.push(item);
                const runtimeName = item.id === 'create-a' ? 'runtime-a' : 'runtime-c';
                tabs.push({ name: runtimeName, url: 'about:blank' });
                return { stepId: item.id, ok: true, data: { tab_id: runtimeName } };
            },
            'browser.switch_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.goto': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.click': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.close_tab': async (item) => {
                executed.push(item);
                const tabName = (item.args as { tabName: string }).tabName;
                const index = tabs.findIndex((tab) => tab.name === tabName);
                if (index >= 0) {tabs.splice(index, 1);}
                return { stepId: item.id, ok: true };
            },
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(ensuredTabs, ['runtime-a', 'runtime-a', 'runtime-c']);
    assert.equal((executed.find((item) => item.id === 'switch-a')?.args as { tabName: string }).tabName, 'runtime-a');
    assert.equal((executed.find((item) => item.id === 'switch-b1')?.args as { tabName: string }).tabName, 'runtime-b');
    assert.equal((executed.find((item) => item.id === 'switch-c')?.args as { tabName: string }).tabName, 'runtime-c');
    assert.equal((executed.find((item) => item.id === 'switch-b2')?.args as { tabName: string }).tabName, 'runtime-b');
});

test('canonical persisted replay fails mismatched created tab effect without active create', async () => {
    const tabs: RuntimeTab[] = [{ name: 'runtime-b', url: 'https://b.example/' }];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [
            step('click-b', 'browser.click', { selector: '#open' }),
            step('create-c', 'browser.create_tab', { tabName: 'tab-c' }),
            step('switch-c', 'browser.switch_tab', { tabName: 'tab-c' }),
            step('goto-c', 'browser.goto', { url: 'https://expected.example/' }),
            step('close-c', 'browser.close_tab', { tabName: 'tab-c' }),
        ],
        handlers: {
            'browser.click': async (item) => {
                executed.push(item);
                tabs.push({ name: 'runtime-wrong', url: 'https://wrong.example/' });
                return { stepId: item.id, ok: true };
            },
            'browser.create_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true, data: { tab_id: 'unexpected' } }),
            'browser.switch_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.goto': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.close_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_EFFECT_MISMATCH');
    assert.equal((result.error?.details as { expectedUrl: string }).expectedUrl, 'https://expected.example/');
    assert.equal((result.error?.details as { actualUrl: string }).actualUrl, 'https://wrong.example/');
    assert.deepEqual(executed.map((item) => item.id), ['click-b']);
});

test('canonical persisted replay actively creates only when no created tab effect exists', async () => {
    const tabs: RuntimeTab[] = [{ name: 'runtime-b', url: 'https://b.example/' }];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [step('create-c', 'browser.create_tab', { tabName: 'tab-c' })],
        handlers: {
            'browser.create_tab': async (item) => {
                executed.push(item);
                tabs.push({ name: 'runtime-c', url: 'about:blank' });
                return { stepId: item.id, ok: true, data: { tab_id: 'runtime-c' } };
            },
            'browser.switch_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.goto': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(executed.map((item) => item.name), ['browser.create_tab']);
    assert.equal((executed[0].args as { tabName: string }).tabName, 'tab-c');
});

test('normal click without recordedActiveTabName fails', async () => {
    const result = await replayRecording({
        workspaceName: 'runtime-ws',
        initialTabName: 'runtime-b',
        steps: [step('clk', 'browser.click', { selector: '#x' })],
        stopOnError: true,
        workspace: createReplayWorkspace([{ name: 'runtime-b', url: 'about:blank' }]),
        runtime: { ensureExecutableTab: async () => ({}) } as any,
        pageRegistry: {} as any,
        deps: createDeps({
            'browser.click': async (item) => ({ stepId: item.id, ok: true }),
        }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');
});

test('normal click with recordedActiveTabName but no binding fails', async () => {
    const result = await replay({
        tabs: [{ name: 'runtime-b', url: 'about:blank' }],
        steps: [step('clk', 'browser.click', { selector: '#x' })],
        manifestOverrides: { activeTabRef: undefined },
        handlers: {
            'browser.click': async (item) => ({ stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');
});

test('create_tab does not auto-bind to unbound runtime tab present in workspace', async () => {
    const tabs: RuntimeTab[] = [
        { name: 'runtime-b', url: 'about:blank' },
        { name: 'runtime-extra', url: 'https://extra.example/' },
    ];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [step('ct', 'browser.create_tab', { tabName: 'tab-new' })],
        handlers: {
            'browser.create_tab': async (item) => {
                executed.push(item);
                tabs.push({ name: 'runtime-explicit', url: 'about:blank' });
                return { stepId: item.id, ok: true, data: { tab_id: 'runtime-explicit' } };
            },
        },
    });

    assert.equal(result.ok, true);
    assert.equal(executed.length, 1);
    assert.equal((executed[0].args as { tabName: string }).tabName, 'tab-new');
});

test('create_tab does not auto-bind to runtime tab with same name', async () => {
    const tabs: RuntimeTab[] = [
        { name: 'runtime-b', url: 'about:blank' },
        { name: 'tab-new', url: 'https://same.example/' },
    ];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [step('ct', 'browser.create_tab', { tabName: 'tab-new' })],
        handlers: {
            'browser.create_tab': async (item) => {
                executed.push(item);
                tabs.push({ name: 'runtime-via-executor', url: 'about:blank' });
                return { stepId: item.id, ok: true, data: { tab_id: 'runtime-via-executor' } };
            },
        },
    });

    assert.equal(result.ok, true);
    assert.equal(executed.length, 1);
    assert.equal((executed[0].args as { tabName: string }).tabName, 'tab-new');
});

test('create_tab does not auto-bind to active runtime tab', async () => {
    const tabs: RuntimeTab[] = [
        { name: 'runtime-b', url: 'about:blank' },
        { name: 'runtime-active', url: 'https://active.example/' },
    ];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [step('ct', 'browser.create_tab', { tabName: 'tab-new' })],
        handlers: {
            'browser.create_tab': async (item) => {
                executed.push(item);
                tabs.push({ name: 'runtime-via-executor', url: 'about:blank' });
                return { stepId: item.id, ok: true, data: { tab_id: 'runtime-via-executor' } };
            },
        },
    });

    assert.equal(result.ok, true);
    assert.equal(executed.length, 1);
    assert.equal((executed[0].args as { tabName: string }).tabName, 'tab-new');
});
