import type { BaseControlComponent, ControlCollectContext, ControlIndex, ControlRegistry, ControlRef } from './types';
import { listControlCollectors } from './registry';

export const collectControlComponents = (
    ctx: ControlCollectContext,
    registry: ControlRegistry,
): ControlIndex => {
    const collectors = listControlCollectors(registry);
    const result: Record<string, BaseControlComponent> = {};

    for (const collector of collectors) {
        const components = collector(ctx);
        for (const component of components) {
            const ref = buildControlRef(component.kind, component.rootNodeId);
            if (ref in result) {
                const existing = result[ref];
                throw new Error(
                    `duplicate control ref: ${ref} (kind=${component.kind}, rootNodeId=${component.rootNodeId}, ` +
                    `owner=${component.owner}, existingOwner=${existing.owner})`,
                );
            }
            result[ref] = component;
        }
    }

    return result;
};

export const buildControlRef = (kind: string, rootNodeId: string): ControlRef =>
    `control:${kind}:${rootNodeId}`;

export const buildDomIdToNodeIdMap = (attrIndex: ControlCollectContext['attrIndex']): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const [nodeId, attrs] of Object.entries(attrIndex)) {
        const id = attrs['id'];
        if (id) {
            map[id] = nodeId;
        }
    }
    return map;
};
