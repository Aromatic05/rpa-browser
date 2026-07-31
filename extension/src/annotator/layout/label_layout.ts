import type { PickRect } from '../types.js';
import type { Point, Rect } from './box_geometry.js';

export type LabelKind = 'entity' | 'field' | 'action' | 'column' | 'pagination';
export type LabelSide = 'top' | 'bottom' | 'left' | 'right';

export type LabelPlacement = {
    side: LabelSide;
    box: Rect;
    polyline: Point[];
};

export type LabelTarget = {
    annotationId: string;
    kind: LabelKind;
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

const rectsOverlap = (a: Rect, b: Rect, gap = 0): boolean =>
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y;

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

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
    target: LabelTarget,
    labelBox: Rect,
    side: LabelSide,
): Point[] => {
    const targetLeft = target.targetBox.x;
    const targetRight = target.targetBox.x + target.targetBox.width;
    const targetTop = target.targetBox.y;
    const targetBottom = target.targetBox.y + target.targetBox.height;
    const targetCenterX = target.targetBox.x + target.targetBox.width / 2;
    const targetCenterY = target.targetBox.y + target.targetBox.height / 2;
    const labelCenterX = labelBox.x + labelBox.width / 2;
    const labelCenterY = labelBox.y + labelBox.height / 2;

    if (side === 'top') {
        const middleY = targetTop - Math.max(8, (targetTop - (labelBox.y + labelBox.height)) / 2);
        return [
            {x: targetCenterX, y: targetTop},
            {x: targetCenterX, y: middleY},
            {x: labelCenterX, y: labelBox.y + labelBox.height},
        ];
    }
    if (side === 'bottom') {
        const middleY = targetBottom + Math.max(8, (labelBox.y - targetBottom) / 2);
        return [
            {x: targetCenterX, y: targetBottom},
            {x: targetCenterX, y: middleY},
            {x: labelCenterX, y: labelBox.y},
        ];
    }
    if (side === 'left') {
        return [
            {x: targetLeft, y: targetCenterY},
            {x: targetLeft - 24, y: labelCenterY},
            {x: labelBox.x + labelBox.width, y: labelCenterY},
        ];
    }
    return [
        {x: targetRight, y: targetCenterY},
        {x: targetRight + 24, y: labelCenterY},
        {x: labelBox.x, y: labelCenterY},
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

const attemptVertical = (
    target: LabelTarget,
    side: 'top' | 'bottom',
    placed: Rect[],
    viewport: ViewportSize,
    margin: number,
    labelWidth: number,
    labelHeight: number,
    gap: number,
): Rect | null => {
    const maxX = Math.max(margin, viewport.width - margin - labelWidth);
    const x = clamp(target.targetCenter.x - labelWidth / 2, margin, maxX);
    let y = side === 'top'
        ? target.targetBox.y - gap - labelHeight
        : target.targetBox.y + target.targetBox.height + gap;
    const step = labelHeight + gap;

    while (true) {
        const candidate = {x, y, width: labelWidth, height: labelHeight};
        if (candidate.y < margin || candidate.y + candidate.height > viewport.height - margin) {
            return null;
        }
        if (!placed.some((box) => rectsOverlap(candidate, box, gap))) {
            return candidate;
        }
        y += side === 'top' ? -step : step;
    }
};

const preferredVerticalSides = (kind: LabelKind): Array<'top' | 'bottom'> => {
    if (kind === 'column') {return ['top', 'bottom'];}
    if (kind === 'pagination') {return ['bottom', 'top'];}
    return [];
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

    const sorted = [...targets].sort((a, b) => {
        if (a.kind === 'column' && b.kind !== 'column') {return -1;}
        if (a.kind !== 'column' && b.kind === 'column') {return 1;}
        if (a.kind === 'column' && b.kind === 'column') {
            return a.targetCenter.x - b.targetCenter.x;
        }
        return a.targetCenter.y - b.targetCenter.y;
    });
    const placements: Record<string, LabelPlacement> = {};
    const rightStack: Placed[] = [];
    const leftStack: Placed[] = [];
    const placedBoxes: Rect[] = [];

    for (const target of sorted) {
        let chosen: {box: Rect; side: LabelSide} | null = null;
        const verticalLabelWidth = target.kind === 'column'
            ? clamp(target.targetBox.width - gap, 88, labelWidth)
            : labelWidth;

        for (const side of preferredVerticalSides(target.kind)) {
            const box = attemptVertical(
                target,
                side,
                placedBoxes,
                viewport,
                margin,
                verticalLabelWidth,
                labelHeight,
                gap,
            );
            if (box) {
                chosen = {box, side};
                break;
            }
        }

        if (!chosen) {
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
                } else if (leftAttempt.box.y < rightAttempt.box.y) {
                    chosen = {box: leftAttempt.box, side: 'left'};
                    leftStack.push({y: leftAttempt.box.y, height: labelHeight});
                } else {
                    chosen = {box: rightAttempt.box, side: 'right'};
                    rightStack.push({y: rightAttempt.box.y, height: labelHeight});
                }
            }
        }

        placedBoxes.push(chosen.box);
        placements[target.annotationId] = {
            side: chosen.side,
            box: chosen.box,
            polyline: buildPolyline(target, chosen.box, chosen.side),
        };
    }

    return placements;
};
