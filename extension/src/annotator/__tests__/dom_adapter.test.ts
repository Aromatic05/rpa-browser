import test from 'node:test';
import assert from 'node:assert/strict';
import {viewportRect} from '../picking/dom_adapter.js';

test('picker geometry remains in viewport coordinates after page scroll', () => {
    const rect = viewportRect({left: 18, top: 42, width: 120, height: 36});
    assert.deepEqual(rect, {x: 18, y: 42, width: 120, height: 36});
});
