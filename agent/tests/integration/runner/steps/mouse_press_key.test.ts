import test from 'node:test';
import assert from 'node:assert/strict';
import {getRunnerConfig} from '../../../../src/config';
import {executeBrowserMouse} from '../../../../src/automation/runner/steps/executors/mouse';
import {normalizeBrowserPressKey} from '../../../../src/automation/runner/steps/executors/press_key';
import type {Step} from '../../../../src/automation/runner/steps/types';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';

const createDeps = (traceMouseAction: (args: Record<string, unknown>) => Promise<unknown>) => {
    const page = {
        url: () => 'https://example.test',
        waitForTimeout: async () => undefined,
    };
    return completeRunStepsDeps({
        config: getRunnerConfig(),
        pluginHost: {} as never,
    }, {
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        page,
        traceTools: {
            'trace.mouse.action': traceMouseAction,
        },
    });
};

test('browser.mouse forwards canonical viewport coordinates', async () => {
    const calls: Record<string, unknown>[] = [];
    const deps = createDeps(async (args) => {
        calls.push(args);
        return {ok: true};
    });
    deps.config.humanPolicy.enabled = false;
    const step: Step<'browser.mouse'> = {
        id: 'mouse-click',
        name: 'browser.mouse',
        args: {action: 'click', x: 10, y: 20, button: 'left'},
    };

    const result = await executeBrowserMouse(step, deps, 'ws-1');
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{
        action: 'click',
        x: 10,
        y: 20,
        deltaY: undefined,
        button: 'left',
    }]);
});

test('browser.mouse rejects wheel without deltaY before dispatch', async () => {
    let dispatched = false;
    const deps = createDeps(async () => {
        dispatched = true;
        return {ok: true};
    });
    const step: Step<'browser.mouse'> = {
        id: 'mouse-wheel-invalid',
        name: 'browser.mouse',
        args: {action: 'wheel', x: 10, y: 20},
    };

    const result = await executeBrowserMouse(step, deps, 'ws-1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_INTERNAL');
    assert.equal(dispatched, false);
});

test('browser.mouse maps trace failures without changing the action protocol', async () => {
    const deps = createDeps(async () => ({
        ok: false,
        error: {code: 'ERR_TIMEOUT', message: 'mouse timeout'},
    }));
    const result = await executeBrowserMouse({
        id: 'mouse-failure',
        name: 'browser.mouse',
        args: {action: 'click', x: 1, y: 2},
    }, deps, 'ws-1');

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_TIMEOUT');
});

test('browser.press_key normalizes primary shortcuts by platform', () => {
    assert.equal(normalizeBrowserPressKey('ctrl+a', 'darwin'), 'Meta+A');
    assert.equal(normalizeBrowserPressKey('Control+Shift+a', 'darwin'), 'Meta+Shift+A');
    assert.equal(normalizeBrowserPressKey('CmdOrCtrl+a', 'linux'), 'Control+A');
    assert.equal(normalizeBrowserPressKey('CmdOrCtrl+a', 'darwin'), 'Meta+A');
});
