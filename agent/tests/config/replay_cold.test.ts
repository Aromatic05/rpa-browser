import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRecording } from '../../src/play/replay';
import type { StepUnion } from '../../src/runner/steps/types';
import { loadRunnerConfig } from '../../src/runner/config/loader';
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
    assert.equal(executed[0].name, 'browser.click');
    assert.equal(executed[1].name, 'browser.create_tab');
    assert.equal(executed[2].name, 'browser.switch_tab');
    assert.equal((executed[2].args as any).tab_id, 'tab-new-1');
    assert.equal(executed[3].name, 'browser.click');
});

test('replayRecording fails when tabToken changes without browser.switch_tab', async () => {
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
                        'browser.click': async (step: StepUnion) => ({ stepId: step.id, ok: true }),
                        'browser.create_tab': async () => ({ stepId: 'create', ok: true, data: { tab_id: 'tab-new-1' } }),
                        'browser.switch_tab': async () => ({ stepId: 'switch', ok: true }),
                    }) as any,
            } as any,
        } as RunStepsDeps,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_ASSERTION_FAILED');
});
