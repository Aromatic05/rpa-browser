import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyBrowserOperation,
    getBrowserOperationStaticClassification,
} from '../../../../src/runner/steps/effects';

test('browser operation classification belongs to the runner step layer', () => {
    for (const name of [
        'browser.get_page_info',
        'browser.list_tabs',
        'browser.snapshot',
        'browser.capture_resolve',
        'browser.get_content',
        'browser.read_console',
        'browser.read_network',
        'browser.take_screenshot',
        'browser.assert',
        'browser.query',
        'browser.compute',
    ]) {
        assert.equal(classifyBrowserOperation(name, {}), 'read', name);
    }

    for (const name of [
        'browser.goto',
        'browser.go_back',
        'browser.reload',
        'browser.create_tab',
        'browser.switch_tab',
        'browser.close_tab',
        'browser.evaluate',
        'browser.click',
        'browser.fill',
        'browser.type',
        'browser.select_option',
        'browser.hover',
        'browser.scroll',
        'browser.press_key',
        'browser.drag_and_drop',
        'browser.mouse',
        'browser.checkpoint',
        'browser.batch',
    ]) {
        assert.equal(classifyBrowserOperation(name, {}), 'effect', name);
    }
});

test('browser.entity is read-only only for observation operations', () => {
    for (const op of ['list', 'get', 'find']) {
        assert.equal(classifyBrowserOperation('browser.entity', {op}), 'read');
    }
    for (const op of ['add', 'delete', 'rename', undefined]) {
        assert.equal(classifyBrowserOperation('browser.entity', {op}), 'effect');
    }
    assert.equal(getBrowserOperationStaticClassification('browser.entity'), 'dynamic');
});

test('unknown browser operations fail closed as effects', () => {
    assert.equal(classifyBrowserOperation('browser.unknown', {}), 'effect');
    assert.equal(getBrowserOperationStaticClassification('browser.unknown'), undefined);
});
