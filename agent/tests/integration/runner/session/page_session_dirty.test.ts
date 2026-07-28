import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldMarkPageSessionDirtyByStep} from '../../../../src/runner/session/dirty';

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
