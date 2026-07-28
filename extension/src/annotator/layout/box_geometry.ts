import type { PickRect } from '../types.js';

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type ViewportScroll = { x: number; y: number };

/**
 * Snapshot boxes come from getBoundingClientRect(), so they are already expressed
 * in CSS viewport pixels. Only the scroll delta since that snapshot should be
 * projected locally while a fresh visual binding request is in flight.
 */
export const projectViewportRect = (
    targetBox: PickRect,
    capturedScroll: ViewportScroll,
    currentScroll: ViewportScroll,
): Rect => ({
    x: targetBox.x - (currentScroll.x - capturedScroll.x),
    y: targetBox.y - (currentScroll.y - capturedScroll.y),
    width: targetBox.width,
    height: targetBox.height,
});

export const computeCenter = (rect: Rect): Point => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
});

export const insetRect = (rect: Rect, inset: number): Rect => ({
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(0, rect.width - inset * 2),
    height: Math.max(0, rect.height - inset * 2),
});

export const unionRect = (boxes: PickRect[]): Rect | null => {
    if (boxes.length === 0) {
        return null;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const box of boxes) {
        if (box.x < minX) {minX = box.x;}
        if (box.y < minY) {minY = box.y;}
        if (box.x + box.width > maxX) {maxX = box.x + box.width;}
        if (box.y + box.height > maxY) {maxY = box.y + box.height;}
    }
    return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
};
