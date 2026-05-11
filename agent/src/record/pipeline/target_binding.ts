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
    matchedBy:
        | 'locator.direct.query'
        | 'locator.direct.fallback'
        | 'attr.id'
        | 'attr.data-testid'
        | 'hint.role_name'
        | 'candidate.role'
        | 'candidate.label'
        | 'candidate.text'
        | 'candidate.testid'
        | 'candidate.attr'
        | 'candidate.css';
    controlRef: string;
    component: BaseControlComponent;
    componentKind: SelectOptionKind;
    controlRootNodeId: string;
};

const collectMatchedNodeIds = (
    snapshot: SnapshotResult,
    event: RecorderEvent,
): Array<{ nodeId: string; matchedBy: RecordTargetBinding['matchedBy'] }> => {
    const selector = normalize(event.selector);
    const matched: Array<{ nodeId: string; matchedBy: RecordTargetBinding['matchedBy'] }> = [];
    if (selector) {
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
        if (matched.length > 0) {return matched;}
    }

    const roleHint = normalize(event.a11yHint?.role);
    const nameHint = normalize(event.a11yHint?.name || event.a11yHint?.text);
    if (roleHint && nameHint) {
        const roleMatched: string[] = [];
        for (const [nodeId, node] of Object.entries(snapshot.nodeIndex || {})) {
            const nodeRole = normalize(node.role);
            const nodeName = normalize(node.name);
            if (!nodeRole || !nodeName) {continue;}
            if (nodeRole === roleHint && nodeName.includes(nameHint)) {
                roleMatched.push(nodeId);
            }
        }
        if (roleMatched.length === 1) {
            return [{ nodeId: roleMatched[0], matchedBy: 'hint.role_name' }];
        }
    }

    const candidates = Array.isArray(event.locatorCandidates) ? event.locatorCandidates : [];
    for (const candidate of candidates) {
        if (!candidate || typeof candidate.kind !== 'string') {continue;}
        if (candidate.kind === 'role') {
            const roleNeedle = normalize(candidate.role);
            const nameNeedle = normalize(candidate.name || candidate.text);
            if (!roleNeedle || !nameNeedle) {continue;}
            const roleMatched: string[] = [];
            for (const [nodeId, node] of Object.entries(snapshot.nodeIndex || {})) {
                const nodeRole = normalize(node.role);
                const nodeName = normalize(node.name);
                if (!nodeRole || !nodeName) {continue;}
                const nameOk = candidate.exact === true ? nodeName === nameNeedle : nodeName.includes(nameNeedle);
                if (nodeRole === roleNeedle && nameOk) {
                    roleMatched.push(nodeId);
                }
            }
            if (roleMatched.length === 1) {
                return [{ nodeId: roleMatched[0], matchedBy: 'candidate.role' }];
            }
            continue;
        }
        if (candidate.kind === 'label' || candidate.kind === 'text') {
            const textNeedle = normalize(candidate.text || candidate.name);
            if (!textNeedle) {continue;}
            const textMatched: string[] = [];
            for (const [nodeId, node] of Object.entries(snapshot.nodeIndex || {})) {
                const nodeName = normalize(node.name);
                if (!nodeName) {continue;}
                const nameOk = candidate.exact === true ? nodeName === textNeedle : nodeName.includes(textNeedle);
                if (nameOk) {
                    textMatched.push(nodeId);
                }
            }
            if (textMatched.length === 1) {
                return [{ nodeId: textMatched[0], matchedBy: candidate.kind === 'label' ? 'candidate.label' : 'candidate.text' }];
            }
            continue;
        }
        if (candidate.kind === 'testid') {
            const testIdNeedle = normalize(candidate.testId);
            if (!testIdNeedle) {continue;}
            const testIdMatched: string[] = [];
            for (const [nodeId, attrs] of Object.entries(snapshot.attrIndex || {})) {
                if (normalize(attrs['data-testid']) === testIdNeedle) {
                    testIdMatched.push(nodeId);
                }
            }
            if (testIdMatched.length === 1) {
                return [{ nodeId: testIdMatched[0], matchedBy: 'candidate.testid' }];
            }
            continue;
        }
        if (candidate.kind === 'css' && candidate.selector) {
            const css = normalize(candidate.selector);
            if (!css) {continue;}
            const attrMatch = css.match(/^\[([^=\]]+)=\"([^\"]+)\"\]$/);
            if (attrMatch) {
                const attrName = normalize(attrMatch[1]);
                const attrValue = normalize(attrMatch[2]);
                if (!attrName || !attrValue) {continue;}
                const attrMatched: string[] = [];
                for (const [nodeId, attrs] of Object.entries(snapshot.attrIndex || {})) {
                    if (normalize(attrs[attrName]) === attrValue) {
                        attrMatched.push(nodeId);
                    }
                }
                if (attrMatched.length === 1) {
                    return [{ nodeId: attrMatched[0], matchedBy: 'candidate.attr' }];
                }
                continue;
            }
            const cssMatched: string[] = [];
            for (const [nodeId, locator] of Object.entries(snapshot.locatorIndex || {})) {
                if (selectorEquals(locator.direct?.query, css) || selectorEquals(locator.direct?.fallback, css)) {
                    cssMatched.push(nodeId);
                }
            }
            if (cssMatched.length === 1) {
                return [{ nodeId: cssMatched[0], matchedBy: 'candidate.css' }];
            }
        }
    }

    return [];
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
    forceFreshSnapshot?: boolean;
}): Promise<RecordTargetBinding | undefined> => {
    const recordLog = getLogger('record');
    recordLog('record_target_binding_start', {
        eventType: input.event.type,
        selector: input.event.selector,
    });
    const selector = normalize(input.event.selector);
    if (!selector && !normalize(input.event.a11yHint?.role)) {
        recordLog('record_target_binding_result', { result: 'no_selector' });
        return undefined;
    }
    const snapshot = await snapshotResolver({
        ...input,
        forceFresh: input.forceFreshSnapshot,
    });
    if (!snapshot) {
        recordLog('record_target_binding_result', {
            result: 'no_snapshot',
            selector,
        });
        return undefined;
    }

    const matched = collectMatchedNodeIds(snapshot, input.event);
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
