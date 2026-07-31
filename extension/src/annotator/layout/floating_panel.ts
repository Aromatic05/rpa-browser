import type {Rect} from './box_geometry.js';

export type FloatingPanelPlacementInput = {
    target: Rect | null;
    viewport: {width: number; height: number};
    panel: {width: number; height: number};
    margin?: number;
    gap?: number;
};

export type FloatingPanelPosition = {left: number; top: number};

const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(value, max));

const intersectionArea = (a: Rect, b: Rect): number => {
    const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return width * height;
};

export const placeFloatingPanel = (
    input: FloatingPanelPlacementInput,
): FloatingPanelPosition => {
    const margin = input.margin ?? 12;
    const gap = input.gap ?? 12;
    const maxLeft = Math.max(margin, input.viewport.width - input.panel.width - margin);
    const maxTop = Math.max(margin, input.viewport.height - input.panel.height - margin);
    if (!input.target) {
        return {left: maxLeft, top: margin};
    }

    const target = input.target;
    const centeredLeft = target.x + target.width / 2 - input.panel.width / 2;
    const centeredTop = target.y + target.height / 2 - input.panel.height / 2;
    const raw = [
        {left: target.x + target.width + gap, top: centeredTop},
        {left: target.x - input.panel.width - gap, top: centeredTop},
        {left: centeredLeft, top: target.y + target.height + gap},
        {left: centeredLeft, top: target.y - input.panel.height - gap},
    ];

    return raw
        .map((candidate, priority) => {
            const left = clamp(candidate.left, margin, maxLeft);
            const top = clamp(candidate.top, margin, maxTop);
            const rect = {x: left, y: top, width: input.panel.width, height: input.panel.height};
            const overlap = intersectionArea(rect, target);
            const displacement = Math.abs(left - candidate.left) + Math.abs(top - candidate.top);
            return {left, top, score: overlap * 1_000_000 + displacement * 10 + priority};
        })
        .sort((a, b) => a.score - b.score)[0];
};
