import type { PickRect } from '../types.js';

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type ViewportScroll = { x: number; y: number };

export const computeBoxRect = (
    targetBox: PickRect,
    scroll: ViewportScroll,
    viewportZoom: number,
): Rect => ({
    x: (targetBox.x - scroll.x) * viewportZoom,
    y: (targetBox.y - scroll.y) * viewportZoom,
    width: targetBox.width * viewportZoom,
    height: targetBox.height * viewportZoom,
});

export const computeCenter = (rect: Rect): Point => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
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
