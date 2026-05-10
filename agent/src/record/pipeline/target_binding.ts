import type { Page } from 'playwright';
import { getLogger } from '../../logging/logger';
import type { BaseControlComponent } from '../../runner/steps/executors/snapshot/control/types';
import type { SnapshotResult } from '../../runner/steps/executors/snapshot/core/types';
import type { RecorderEvent } from '../capture/recorder';
import type { RecordSnapshotCacheEntry } from './snapshot';
import { resolveRecordSnapshotForEvent } from './snapshot';

type SelectOptionKind = 'native_select' | 'radio_group' | 'checkbox_group' | 'custom_select';

const SUPPORTED_KINDS: ReadonlySet<string> = new Set([
    'native_select',
    'radio_group',
    'checkbox_group',
    'custom_select',
]);

const normalize = (value: string | undefined): string => (value || '').trim();
type SnapshotResolver = typeof resolveRecordSnapshotForEvent;
let snapshotResolver: SnapshotResolver = resolveRecordSnapshotForEvent;

export const setRecordTargetSnapshotResolverForTest = (resolver: SnapshotResolver | null): void => {
    snapshotResolver = resolver || resolveRecordSnapshotForEvent;
};

const selectorEquals = (left: string | undefined, right: string | undefined): boolean => {
    const a = normalize(left);
    const b = normalize(right);
    if (!a || !b) {return false;}
    return a === b;
};

const isSelectOptionComponent = (component: BaseControlComponent): boolean => {
    return component.owner === 'browser.select_option'
        && Array.isArray(component.capabilities)
        && component.capabilities.includes('select_option')
        && SUPPORTED_KINDS.has(component.kind);
};

const readComponentKind = (component: BaseControlComponent): SelectOptionKind | undefined => {
    if (!SUPPORTED_KINDS.has(component.kind)) {return undefined;}
    return component.kind as SelectOptionKind;
};

export type RecordTargetBinding = {
    snapshot: SnapshotResult;
    snapshotId?: string;
    targetNodeId: string;
    matchedBy: 'locator.direct.query' | 'locator.direct.fallback' | 'attr.id' | 'attr.data-testid';
    controlRef: string;
    component: BaseControlComponent;
    componentKind: SelectOptionKind;
    controlRootNodeId: string;
};

const collectMatchedNodeIds = (
    snapshot: SnapshotResult,
    selector: string,
): Array<{ nodeId: string; matchedBy: RecordTargetBinding['matchedBy'] }> => {
    const matched: Array<{ nodeId: string; matchedBy: RecordTargetBinding['matchedBy'] }> = [];
    for (const [nodeId, locator] of Object.entries(snapshot.locatorIndex || {})) {
        if (selectorEquals(locator.direct?.query, selector)) {
            matched.push({ nodeId, matchedBy: 'locator.direct.query' });
        }
    }
    if (matched.length > 0) {return matched;}

    for (const [nodeId, locator] of Object.entries(snapshot.locatorIndex || {})) {
        if (selectorEquals(locator.direct?.fallback, selector)) {
            matched.push({ nodeId, matchedBy: 'locator.direct.fallback' });
        }
    }
    if (matched.length > 0) {return matched;}

    for (const [nodeId, attrs] of Object.entries(snapshot.attrIndex || {})) {
        const idValue = normalize(attrs.id);
        if (!idValue) {continue;}
        if (selectorEquals(`#${idValue}`, selector)) {
            matched.push({ nodeId, matchedBy: 'attr.id' });
        }
    }
    if (matched.length > 0) {return matched;}

    for (const [nodeId, attrs] of Object.entries(snapshot.attrIndex || {})) {
        const testId = normalize(attrs['data-testid']);
        if (!testId) {continue;}
        if (selectorEquals(`[data-testid="${testId}"]`, selector)) {
            matched.push({ nodeId, matchedBy: 'attr.data-testid' });
        }
    }
    return matched;
};

export const findControlByNodeId = (
    snapshot: SnapshotResult,
    targetNodeId: string,
): { controlRef: string; component: BaseControlComponent; componentKind: SelectOptionKind; controlRootNodeId: string } | undefined => {
    for (const [controlRef, component] of Object.entries(snapshot.controlIndex || {})) {
        if (!isSelectOptionComponent(component)) {continue;}
        const kind = readComponentKind(component);
        if (!kind) {continue;}
        if (component.rootNodeId === targetNodeId
            || component.controlNodeId === targetNodeId
            || component.triggerNodeId === targetNodeId
            || component.optionNodeIds.includes(targetNodeId)) {
            return {
                controlRef,
                component,
                componentKind: kind,
                controlRootNodeId: component.rootNodeId,
            };
        }
    }
    return undefined;
};

type ControlOption = {
    nodeId: string;
    value?: string;
    label?: string;
    text?: string;
    selected?: boolean;
};

const readControlOptions = (component: BaseControlComponent): ControlOption[] => {
    const rawOptions = component.data?.options;
    if (!Array.isArray(rawOptions)) {return [];}
    const options: ControlOption[] = [];
    for (const item of rawOptions) {
        if (!item || typeof item !== 'object') {continue;}
        const entry = item as Record<string, unknown>;
        if (typeof entry.nodeId !== 'string') {continue;}
        options.push({
            nodeId: entry.nodeId,
            value: typeof entry.value === 'string' ? entry.value : undefined,
            label: typeof entry.label === 'string' ? entry.label : undefined,
            text: typeof entry.text === 'string' ? entry.text : undefined,
            selected: typeof entry.selected === 'boolean' ? entry.selected : undefined,
        });
    }
    return options;
};

export const readOptionRecordedValue = (option: {
    value?: string;
    label?: string;
    text?: string;
}): string | undefined => {
    const fromValue = normalize(option.value);
    if (fromValue) {return fromValue;}
    const fromLabel = normalize(option.label);
    if (fromLabel) {return fromLabel;}
    const fromText = normalize(option.text);
    if (fromText) {return fromText;}
    return undefined;
};

export const readControlOptionByNodeId = (
    component: BaseControlComponent,
    nodeId: string,
): ControlOption | undefined => {
    return readControlOptions(component).find((option) => option.nodeId === nodeId);
};

export const readSelectedValuesFromControl = (component: BaseControlComponent): string[] => {
    const values: string[] = [];
    for (const option of readControlOptions(component)) {
        if (option.selected !== true) {continue;}
        const value = readOptionRecordedValue(option);
        if (!value) {continue;}
        values.push(value);
    }
    return values;
};

export const resolveRecordTargetBinding = async (input: {
    event: RecorderEvent;
    page?: Page;
    snapshotCache: Map<string, RecordSnapshotCacheEntry>;
    cacheKey: string;
}): Promise<RecordTargetBinding | undefined> => {
    const recordLog = getLogger('record');
    recordLog('record_target_binding_start', {
        eventType: input.event.type,
        selector: input.event.selector,
    });
    const selector = normalize(input.event.selector);
    if (!selector) {
        recordLog('record_target_binding_result', { result: 'no_selector' });
        return undefined;
    }
    const snapshot = await snapshotResolver(input);
    if (!snapshot) {
        recordLog('record_target_binding_result', {
            result: 'no_snapshot',
            selector,
        });
        return undefined;
    }

    const matched = collectMatchedNodeIds(snapshot, selector);
    if (matched.length === 0) {
        recordLog('record_target_binding_result', {
            result: 'no_node',
            selector,
            matchedNodeCount: 0,
        });
        return undefined;
    }
    if (matched.length !== 1) {
        recordLog('record_target_binding_result', {
            result: 'ambiguous_node',
            selector,
            matchedBy: matched[0]?.matchedBy,
            matchedNodeCount: matched.length,
        });
        return undefined;
    }

    const targetNodeId = matched[0].nodeId;
    const nodeControlRef = snapshot.nodeIndex[targetNodeId]?.control?.ref;

    if (nodeControlRef) {
        const component = snapshot.controlIndex[nodeControlRef];
        const kind = component ? readComponentKind(component) : undefined;
        if (!component) {
            recordLog('record_target_binding_result', {
                result: 'no_control',
                selector,
                matchedBy: matched[0].matchedBy,
                matchedNodeCount: matched.length,
                targetNodeId,
                controlRef: nodeControlRef,
            });
            return undefined;
        }
        if (component.owner !== 'browser.select_option') {
            recordLog('record_target_binding_result', {
                result: 'invalid_owner',
                selector,
                matchedBy: matched[0].matchedBy,
                matchedNodeCount: matched.length,
                targetNodeId,
                controlRef: nodeControlRef,
            });
            return undefined;
        }
        if (!component.capabilities.includes('select_option')) {
            recordLog('record_target_binding_result', {
                result: 'invalid_capability',
                selector,
                matchedBy: matched[0].matchedBy,
                matchedNodeCount: matched.length,
                targetNodeId,
                controlRef: nodeControlRef,
            });
            return undefined;
        }
        if (!kind) {
            recordLog('record_target_binding_result', {
                result: 'unsupported_kind',
                selector,
                matchedBy: matched[0].matchedBy,
                matchedNodeCount: matched.length,
                targetNodeId,
                controlRef: nodeControlRef,
            });
            return undefined;
        }
        if (isSelectOptionComponent(component)) {
            recordLog('record_target_binding_result', {
                result: 'bound',
                selector,
                matchedBy: matched[0].matchedBy,
                matchedNodeCount: matched.length,
                targetNodeId,
                controlRef: nodeControlRef,
                componentKind: kind,
                controlRootNodeId: component.rootNodeId,
            });
            return {
                snapshot,
                snapshotId: snapshot.snapshotMeta?.snapshotId,
                targetNodeId,
                matchedBy: matched[0].matchedBy,
                controlRef: nodeControlRef,
                component,
                componentKind: kind,
                controlRootNodeId: component.rootNodeId,
            };
        }
    }

    const byNode = findControlByNodeId(snapshot, targetNodeId);
    if (!byNode) {
        recordLog('record_target_binding_result', {
            result: 'no_control',
            selector,
            matchedBy: matched[0].matchedBy,
            matchedNodeCount: matched.length,
            targetNodeId,
        });
        return undefined;
    }

    recordLog('record_target_binding_result', {
        result: 'bound',
        selector,
        matchedBy: matched[0].matchedBy,
        matchedNodeCount: matched.length,
        targetNodeId,
        controlRef: byNode.controlRef,
        componentKind: byNode.componentKind,
        controlRootNodeId: byNode.controlRootNodeId,
    });

    return {
        snapshot,
        snapshotId: snapshot.snapshotMeta?.snapshotId,
        targetNodeId,
        matchedBy: matched[0].matchedBy,
        controlRef: byNode.controlRef,
        component: byNode.component,
        componentKind: byNode.componentKind,
        controlRootNodeId: byNode.controlRootNodeId,
    };
};
