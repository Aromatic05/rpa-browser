import type { UnifiedNode } from '../core/types';
import type { BaseControlComponent, ControlIndex, ControlRef } from './types';

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
    ids.push(component.rootNodeId);
    if (component.controlNodeId) {ids.push(component.controlNodeId);}
    if (component.triggerNodeId) {ids.push(component.triggerNodeId);}
    if (component.popupNodeId) {ids.push(component.popupNodeId);}
    if (component.labelNodeId) {ids.push(component.labelNodeId);}
    if (component.valueNodeId) {ids.push(component.valueNodeId);}
    for (const id of component.optionNodeIds) {
        ids.push(id);
    }
    return ids;
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};
