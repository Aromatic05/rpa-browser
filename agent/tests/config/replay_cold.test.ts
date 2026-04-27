import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRecording } from '../../src/play/replay';
import type { StepUnion } from '../../src/runner/steps/types';
import { loadRunnerConfig } from '../../src/config/loader';
import type { RunStepsDeps } from '../../src/runner/run_steps';

test('replayRecording creates and switches tab when recorded tabToken is missing (cold replay)', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 's1',
            name: 'browser.click',
            args: { target: { selector: '#a' } },
            meta: { source: 'record', tabToken: 'token-a', tabId: 'tab-a', workspaceId: 'old-ws' },
        },
        {
            id: 's-switch',
            name: 'browser.switch_tab',
            args: { tab_id: 'tab-b' },
            meta: { source: 'record', tabToken: 'token-b', tabId: 'tab-b', workspaceId: 'old-ws' },
        },
        {
            id: 's2',
            name: 'browser.click',
            args: { target: { selector: '#b' } },
            meta: { source: 'record', tabToken: 'token-b', tabId: 'tab-b', workspaceId: 'old-ws' },
        },
    ];

    const result = await replayRecording({
        workspaceId: 'ws-now',
        initialTabId: 'tab-now',
        initialTabToken: 'token-a',
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
        pageRegistry: {
            listTabs: async () => [{ tabId: 'tab-now' }],
        },
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
    assert.equal(executed[0].name, 'browser.switch_tab');
    assert.equal((executed[0].args as any).tab_id, 'tab-now');
    assert.equal(executed[1].name, 'browser.click');
    assert.equal(executed.some((step) => step.name === 'browser.create_tab'), true);
    assert.equal(
        executed.some((step) => step.name === 'browser.switch_tab' && (step.args as any).tab_id === 'tab-new-1'),
        true,
    );
    assert.equal(executed[executed.length - 1].name, 'browser.click');
});

test('replayRecording force switches when tabToken changes without browser.switch_tab', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 's1',
            name: 'browser.click',
            args: { target: { selector: '#a' } },
            meta: { source: 'record', tabToken: 'token-a', tabId: 'tab-a', workspaceId: 'old-ws' },
        },
        {
            id: 's2',
            name: 'browser.click',
            args: { target: { selector: '#b' } },
            meta: { source: 'record', tabToken: 'token-b', tabId: 'tab-b', workspaceId: 'old-ws' },
        },
    ];

    const result = await replayRecording({
        workspaceId: 'ws-now',
        initialTabId: 'tab-now',
        initialTabToken: 'token-a',
        steps,
        stopOnError: true,
        pageRegistry: {
            listTabs: async () => [{ tabId: 'tab-now' }],
        },
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
    assert.equal(
        executed.some((step) => step.name === 'browser.switch_tab' && (step.args as any).tab_id === 'tab-new-1'),
        true,
    );
});

test('replayRecording reuses existing tab by token mapping in hot replay', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 'h1',
            name: 'browser.click',
            args: { target: { selector: '#from-a' } },
            meta: { source: 'record', tabToken: 'token-a', workspaceId: 'ws-now' },
        },
        {
            id: 'h-switch',
            name: 'browser.switch_tab',
            args: { tab_id: 'legacy-tab-b' },
            meta: { source: 'record', tabToken: 'token-b', workspaceId: 'ws-now', tabId: 'tab-b' },
        },
        {
            id: 'h2',
            name: 'browser.click',
            args: { target: { selector: '#from-b' } },
            meta: { source: 'record', tabToken: 'token-b', workspaceId: 'ws-now' },
        },
    ];

    const result = await replayRecording({
        workspaceId: 'ws-now',
        initialTabId: 'tab-a',
        initialTabToken: 'token-a',
        steps,
        stopOnError: true,
        pageRegistry: {
            listTabs: async () => [{ tabId: 'tab-a' }, { tabId: 'tab-b' }],
            resolveTabIdFromToken: (token: string) => (token === 'token-b' ? 'tab-b' : undefined),
        },
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
    assert.equal((switched?.args as any)?.tab_id, 'tab-b');
});

test('replayRecording creates tab with recorded switch url when target tab is missing', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 's-switch-missing',
            name: 'browser.switch_tab',
            args: { tab_id: 'legacy-tab-b', tab_url: 'https://example.com/target' },
            meta: { source: 'record', tabToken: 'token-b', tabRef: 'tab-b', workspaceId: 'old-ws' },
        },
    ];

    const result = await replayRecording({
        workspaceId: 'ws-now',
        initialTabId: 'tab-now',
        initialTabToken: 'token-a',
        steps,
        stopOnError: true,
        pageRegistry: {
            listTabs: async () => [{ tabId: 'tab-now' }],
            resolveTabIdFromToken: () => undefined,
            resolveTabIdFromRef: () => undefined,
        },
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
    assert.equal((executed[1].args as any).tab_id, 'tab-created');
});
