import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldMarkPageSessionDirtyByStep} from '../../../../src/automation/runner/session/dirty';
import {executeStepWithRuntimeContracts} from '../../../../src/automation/runner/run_steps';
import {getRunnerConfig} from '../../../../src/platform/config';

test('page session dirty policy distinguishes page writes from high-frequency reads', () => {
    for (const step of ['browser.goto', 'browser.go_back', 'browser.reload', 'browser.click', 'browser.fill',
        'browser.type', 'browser.select_option', 'browser.press_key', 'browser.drag_and_drop']) {
        assert.equal(shouldMarkPageSessionDirtyByStep(step, {}), true, step);
    }

    for (const step of ['browser.hover', 'browser.scroll', 'browser.snapshot', 'browser.query',
        'browser.take_screenshot', 'browser.get_content']) {
        assert.equal(shouldMarkPageSessionDirtyByStep(step, {}), false, step);
    }

    assert.equal(shouldMarkPageSessionDirtyByStep('browser.evaluate', {expression: '1+1'}), false);
    assert.equal(shouldMarkPageSessionDirtyByStep('browser.evaluate', {expression: 'x=1', mutatesPage: true}), true);
    assert.equal(shouldMarkPageSessionDirtyByStep('browser.mouse', {action: 'move'}), false);
    assert.equal(shouldMarkPageSessionDirtyByStep('browser.mouse', {action: 'wheel'}), false);
    assert.equal(shouldMarkPageSessionDirtyByStep('browser.mouse', {action: 'click'}), true);
});

test('failed mutating steps still dirty the page session because side effects may have happened', async () => {
    const page = {};
    let dirtyCalls = 0;
    const deps = {
        pluginHost: {
            getExecutors: () => ({
                'browser.fill': async (step: {id: string}) => ({
                    stepId: step.id,
                    ok: false,
                    error: {code: 'ERR_INJECTED', message: 'failed after mutation'},
                }),
            }),
        },
        config: getRunnerConfig(),
        resolveWorkspace: () => ({
            tabs: {getActiveTab: () => ({name: 'main'})},
            browserSession: {pageRegistry: {}},
        }),
        runtime: {
            awaitExecutableTab: async () => ({page}),
        },
        pageSession: {
            markDirty: (value: unknown, reason: string) => {
                assert.equal(value, page);
                assert.equal(reason, 'interaction');
                dirtyCalls += 1;
            },
        },
    } as any;

    const result = await executeStepWithRuntimeContracts({
        id: 'fill-1',
        name: 'browser.fill',
        args: {nodeId: 'field', value: 'Alice'},
    }, 'ws', deps);

    assert.equal(result.ok, false);
    assert.equal(dirtyCalls, 1);
});
