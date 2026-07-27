import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeBoxRect,
    computeCenter,
    unionRect,
} from '../layout/box_geometry.js';

test('computeBoxRect subtracts scroll offset and applies zoom', () => {
    const rect = computeBoxRect(
        {x: 200, y: 400, width: 100, height: 50},
        {x: 50, y: 100},
        2,
    );
    assert.deepEqual(rect, {x: 300, y: 600, width: 200, height: 100});
});

test('computeBoxRect with zero scroll and unit zoom is identity', () => {
    const rect = computeBoxRect(
        {x: 12, y: 34, width: 56, height: 78},
        {x: 0, y: 0},
        1,
    );
    assert.deepEqual(rect, {x: 12, y: 34, width: 56, height: 78});
});

test('computeCenter returns midpoint of rect', () => {
    const center = computeCenter({x: 10, y: 20, width: 100, height: 40});
    assert.deepEqual(center, {x: 60, y: 40});
});

test('unionRect returns null on empty input', () => {
    assert.equal(unionRect([]), null);
});

test('unionRect returns the single box when given one', () => {
    const union = unionRect([{x: 1, y: 2, width: 10, height: 20}]);
    assert.deepEqual(union, {x: 1, y: 2, width: 10, height: 20});
});

test('unionRect spans all boxes', () => {
    const union = unionRect([
        {x: 5, y: 5, width: 10, height: 10},
        {x: 20, y: 30, width: 5, height: 5},
        {x: 0, y: 100, width: 1, height: 1},
    ]);
    assert.deepEqual(union, {x: 0, y: 5, width: 25, height: 96});
});
