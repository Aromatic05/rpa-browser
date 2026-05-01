import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRecording } from '../../src/play/replay';
import type { StepUnion } from '../../src/runner/steps/types';
import { loadRunnerConfig } from '../../src/config/loader';
import type { RunStepsDeps } from '../../src/runner/run_steps';

test('replayRecording creates and switches tab when recorded tabName is missing (cold replay)', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 's1',
            name: 'browser.click',
            args: { selector: '#a' },
            meta: { source: 'record', tabName: 'token-a', tabId: 'tab-a', workspaceName: 'old-ws' },
        },
        {
            id: 's-switch',
            name: 'browser.switch_tab',
            args: { tabId: 'tab-b' },
            meta: { source: 'record', tabName: 'token-b', tabId: 'tab-b', workspaceName: 'old-ws' },
        },
        {
            id: 's2',
            name: 'browser.click',
            args: { selector: '#b' },
            meta: { source: 'record', tabName: 'token-b', tabId: 'tab-b', workspaceName: 'old-ws' },
        },
    ];

    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        initialTabName: 'token-a',
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
    assert.equal((executed[0].args as any).tabId, 'tab-now');
    assert.equal(executed[1].name, 'browser.click');
    assert.equal(executed.some((step) => step.name === 'browser.create_tab'), true);
    assert.equal(
        executed.some((step) => step.name === 'browser.switch_tab' && (step.args as any).tabId === 'tab-new-1'),
        true,
    );
    assert.equal(executed[executed.length - 1].name, 'browser.click');
});

test('replayRecording force switches when tabName changes without browser.switch_tab', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 's1',
            name: 'browser.click',
            args: { selector: '#a' },
            meta: { source: 'record', tabName: 'token-a', tabId: 'tab-a', workspaceName: 'old-ws' },
        },
        {
            id: 's2',
            name: 'browser.click',
            args: { selector: '#b' },
            meta: { source: 'record', tabName: 'token-b', tabId: 'tab-b', workspaceName: 'old-ws' },
        },
    ];

    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        initialTabName: 'token-a',
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
        executed.some((step) => step.name === 'browser.switch_tab' && (step.args as any).tabId === 'tab-new-1'),
        true,
    );
});

test('replayRecording reuses existing tab by token mapping in hot replay', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 'h1',
            name: 'browser.click',
            args: { selector: '#from-a' },
            meta: { source: 'record', tabName: 'token-a', workspaceName: 'ws-now' },
        },
        {
            id: 'h-switch',
            name: 'browser.switch_tab',
            args: { tabId: 'legacy-tab-b' },
            meta: { source: 'record', tabName: 'token-b', workspaceName: 'ws-now', tabId: 'tab-b' },
        },
        {
            id: 'h2',
            name: 'browser.click',
            args: { selector: '#from-b' },
            meta: { source: 'record', tabName: 'token-b', workspaceName: 'ws-now' },
        },
    ];

    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-a',
        initialTabName: 'token-a',
        steps,
        stopOnError: true,
        pageRegistry: {
            listTabs: async () => [{ tabId: 'tab-a' }, { tabId: 'tab-b' }],
            resolveTabNameFromToken: (token: string) => (token === 'token-b' ? 'tab-b' : undefined),
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
    assert.equal((switched?.args as any)?.tabId, 'tab-b');
});

test('replayRecording creates tab with recorded switch url when target tab is missing', async () => {
    const executed: StepUnion[] = [];
    const steps: StepUnion[] = [
        {
            id: 's-switch-missing',
            name: 'browser.switch_tab',
            args: { tabId: 'legacy-tab-b', tabUrl: 'https://example.com/target' },
            meta: { source: 'record', tabName: 'token-b', tabRef: 'tab-b', workspaceName: 'old-ws' },
        },
    ];

    const result = await replayRecording({
        workspaceName: 'ws-now',
        initialTabName: 'tab-now',
        initialTabName: 'token-a',
        steps,
        stopOnError: true,
        pageRegistry: {
            listTabs: async () => [{ tabId: 'tab-now' }],
            resolveTabNameFromToken: () => undefined,
            resolveTabNameFromRef: () => undefined,
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
    assert.equal((executed[1].args as any).tabId, 'tab-created');
});
