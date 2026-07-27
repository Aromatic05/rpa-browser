import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeLabelPlacements,
    type LabelTarget,
} from '../layout/label_layout.js';

const VIEWPORT = {width: 1280, height: 720};
const OPTIONS = {
    margin: 16,
    labelWidth: 180,
    labelHeight: 28,
    gap: 8,
};

const makeTarget = (
    annotationId: string,
    x: number,
    y: number,
    width = 40,
    height = 20,
    kind: LabelTarget['kind'] = 'field',
): LabelTarget => ({
    annotationId,
    kind,
    targetCenter: {x: x + width / 2, y: y + height / 2},
    targetBox: {x, y, width, height},
});

test('table columns are labelled above the header with an upward connector', () => {
    const placements = computeLabelPlacements([
        makeTarget('orderNo', 300, 180, 140, 32, 'column'),
    ], VIEWPORT, OPTIONS);
    const placement = placements.orderNo;
    assert.equal(placement.side, 'top');
    assert.ok(placement.box.y + placement.box.height < 180);
    assert.deepEqual(placement.polyline[0], {x: 370, y: 180});
    assert.deepEqual(placement.polyline.at(-1), {
        x: placement.box.x + placement.box.width / 2,
        y: placement.box.y + placement.box.height,
    });
});

test('pagination is labelled below the control with a downward connector', () => {
    const placements = computeLabelPlacements([
        makeTarget('next', 900, 500, 80, 32, 'pagination'),
    ], VIEWPORT, OPTIONS);
    const placement = placements.next;
    assert.equal(placement.side, 'bottom');
    assert.ok(placement.box.y > 532);
    assert.deepEqual(placement.polyline[0], {x: 940, y: 532});
});

test('adjacent column labels use separate top lanes instead of overlapping', () => {
    const placements = computeLabelPlacements([
        makeTarget('a', 300, 180, 100, 32, 'column'),
        makeTarget('b', 360, 180, 100, 32, 'column'),
    ], VIEWPORT, OPTIONS);
    assert.equal(placements.a.side, 'top');
    assert.equal(placements.b.side, 'top');
    assert.equal(rectsOverlap(placements.a.box, placements.b.box), false);
});

test('non-overlapping table columns stay in one compact top lane', () => {
    const placements = computeLabelPlacements([
        makeTarget('a', 300, 180, 120, 32, 'column'),
        makeTarget('b', 420, 180, 120, 32, 'column'),
        makeTarget('c', 540, 180, 120, 32, 'column'),
    ], VIEWPORT, OPTIONS);
    assert.equal(placements.a.side, 'top');
    assert.equal(placements.b.side, 'top');
    assert.equal(placements.c.side, 'top');
    assert.equal(placements.a.box.y, placements.b.box.y);
    assert.equal(placements.b.box.y, placements.c.box.y);
    assert.equal(placements.a.box.width, 112);
    assert.equal(placements.b.box.width, 112);
    assert.equal(rectsOverlap(placements.a.box, placements.b.box), false);
});

test('table-header labels keep their lane when side labels share the same vertical area', () => {
    const placements = computeLabelPlacements([
        makeTarget('field', 1100, 170, 100, 32, 'field'),
        makeTarget('a', 300, 180, 120, 32, 'column'),
        makeTarget('b', 420, 180, 120, 32, 'column'),
    ], VIEWPORT, OPTIONS);
    assert.equal(placements.a.box.y, placements.b.box.y);
    assert.equal(placements.a.side, 'top');
    assert.equal(placements.b.side, 'top');
    assert.equal(rectsOverlap(placements.a.box, placements.field.box), false);
    assert.equal(rectsOverlap(placements.b.box, placements.field.box), false);
});

const boxesOverlap = (
    a: {y: number; height: number},
    b: {y: number; height: number},
    gap: number,
): boolean =>
    a.y + a.height + gap > b.y && a.y < b.y + b.height + gap;

test('placements are returned keyed by annotationId', () => {
    const targets = [
        makeTarget('a1', 100, 100),
        makeTarget('a2', 100, 200),
        makeTarget('a3', 100, 300),
    ];
    const placements = computeLabelPlacements(targets, VIEWPORT, OPTIONS);
    assert.ok(placements.a1);
    assert.ok(placements.a2);
    assert.ok(placements.a3);
});

test('targets are processed sorted by targetCenter.y ascending', () => {
    const targets = [
        makeTarget('low', 100, 300),
        makeTarget('high', 100, 100),
        makeTarget('mid', 100, 200),
    ];
    const placements = computeLabelPlacements(targets, VIEWPORT, OPTIONS);
    const ys = [placements.high.box.y, placements.mid.box.y, placements.low.box.y];
    assert.deepEqual([...ys].sort((a, b) => a - b), ys);
});

test('right side is preferred: label.x equals viewport.width - margin - labelWidth', () => {
    const targets = [makeTarget('a1', 100, 100)];
    const placements = computeLabelPlacements(targets, VIEWPORT, OPTIONS);
    assert.equal(placements.a1.side, 'right');
    assert.equal(placements.a1.box.x, VIEWPORT.width - OPTIONS.margin - OPTIONS.labelWidth);
    assert.equal(placements.a1.box.width, OPTIONS.labelWidth);
    assert.equal(placements.a1.box.height, OPTIONS.labelHeight);
});

test('polyline has exactly 3 points and ends at the label edge', () => {
    const targets = [makeTarget('a1', 100, 100)];
    const placements = computeLabelPlacements(targets, VIEWPORT, OPTIONS);
    const placement = placements.a1;
    assert.equal(placement.polyline.length, 3);
    const first = placement.polyline[0];
    const last = placement.polyline[2];
    assert.equal(first.x, 140);
    assert.equal(first.y, 110);
    assert.equal(last.x, placement.box.x);
    assert.equal(last.y, placement.box.y + OPTIONS.labelHeight / 2);
});

test('right-side placements never overlap each other', () => {
    const targets = Array.from({length: 12}, (_, i) =>
        makeTarget(`a${i}`, 100, 50 + i * 6),
    );
    const placements = computeLabelPlacements(targets, VIEWPORT, OPTIONS);
    const rightBoxes = Object.values(placements).filter((p) => p.side === 'right');
    for (let i = 0; i < rightBoxes.length; i += 1) {
        for (let j = i + 1; j < rightBoxes.length; j += 1) {
            const overlap = boxesOverlap(rightBoxes[i].box, rightBoxes[j].box, OPTIONS.gap);
            assert.equal(overlap, false, `right boxes ${i} and ${j} overlap`);
        }
    }
});

test('left-side placements never overlap each other', () => {
    const targets = Array.from({length: 40}, (_, i) =>
        makeTarget(`a${i}`, 100, 10 + i * 5),
    );
    const placements = computeLabelPlacements(targets, VIEWPORT, OPTIONS);
    const leftBoxes = Object.values(placements).filter((p) => p.side === 'left');
    assert.ok(leftBoxes.length > 0, 'at least one label should fall back to left');
    for (let i = 0; i < leftBoxes.length; i += 1) {
        for (let j = i + 1; j < leftBoxes.length; j += 1) {
            const overlap = boxesOverlap(leftBoxes[i].box, leftBoxes[j].box, OPTIONS.gap);
            assert.equal(overlap, false, `left boxes ${i} and ${j} overlap`);
        }
    }
});

test('left fallback is used when right column cannot fit', () => {
    const targets = Array.from({length: 60}, (_, i) =>
        makeTarget(`a${i}`, 100, 10 + i * 4),
    );
    const placements = computeLabelPlacements(targets, VIEWPORT, OPTIONS);
    const sides = new Set(Object.values(placements).map((p) => p.side));
    assert.ok(sides.has('right'));
    assert.ok(sides.has('left'));
});

test('label box is clamped to viewport bounds when overflowing', () => {
    const targets = Array.from({length: 18}, (_, i) =>
        makeTarget(`a${i}`, 100, i < 8 ? 10 + i * 36 : 900 + i * 20),
    );
    const placements = computeLabelPlacements(targets, VIEWPORT, OPTIONS);
    for (const [id, placement] of Object.entries(placements)) {
        assert.ok(
            placement.box.y >= 0,
            `label ${id} starts above viewport: ${placement.box.y}`,
        );
        assert.ok(
            placement.box.x >= 0,
            `label ${id} starts left of viewport: ${placement.box.x}`,
        );
        assert.ok(
            placement.box.x + placement.box.width <= VIEWPORT.width,
            `label ${id} ends right of viewport`,
        );
        assert.ok(
            placement.box.y + placement.box.height <= VIEWPORT.height,
            `label ${id} ends below viewport`,
        );
    }
});

test('empty targets yields empty placements', () => {
    const placements = computeLabelPlacements([], VIEWPORT, OPTIONS);
    assert.deepEqual(placements, {});
});

const rectsOverlap = (
    a: {x: number; y: number; width: number; height: number},
    b: {x: number; y: number; width: number; height: number},
): boolean =>
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;

test('saturation: 80 labels at 3px y-skip in 1080x720 viewport produce no overlapping boxes', () => {
    const viewport = {width: 1080, height: 720};
    const targets = Array.from({length: 80}, (_, i) =>
        makeTarget(`a${i}`, 100, 10 + i * 3),
    );
    const placements = computeLabelPlacements(targets, viewport, OPTIONS);
    const boxes = Object.values(placements).map((p) => p.box);
    assert.equal(boxes.length, 80);
    for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
            assert.equal(
                rectsOverlap(boxes[i], boxes[j]),
                false,
                `boxes ${i} and ${j} overlap: ${JSON.stringify(boxes[i])} / ${JSON.stringify(boxes[j])}`,
            );
        }
    }
});

test('saturation: 200 labels at 3px y-skip produce no overlapping boxes', () => {
    const viewport = {width: 1080, height: 720};
    const targets = Array.from({length: 200}, (_, i) =>
        makeTarget(`a${i}`, 100, 10 + i * 3),
    );
    const placements = computeLabelPlacements(targets, viewport, OPTIONS);
    const boxes = Object.values(placements).map((p) => p.box);
    assert.equal(boxes.length, 200);
    for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
            assert.equal(
                rectsOverlap(boxes[i], boxes[j]),
                false,
                `boxes ${i} and ${j} overlap`,
            );
        }
    }
});
