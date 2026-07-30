import test from 'node:test';
import assert from 'node:assert/strict';
import {placeFloatingPanel} from '../layout/floating_panel.js';

const panelRect = (position: {left: number; top: number}, width = 300, height = 240) => ({
    x: position.left,
    y: position.top,
    width,
    height,
});

const overlaps = (a: {x: number; y: number; width: number; height: number}, b: {x: number; y: number; width: number; height: number}) =>
    Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

test('floating editor chooses a visible position that avoids the selected target', () => {
    const target = {x: 420, y: 240, width: 140, height: 44};
    const position = placeFloatingPanel({
        target,
        viewport: {width: 1280, height: 720},
        panel: {width: 300, height: 240},
    });
    assert.equal(overlaps(panelRect(position), target), false);
    assert.ok(position.left >= 12);
    assert.ok(position.top >= 12);
});

test('floating editor stays inside a small viewport even when overlap is unavoidable', () => {
    const position = placeFloatingPanel({
        target: {x: 20, y: 20, width: 620, height: 420},
        viewport: {width: 680, height: 480},
        panel: {width: 300, height: 240},
    });
    assert.ok(position.left >= 12 && position.left <= 368);
    assert.ok(position.top >= 12 && position.top <= 228);
});

test('floating editor defaults to the top right without a target', () => {
    assert.deepEqual(placeFloatingPanel({
        target: null,
        viewport: {width: 1000, height: 700},
        panel: {width: 300, height: 240},
    }), {left: 688, top: 12});
});
