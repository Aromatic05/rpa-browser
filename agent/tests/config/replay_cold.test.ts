import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRecording } from '../../src/play/replay';
import type { StepUnion } from '../../src/runner/steps/types';

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
        runStepsFn: async (req) => {
            const step = req.steps[0] as StepUnion;
            executed.push(step);
            if (step.name === 'browser.create_tab') {
                return { ok: true, results: [{ stepId: step.id, ok: true, data: { tab_id: 'tab-new-1' } }] };
            }
            return { ok: true, results: [{ stepId: step.id, ok: true }] };
        },
    });

    assert.equal(result.ok, true);
    assert.equal(executed[0].name, 'browser.click');
    assert.equal(executed[1].name, 'browser.create_tab');
    assert.equal(executed[2].name, 'browser.switch_tab');
    assert.equal((executed[2].args as any).tab_id, 'tab-new-1');
    assert.equal(executed[3].name, 'browser.click');
});
