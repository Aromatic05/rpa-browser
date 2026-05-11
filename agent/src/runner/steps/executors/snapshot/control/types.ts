import type { UnifiedNode, AttrIndex, ContentStore, LocatorIndex } from '../core/types';

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
    controlNodeId?: string;
    triggerNodeId?: string;
    popupNodeId?: string;
    labelNodeId?: string;
    valueNodeId?: string;
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

export type ControlCollectContext = {
    root: UnifiedNode;
    nodeIndex: Record<string, UnifiedNode>;
    attrIndex: AttrIndex;
    contentStore: ContentStore;
    locatorIndex: LocatorIndex;
};

export type ControlCollector = (ctx: ControlCollectContext) => BaseControlComponent[];

export type ControlRegistry = {
    collectors: ControlCollector[];
};
