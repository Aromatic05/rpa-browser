import type {AnnotatorAnchor, AnnotatorPoint} from './contracts';
import {createObservationAnchor} from '../observation/model/anchor';
import type {ObservationNodeId} from '../observation/model/contracts';
import type {PageSnapshotSessionEntry} from '../session/contracts';

export type AnnotatorPointResolution =
    | {status: 'resolved'; nodeId: ObservationNodeId; anchor: AnnotatorAnchor}
    | {status: 'ambiguous'; candidateNodeIds: ObservationNodeId[]}
    | {status: 'not_found'};

export const resolveAnnotatorPoint = (
    entry: PageSnapshotSessionEntry,
    point: AnnotatorPoint,
): AnnotatorPointResolution => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {return {status: 'not_found'};}
    const observation = entry.capture.control.observation;
    const candidates = Object.keys(observation.nodes)
        .filter((nodeId) => isActive(entry, nodeId))
        .flatMap((nodeId) => {
            const records = observation.geometry[nodeId] ?? [];
            const topCss = records.filter((record) => record.space === 'top-css-viewport');
            const matching = (topCss.length > 0 ? topCss : records)
                .filter((record) => contains(record.rect, point));
            if (matching.length === 0) {return [];}
            const area = Math.min(...matching.map((record) => record.rect.width * record.rect.height));
            return [{nodeId, area, depth: nodeDepth(entry, nodeId)}];
        })
        .sort((left, right) => right.depth - left.depth
            || left.area - right.area
            || (observation.documentOrder[right.nodeId] ?? 0) - (observation.documentOrder[left.nodeId] ?? 0));
    if (candidates.length === 0) {return {status: 'not_found'};}
    const best = candidates[0];
    const tied = candidates.filter((candidate) => candidate.depth === best.depth && candidate.area === best.area);
    if (tied.length > 1) {
        return {status: 'ambiguous', candidateNodeIds: tied.map((candidate) => candidate.nodeId)};
    }
    const anchor = createObservationAnchor(observation, best.nodeId);
    return anchor
        ? {status: 'resolved', nodeId: best.nodeId, anchor}
        : {status: 'not_found'};
};

const isActive = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): boolean => {
    const activity = entry.capture.control.observation.activity[nodeId];
    return activity.rendered
        && !activity.hiddenByStyle
        && !activity.inert
        && activity.subtreeActive
        && activity.ariaExposed !== false;
};

const contains = (
    rect: {x: number; y: number; width: number; height: number},
    point: AnnotatorPoint,
): boolean => rect.width > 0
    && rect.height > 0
    && point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;

const nodeDepth = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): number => {
    const parents = entry.capture.control.observation.parents;
    let depth = 0;
    let current = parents[nodeId];
    const visited = new Set<ObservationNodeId>();
    while (current && !visited.has(current)) {
        visited.add(current);
        depth += 1;
        current = parents[current];
    }
    return depth;
};
