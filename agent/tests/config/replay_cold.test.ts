import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTabEffectsFromDiffForTest, createTabEffectRegisterForTest, inferExpectedCreatedTabUrlForTest, recordClosedTabEffectForTest, recordCreatedTabEffectForTest, replayRecording } from '../../src/record/replay';
import type { RecordingManifest } from '../../src/record/recording';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import type { StepName, StepUnion } from '../../src/runner/steps/types';
import { loadRunnerConfig } from '../../src/config/loader';

type RuntimeTab = { name: string; url: string; title?: string; createdAt?: number };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const step = <TName extends StepName>(id: string, name: TName, args: Extract<StepUnion, { name: TName }>['args']): StepUnion =>
    ({ id, name, args }) as StepUnion;

const createManifest = (activeTabName = 'tab-b', activeTabRef = 'ref-b'): RecordingManifest => ({
    recordingToken: 'recording-test',
    workspaceName: 'recorded-ws',
    entryTabRef: activeTabRef,
    activeTabRef,
    initialTabs: [{ tabName: activeTabName, tabRef: activeTabRef, url: 'https://initial.example/', title: 'Initial', active: true }],
    startedAt: 1,
    tabs: [],
});

const createReplayWorkspace = (tabs: RuntimeTab[]) => ({
    tabs: {
        listTabs: () => tabs.map((item) => ({ ...item })),
        hasTab: (tabName: string) => tabs.some((item) => item.name === tabName),
        getTab: (tabName: string) => tabs.find((item) => item.name === tabName) || null,
    },
}) as any;

const createRuntime = (ensured: string[]) => ({
    ensureExecutableTab: async ({ tabName }: { tabName: string }) => {
        ensured.push(tabName);
        return { page: { url: () => 'about:blank' }, tabName };
    },
});

const createDeps = (handlers: Partial<Record<StepName, (step: StepUnion) => Promise<{ stepId: string; ok: boolean; data?: unknown; error?: unknown }> | { stepId: string; ok: boolean; data?: unknown; error?: unknown }>>): RunStepsDeps => ({
    runtime: {} as any,
    config: loadRunnerConfig({ configPath: '__non_exist__.json' }),
    pluginHost: {
        getExecutors: () => handlers as any,
    } as any,
});

const replay = async (input: {
    steps: StepUnion[];
    tabs?: RuntimeTab[];
    handlers?: Partial<Record<StepName, (step: StepUnion) => Promise<{ stepId: string; ok: boolean; data?: unknown; error?: unknown }> | { stepId: string; ok: boolean; data?: unknown; error?: unknown }>>;
    manifest?: RecordingManifest;
    ensured?: string[];
}) => {
    const tabs = input.tabs || [{ name: 'runtime-b', url: 'https://initial.example/', title: 'Initial' }];
    const ensured = input.ensured || [];
    return replayRecording({
        workspaceName: 'runtime-ws',
        initialTabName: 'runtime-b',
        steps: input.steps,
        stopOnError: true,
        workspace: createReplayWorkspace(tabs),
        runtime: createRuntime(ensured) as any,
        pageRegistry: {} as any,
        recordingManifest: input.manifest ?? createManifest(),
        deps: createDeps(input.handlers || {}),
    });
};

test('replay runs canonical persisted steps without meta', async () => {
    const ensured: string[] = [];
    const executed: StepUnion[] = [];
    const result = await replay({
        ensured,
        steps: [step('click-b', 'browser.click', { selector: '#b' })],
        handlers: {
            'browser.click': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(ensured, ['runtime-b']);
    assert.deepEqual(executed.map((item) => item.id), ['click-b']);
});

test('create_tab and switch_tab use args.tabName to drive bindings and active tab', async () => {
    const tabs: RuntimeTab[] = [{ name: 'runtime-b', url: 'https://initial.example/' }];
    const ensured: string[] = [];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        ensured,
        steps: [
            step('create-a', 'browser.create_tab', { tabName: 'tab-a' }),
            step('switch-a', 'browser.switch_tab', { tabName: 'tab-a' }),
            step('click-a', 'browser.click', { selector: '#a' }),
        ],
        handlers: {
            'browser.create_tab': async (item) => (executed.push(item), tabs.push({ name: 'runtime-a', url: 'about:blank' }), { stepId: item.id, ok: true, data: { tab_id: 'runtime-a' } }),
            'browser.switch_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.click': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, true);
    assert.equal((executed.find((item) => item.id === 'switch-a')?.args as any).tabName, 'runtime-a');
    assert.deepEqual(ensured, ['runtime-a']);
});

test('replay ignores input meta when routing ordinary steps', async () => {
    const ensured: string[] = [];
    const result = await replay({
        ensured,
        steps: [{ id: 'click-meta', name: 'browser.click', args: { selector: '#b' }, meta: { source: 'record', tabName: 'wrong-tab', urlAtRecord: 'https://wrong.example/' } } as any],
        handlers: {
            'browser.click': async (item) => ({ stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(ensured, ['runtime-b']);
});

test('ordinary step without recorded active tab fails as not bound', async () => {
    const result = await replay({
        manifest: { ...createManifest(), activeTabRef: undefined, initialTabs: [] },
        steps: [step('click-no-active', 'browser.click', { selector: '#x' })],
        handlers: {
            'browser.click': async (item) => ({ stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_NOT_BOUND');
});

test('created tab effect stores runtime tab facts and keeps single-slot conflict behavior', () => {
    const register = createTabEffectRegisterForTest();
    recordCreatedTabEffectForTest(register, 'runtime-new', { url: 'https://created.example/', title: 'Created', createdAt: 123 });

    assert.equal(register.pendingCreatedTab.state, 'ready');
    if (register.pendingCreatedTab.state !== 'ready') {throw new Error('expected ready created tab effect');}
    assert.equal(register.pendingCreatedTab.value.runtimeTabName, 'runtime-new');
    assert.equal(register.pendingCreatedTab.value.url, 'https://created.example/');
    assert.equal(register.pendingCreatedTab.value.title, 'Created');
    assert.equal(register.pendingCreatedTab.value.createdAt, 123);

    recordCreatedTabEffectForTest(register, 'runtime-other');
    assert.equal(register.pendingCreatedTab.state, 'conflict');
});

test('closed tab effect behavior remains single-slot conflict behavior', () => {
    const register = createTabEffectRegisterForTest();
    recordClosedTabEffectForTest(register, 'runtime-a');
    assert.equal(register.pendingClosedTab.state, 'ready');
    recordClosedTabEffectForTest(register, 'runtime-b');
    assert.equal(register.pendingClosedTab.state, 'conflict');
});

test('collecting tab diff stores created tab url and title facts', () => {
    const register = createTabEffectRegisterForTest();
    const workspace = createReplayWorkspace([
        { name: 'runtime-a', url: 'https://a.example/', title: 'A' },
        { name: 'runtime-b', url: 'https://b.example/', title: 'B' },
    ]);

    collectTabEffectsFromDiffForTest(register, new Set(['runtime-a']), new Set(['runtime-a', 'runtime-b']), 'browser.click', workspace);

    assert.equal(register.pendingCreatedTab.state, 'ready');
    if (register.pendingCreatedTab.state !== 'ready') {throw new Error('expected ready created tab effect');}
    assert.equal(register.pendingCreatedTab.value.runtimeTabName, 'runtime-b');
    assert.equal(register.pendingCreatedTab.value.url, 'https://b.example/');
    assert.equal(register.pendingCreatedTab.value.title, 'B');
});

test('expected created tab url is inferred from canonical active tab stream', () => {
    assert.equal(inferExpectedCreatedTabUrlForTest([
        step('create-a', 'browser.create_tab', { tabName: 'tab-a' }),
        step('switch-a', 'browser.switch_tab', { tabName: 'tab-a' }),
        step('goto-a', 'browser.goto', { url: 'https://a.example/' }),
    ], 0), 'https://a.example/');

    assert.equal(inferExpectedCreatedTabUrlForTest([
        step('create-a', 'browser.create_tab', { tabName: 'tab-a' }),
        step('switch-b', 'browser.switch_tab', { tabName: 'tab-b' }),
        step('goto-b', 'browser.goto', { url: 'https://b.example/' }),
    ], 0), undefined);

    assert.equal(inferExpectedCreatedTabUrlForTest([
        step('create-a', 'browser.create_tab', { tabName: 'tab-a' }),
        step('close-a', 'browser.close_tab', { tabName: 'tab-a' }),
        step('switch-a', 'browser.switch_tab', { tabName: 'tab-a' }),
        step('goto-a', 'browser.goto', { url: 'https://a.example/' }),
    ], 0), undefined);

    assert.equal(inferExpectedCreatedTabUrlForTest([
        { id: 'create-a', name: 'browser.create_tab', args: { tabName: 'tab-a' }, meta: { source: 'record', urlAtRecord: 'https://meta.example/' } } as any,
    ], 0), undefined);

    assert.equal(inferExpectedCreatedTabUrlForTest([
        step('create-a', 'browser.create_tab', { tabName: 'tab-a' }),
        step('goto-current', 'browser.goto', { url: 'https://current.example/' }),
    ], 0), undefined);
});

test('create_tab consumes pending created effect when url matches expected goto', async () => {
    const tabs: RuntimeTab[] = [{ name: 'runtime-b', url: 'https://initial.example/' }];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [
            step('open', 'browser.click', { selector: '#open' }),
            step('create-c', 'browser.create_tab', { tabName: 'tab-c' }),
            step('switch-c', 'browser.switch_tab', { tabName: 'tab-c' }),
            step('goto-c', 'browser.goto', { url: 'https://expected.example/path#recorded' }),
        ],
        handlers: {
            'browser.click': async (item) => (executed.push(item), tabs.push({ name: 'runtime-c', url: 'https://expected.example/path#actual', title: 'C' }), { stepId: item.id, ok: true }),
            'browser.create_tab': async (item) => (executed.push(item), tabs.push({ name: 'unexpected-create', url: 'about:blank' }), { stepId: item.id, ok: true, data: { tab_id: 'unexpected-create' } }),
            'browser.switch_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.goto': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, true);
    assert.equal(executed.some((item) => item.name === 'browser.create_tab'), false);
    assert.equal((executed.find((item) => item.id === 'switch-c')?.args as any).tabName, 'runtime-c');
});

test('create_tab fails mismatched pending created effect without active create', async () => {
    const tabs: RuntimeTab[] = [{ name: 'runtime-b', url: 'https://initial.example/' }];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [
            step('open', 'browser.click', { selector: '#open' }),
            step('create-c', 'browser.create_tab', { tabName: 'tab-c' }),
            step('switch-c', 'browser.switch_tab', { tabName: 'tab-c' }),
            step('goto-c', 'browser.goto', { url: 'https://expected.example/' }),
            step('close-c', 'browser.close_tab', { tabName: 'tab-c' }),
        ],
        handlers: {
            'browser.click': async (item) => (executed.push(item), tabs.push({ name: 'runtime-wrong', url: 'https://wrong.example/', title: 'Wrong' }), { stepId: item.id, ok: true }),
            'browser.create_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true, data: { tab_id: 'unexpected-create' } }),
            'browser.switch_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.goto': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.close_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_EFFECT_MISMATCH');
    assert.equal((result.error?.details as any).expectedUrl, 'https://expected.example/');
    assert.equal((result.error?.details as any).actualUrl, 'https://wrong.example/');
    assert.equal(executed.some((item) => item.name === 'browser.create_tab'), false);
    assert.equal(executed.some((item) => item.name === 'browser.switch_tab'), false);
    assert.equal(executed.some((item) => item.name === 'browser.goto'), false);
    assert.equal(executed.some((item) => item.name === 'browser.close_tab'), false);
});

test('create_tab consumes pending created effect when expected url is empty', async () => {
    const tabs: RuntimeTab[] = [{ name: 'runtime-b', url: 'https://initial.example/' }];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [
            step('open', 'browser.click', { selector: '#open' }),
            step('create-c', 'browser.create_tab', { tabName: 'tab-c' }),
            step('switch-c', 'browser.switch_tab', { tabName: 'tab-c' }),
        ],
        handlers: {
            'browser.click': async (item) => (executed.push(item), tabs.push({ name: 'runtime-c', url: 'https://any.example/' }), { stepId: item.id, ok: true }),
            'browser.create_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true, data: { tab_id: 'unexpected-create' } }),
            'browser.switch_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, true);
    assert.equal(executed.some((item) => item.name === 'browser.create_tab'), false);
    assert.equal((executed.find((item) => item.id === 'switch-c')?.args as any).tabName, 'runtime-c');
});

test('create_tab reports conflict for duplicate pending created effects', async () => {
    const tabs: RuntimeTab[] = [{ name: 'runtime-b', url: 'https://initial.example/' }];
    const result = await replay({
        tabs,
        steps: [
            step('open-two', 'browser.click', { selector: '#open-two' }),
            step('create-c', 'browser.create_tab', { tabName: 'tab-c' }),
        ],
        handlers: {
            'browser.click': async (item) => (tabs.push({ name: 'runtime-c1', url: 'https://one.example/' }, { name: 'runtime-c2', url: 'https://two.example/' }), { stepId: item.id, ok: true }),
            'browser.create_tab': async (item) => ({ stepId: item.id, ok: true, data: { tab_id: 'unexpected-create' } }),
        },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_EFFECT_CONFLICT');
});

test('create_tab actively creates only when no real created tab exists and does not goto or switch', async () => {
    const tabs: RuntimeTab[] = [{ name: 'runtime-b', url: 'https://initial.example/' }];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [step('create-c', 'browser.create_tab', { tabName: 'tab-c' })],
        handlers: {
            'browser.create_tab': async (item) => (executed.push(item), tabs.push({ name: 'runtime-created', url: 'about:blank' }), { stepId: item.id, ok: true, data: { tab_id: 'runtime-created' } }),
            'browser.switch_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.goto': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(executed.map((item) => item.name), ['browser.create_tab']);
    assert.equal((executed[0].args as any).tabName, 'tab-c');
});

test('create_tab scans one unbound workspace tab before active create', async () => {
    const tabs: RuntimeTab[] = [
        { name: 'runtime-b', url: 'https://initial.example/' },
        { name: 'runtime-c', url: 'https://expected.example/' },
    ];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [
            step('create-c', 'browser.create_tab', { tabName: 'tab-c' }),
            step('switch-c', 'browser.switch_tab', { tabName: 'tab-c' }),
            step('goto-c', 'browser.goto', { url: 'https://expected.example/' }),
        ],
        handlers: {
            'browser.create_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true, data: { tab_id: 'unexpected-create' } }),
            'browser.switch_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.goto': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, true);
    assert.equal(executed.some((item) => item.name === 'browser.create_tab'), false);
    assert.equal((executed.find((item) => item.id === 'switch-c')?.args as any).tabName, 'runtime-c');
});

test('create_tab fails one unbound workspace tab url mismatch without active create', async () => {
    const tabs: RuntimeTab[] = [
        { name: 'runtime-b', url: 'https://initial.example/' },
        { name: 'runtime-wrong', url: 'https://wrong.example/' },
    ];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        steps: [
            step('create-c', 'browser.create_tab', { tabName: 'tab-c' }),
            step('switch-c', 'browser.switch_tab', { tabName: 'tab-c' }),
            step('goto-c', 'browser.goto', { url: 'https://expected.example/' }),
        ],
        handlers: {
            'browser.create_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true, data: { tab_id: 'unexpected-create' } }),
        },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_EFFECT_MISMATCH');
    assert.equal(executed.some((item) => item.name === 'browser.create_tab'), false);
});

test('create_tab reports conflict for multiple unbound workspace tabs', async () => {
    const result = await replay({
        tabs: [
            { name: 'runtime-b', url: 'https://initial.example/' },
            { name: 'runtime-c1', url: 'https://one.example/' },
            { name: 'runtime-c2', url: 'https://two.example/' },
        ],
        steps: [step('create-c', 'browser.create_tab', { tabName: 'tab-c' })],
        handlers: {
            'browser.create_tab': async (item) => ({ stepId: item.id, ok: true, data: { tab_id: 'unexpected-create' } }),
        },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_EFFECT_CONFLICT');
});

test('production replay flow does not call ForTest helpers', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/record/replay.ts'), 'utf8');
    const flow = source.slice(source.indexOf('export const replayRecording'));

    assert.equal(flow.includes('createTabEffectRegisterForTest'), false);
    assert.equal(flow.includes('recordCreatedTabEffectForTest'), false);
    assert.equal(flow.includes('collectTabEffectsFromDiffForTest'), false);
    assert.equal(flow.includes('inferExpectedCreatedTabUrlForTest'), false);
});

test('canonical persisted replay covers multi-tab success flow', async () => {
    const tabs: RuntimeTab[] = [{ name: 'runtime-b', url: 'https://b.example/' }];
    const ensured: string[] = [];
    const executed: StepUnion[] = [];
    const result = await replay({
        tabs,
        ensured,
        steps: [
            step('create-a', 'browser.create_tab', { tabName: 'tab-a' }),
            step('switch-a', 'browser.switch_tab', { tabName: 'tab-a' }),
            step('goto-a', 'browser.goto', { url: 'https://a.example/', timeout: 1000 }),
            step('click-a', 'browser.click', { selector: '#a' }),
            step('switch-b1', 'browser.switch_tab', { tabName: 'tab-b' }),
            step('click-b', 'browser.click', { selector: '#b' }),
            step('create-c', 'browser.create_tab', { tabName: 'tab-c' }),
            step('switch-c', 'browser.switch_tab', { tabName: 'tab-c' }),
            step('goto-c', 'browser.goto', { url: 'https://c.example/' }),
            step('close-c', 'browser.close_tab', { tabName: 'tab-c' }),
            step('switch-b2', 'browser.switch_tab', { tabName: 'tab-b' }),
        ],
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
                const tabName = (item.args as any).tabName;
                const index = tabs.findIndex((tab) => tab.name === tabName);
                if (index >= 0) {tabs.splice(index, 1);}
                return { stepId: item.id, ok: true };
            },
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(ensured, ['runtime-a', 'runtime-a', 'runtime-b', 'runtime-c']);
    assert.equal((executed.find((item) => item.id === 'switch-b2')?.args as any).tabName, 'runtime-b');
    assert.equal(JSON.stringify(result).includes('meta'), false);
});

test('canonical persisted replay exposes mismatched created tab side effect', async () => {
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
            'browser.click': async (item) => (executed.push(item), tabs.push({ name: 'runtime-wrong', url: 'https://wrong.example/' }), { stepId: item.id, ok: true }),
            'browser.create_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true, data: { tab_id: 'unexpected' } }),
            'browser.switch_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.goto': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
            'browser.close_tab': async (item) => (executed.push(item), { stepId: item.id, ok: true }),
        },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_REPLAY_TAB_EFFECT_MISMATCH');
    assert.equal((result.error?.details as any).expectedUrl, 'https://expected.example/');
    assert.equal((result.error?.details as any).actualUrl, 'https://wrong.example/');
    assert.deepEqual(executed.map((item) => item.id), ['click-b']);
});
