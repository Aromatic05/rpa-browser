import type { UnifiedNode } from '../core/types';
import type { BaseControlComponent, ControlIndex, ControlRegistry, ControlRef } from './types';
import { listControlCollectors } from './registry';

export const collectControlComponents = (
    root: UnifiedNode,
    nodeIndex: Record<string, UnifiedNode>,
    registry: ControlRegistry,
): ControlIndex => {
    const collectors = listControlCollectors(registry);
    const result: Record<string, BaseControlComponent> = {};
    const seenRefs = new Set<ControlRef>();

    for (const collector of collectors) {
        const components = collector(root, nodeIndex);
        for (const component of components) {
            const ref = buildControlRef(component.kind, component.rootNodeId);
            if (seenRefs.has(ref)) {
                continue;
            }
            seenRefs.add(ref);
            result[ref] = component;
        }
    }

    return result;
};

export const buildControlRef = (kind: string, rootNodeId: string): ControlRef =>
    `control:${kind}:${rootNodeId}`;
