import type { PickRect } from '../types.js';
import type { Point, Rect } from './box_geometry.js';

export type LabelSide = 'left' | 'right';

export type LabelPlacement = {
    side: LabelSide;
    box: Rect;
    polyline: Point[];
};

export type LabelTarget = {
    annotationId: string;
    targetCenter: Point;
    targetBox: PickRect;
};

export type ViewportSize = {
    width: number;
    height: number;
};

export type LabelLayoutOptions = {
    margin?: number;
    labelWidth?: number;
    labelHeight?: number;
    gap?: number;
};

const DEFAULT_MARGIN = 16;
const DEFAULT_LABEL_WIDTH = 180;
const DEFAULT_LABEL_HEIGHT = 28;
const DEFAULT_GAP = 8;

type Placed = {y: number; height: number};

const findNonOverlappingY = (
    stack: Placed[],
    idealY: number,
    labelHeight: number,
    gap: number,
): number => {
    const sorted = [...stack].sort((a, b) => a.y - b.y);
    let y = Math.max(0, idealY);
    for (const placed of sorted) {
        if (y + labelHeight + gap <= placed.y) {
            break;
        }
        if (y >= placed.y + placed.height + gap) {
            continue;
        }
        y = placed.y + placed.height + gap;
    }
    return y;
};

const findNonOverlappingYUpward = (
    stack: Placed[],
    idealY: number,
    labelHeight: number,
    gap: number,
    viewportHeight: number,
): number | null => {
    const maxY = Math.max(0, viewportHeight - labelHeight);
    const sorted = [...stack].sort((a, b) => b.y - a.y);
    let y = Math.min(maxY, Math.max(0, idealY));
    for (const placed of sorted) {
        if (y >= placed.y + placed.height + gap) {
            break;
        }
        if (y + labelHeight + gap <= placed.y) {
            continue;
        }
        y = placed.y - gap - labelHeight;
    }
    if (y < 0) {return null;}
    const overlaps = stack.some((placed) =>
        y < placed.y + placed.height + gap && y + labelHeight + gap > placed.y,
    );
    return overlaps ? null : y;
};

const buildPolyline = (
    targetCenter: Point,
    labelBox: Rect,
    side: LabelSide,
): Point[] => {
    const labelCenterY = labelBox.y + labelBox.height / 2;
    const dx = side === 'right' ? 24 : -24;
    const labelEdgeX = side === 'right' ? labelBox.x : labelBox.x + labelBox.width;
    return [
        {x: targetCenter.x, y: targetCenter.y},
        {x: targetCenter.x + dx, y: labelCenterY},
        {x: labelEdgeX, y: labelCenterY},
    ];
};

const attemptSide = (
    stack: Placed[],
    idealY: number,
    x: number,
    labelWidth: number,
    labelHeight: number,
    gap: number,
    viewportHeight: number,
): {box: Rect; fits: boolean} => {
    const maxY = viewportHeight > 0 ? Math.max(0, viewportHeight - labelHeight) : Number.POSITIVE_INFINITY;
    const clampedIdeal = Math.min(maxY, Math.max(0, idealY));
    const downwardY = findNonOverlappingY(stack, clampedIdeal, labelHeight, gap);
    if (viewportHeight <= 0 || downwardY + labelHeight <= viewportHeight) {
        return {box: {x, y: downwardY, width: labelWidth, height: labelHeight}, fits: true};
    }
    const upwardY = findNonOverlappingYUpward(
        stack,
        clampedIdeal,
        labelHeight,
        gap,
        viewportHeight,
    );
    const y = upwardY ?? downwardY;
    return {
        box: {x, y, width: labelWidth, height: labelHeight},
        fits: upwardY !== null,
    };
};

export const computeLabelPlacements = (
    targets: LabelTarget[],
    viewport: ViewportSize,
    options: LabelLayoutOptions = {},
): Record<string, LabelPlacement> => {
    const margin = options.margin ?? DEFAULT_MARGIN;
    const labelWidth = options.labelWidth ?? DEFAULT_LABEL_WIDTH;
    const labelHeight = options.labelHeight ?? DEFAULT_LABEL_HEIGHT;
    const gap = options.gap ?? DEFAULT_GAP;

    const sorted = [...targets].sort((a, b) => a.targetCenter.y - b.targetCenter.y);
    const placements: Record<string, LabelPlacement> = {};
    const rightStack: Placed[] = [];
    const leftStack: Placed[] = [];

    for (const target of sorted) {
        const idealY = target.targetCenter.y - labelHeight / 2;

        const rightX = viewport.width - margin - labelWidth;
        const rightAttempt = attemptSide(
            rightStack,
            idealY,
            rightX,
            labelWidth,
            labelHeight,
            gap,
            viewport.height,
        );

        let chosen: {box: Rect; side: LabelSide};
        if (rightAttempt.fits) {
            chosen = {box: rightAttempt.box, side: 'right'};
            rightStack.push({y: rightAttempt.box.y, height: labelHeight});
        } else {
            const leftX = margin;
            const leftAttempt = attemptSide(
                leftStack,
                idealY,
                leftX,
                labelWidth,
                labelHeight,
                gap,
                viewport.height,
            );
            if (leftAttempt.fits) {
                chosen = {box: leftAttempt.box, side: 'left'};
                leftStack.push({y: leftAttempt.box.y, height: labelHeight});
            } else {
                if (leftAttempt.box.y < rightAttempt.box.y) {
                    chosen = {box: leftAttempt.box, side: 'left'};
                    leftStack.push({y: leftAttempt.box.y, height: labelHeight});
                } else {
                    chosen = {box: rightAttempt.box, side: 'right'};
                    rightStack.push({y: rightAttempt.box.y, height: labelHeight});
                }
            }
        }

        placements[target.annotationId] = {
            side: chosen.side,
            box: chosen.box,
            polyline: buildPolyline(target.targetCenter, chosen.box, chosen.side),
        };
    }

    return placements;
};
