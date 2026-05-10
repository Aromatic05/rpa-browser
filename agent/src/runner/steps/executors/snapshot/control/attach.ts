import type { UnifiedNode } from '../core/types';
import type { BaseControlComponent, ControlIndex, ControlRef } from './types';
import { buildControlRef } from './collect';

export const attachControlRefsToNodes = (
    root: UnifiedNode,
    controlIndex: ControlIndex,
): void => {
    const refByNodeId = new Map<string, ControlRef>();

    for (const [ref, component] of Object.entries(controlIndex)) {
        const nodeIds = collectComponentNodeIds(component);
        for (const nodeId of nodeIds) {
            if (!refByNodeId.has(nodeId)) {
                refByNodeId.set(nodeId, ref);
            }
        }
    }

    walk(root, (node) => {
        const ref = refByNodeId.get(node.id);
        if (ref) {
            const component = controlIndex[ref];
            node.control = { kind: component.kind, ref };
        }
    });
};

const collectComponentNodeIds = (component: BaseControlComponent): string[] => {
    const ids: string[] = [];
    const fields: (string | string[])[] = [
        component.rootNodeId,
        component.controlNodeId,
        component.triggerNodeId,
        component.popupNodeId,
        component.labelNodeId,
        component.valueNodeId,
        component.optionNodeIds,
    ];
    for (const field of fields) {
        if (Array.isArray(field)) {
            for (const id of field) {
                if (id) {ids.push(id);}
            }
        } else if (field) {
            ids.push(field);
        }
    }
    return ids;
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};
