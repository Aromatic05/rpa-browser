import type { UnifiedNode } from '../core/types';

export type ControlKind = string;

export type ControlRef = string;

export type BaseControlComponent = {
    id: string;
    kind: ControlKind;
    owner: string;
    capabilities: string[];
    source: string;
    confidence: number;
    rootNodeId: string;
    controlNodeId: string;
    triggerNodeId: string;
    popupNodeId: string;
    labelNodeId: string;
    valueNodeId: string;
    optionNodeIds: string[];
    state: ControlState;
    data: Record<string, unknown>;
};

export type ControlState = {
    expanded: boolean;
    multiple: boolean;
    disabled: boolean;
    readonly: boolean;
    focused: boolean;
};

export type ControlIndex = Record<string, BaseControlComponent>;

export type ControlCollector = (root: UnifiedNode, nodeIndex: Record<string, UnifiedNode>) => BaseControlComponent[];

export type ControlRegistry = {
    collectors: ControlCollector[];
};
