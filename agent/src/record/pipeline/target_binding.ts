import type {Page} from 'playwright';
import {getLogger} from '../../logging/logger';
import {
    resolveSemanticRole,
    type CanonicalLocator,
    type ControlComponent,
    type ControlOption,
    type ObservationNodeId,
} from '../../snapshot';
import type {RecorderEvent} from '../capture/recorder';
import {
    recordSnapshotId,
    resolveRecordSnapshotForEvent,
    type RecordPageSnapshot,
    type RecordSnapshotCacheEntry,
} from './snapshot';

export type SelectOptionKind = 'native_select' | 'radio_group' | 'checkbox_group' | 'custom_select';

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
    return Boolean(a && b && a === b);
};

const isSelectOptionComponent = (component: ControlComponent): component is ControlComponent & {kind: SelectOptionKind} =>
    SUPPORTED_KINDS.has(component.kind) && component.capabilities.includes('select_option');

export type RecordTargetBinding = {
    snapshot: RecordPageSnapshot;
    snapshotId: string;
    targetNodeId: ObservationNodeId;
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
    component: ControlComponent & {kind: SelectOptionKind};
    componentKind: SelectOptionKind;
    controlRootNodeId: ObservationNodeId;
};

type MatchedNode = {nodeId: ObservationNodeId; matchedBy: RecordTargetBinding['matchedBy']};

const orderedNodeIds = (snapshot: RecordPageSnapshot): ObservationNodeId[] => {
    const observation = snapshot.control.observation;
    return Object.keys(observation.nodes).sort((left, right) =>
        (observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
        - (observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER));
};

const nodeRole = (snapshot: RecordPageSnapshot, nodeId: ObservationNodeId): string =>
    normalize(resolveSemanticRole(snapshot.control.observation, nodeId).value);

const nodeName = (snapshot: RecordPageSnapshot, nodeId: ObservationNodeId): string => {
    const observation = snapshot.control.observation;
    return normalize(
        new Map(Object.entries(observation.accessibility)).get(nodeId)?.name
        || new Map(Object.entries(observation.attributes)).get(nodeId)?.['aria-label']
        || observation.text[nodeId],
    );
};

const locatorSelectors = (snapshot: RecordPageSnapshot, nodeId: ObservationNodeId): string[] => {
    const index = snapshot.control.locators;
    const locators = new Map(Object.entries(index.locators));
    return (index.byNodeId[nodeId] ?? [])
        .map((locatorId) => locators.get(locatorId))
        .filter((locator): locator is CanonicalLocator =>
            locator?.status === 'resolved' && typeof locator.selector === 'string' && locator.selector.length > 0)
        .map((locator) => locator.selector as string);
};

const matchUnique = (
    nodeIds: readonly ObservationNodeId[],
    matchedBy: RecordTargetBinding['matchedBy'],
): MatchedNode[] => nodeIds.map((nodeId) => ({nodeId, matchedBy}));

const matchByRoleAndName = (
    snapshot: RecordPageSnapshot,
    role: string,
    name: string,
    exact: boolean,
): ObservationNodeId[] => orderedNodeIds(snapshot).filter((nodeId) => {
    const candidateRole = nodeRole(snapshot, nodeId);
    const candidateName = nodeName(snapshot, nodeId);
    if (candidateRole !== role || !candidateName) {return false;}
    return exact ? candidateName === name : candidateName.includes(name);
});

const matchByText = (
    snapshot: RecordPageSnapshot,
    text: string,
    role: string,
    exact: boolean,
): ObservationNodeId[] => orderedNodeIds(snapshot).filter((nodeId) => {
    if (role && nodeRole(snapshot, nodeId) !== role) {return false;}
    const candidate = nodeName(snapshot, nodeId);
    return exact ? candidate === text : candidate.includes(text);
});

const collectMatchedNodeIds = (
    snapshot: RecordPageSnapshot,
    event: RecorderEvent,
): MatchedNode[] => {
    const observation = snapshot.control.observation;
    const selector = normalize(event.selector);
    if (selector) {
        const locatorMatches = orderedNodeIds(snapshot)
            .filter((nodeId) => locatorSelectors(snapshot, nodeId).some((candidate) => selectorEquals(candidate, selector)));
        if (locatorMatches.length > 0) {return matchUnique(locatorMatches, 'locator.direct.query');}

        const idMatches = orderedNodeIds(snapshot).filter((nodeId) => {
            const id = normalize(new Map(Object.entries(observation.attributes)).get(nodeId)?.id);
            return Boolean(id && (selectorEquals(`#${id}`, selector) || selectorEquals(`[id="${id}"]`, selector)));
        });
        if (idMatches.length > 0) {return matchUnique(idMatches, 'attr.id');}

        const testIdMatches = orderedNodeIds(snapshot).filter((nodeId) => {
            const testId = normalize(new Map(Object.entries(observation.attributes)).get(nodeId)?.['data-testid']);
            return Boolean(testId && selectorEquals(`[data-testid="${testId}"]`, selector));
        });
        if (testIdMatches.length > 0) {return matchUnique(testIdMatches, 'attr.data-testid');}
    }

    const candidates = event.locatorCandidates ?? [];
    const roleHint = normalize(event.a11yHint?.role)
        || normalize(candidates.find((candidate) => candidate.kind === 'role')?.role);
    const nameHint = normalize(event.a11yHint?.name || event.a11yHint?.text);
    if (roleHint && nameHint) {
        const matches = matchByRoleAndName(snapshot, roleHint, nameHint, false);
        if (matches.length === 1) {return matchUnique(matches, 'hint.role_name');}
    }

    for (const candidate of candidates) {
        if (candidate.kind === 'role') {
            const role = normalize(candidate.role);
            const name = normalize(candidate.name || candidate.text);
            if (!role || !name) {continue;}
            const matches = matchByRoleAndName(snapshot, role, name, candidate.exact === true);
            if (matches.length === 1) {return matchUnique(matches, 'candidate.role');}
            continue;
        }
        if (candidate.kind === 'label' || candidate.kind === 'text') {
            const text = normalize(candidate.text || candidate.name);
            if (!text) {continue;}
            const matches = matchByText(snapshot, text, roleHint, candidate.exact === true);
            if (matches.length === 1) {
                return matchUnique(matches, candidate.kind === 'label' ? 'candidate.label' : 'candidate.text');
            }
            continue;
        }
        if (candidate.kind === 'testid') {
            const testId = normalize(candidate.testId);
            if (!testId) {continue;}
            const matches = orderedNodeIds(snapshot)
                .filter((nodeId) => normalize(
                    new Map(Object.entries(observation.attributes)).get(nodeId)?.['data-testid'],
                ) === testId);
            if (matches.length === 1) {return matchUnique(matches, 'candidate.testid');}
            continue;
        }
        if (candidate.kind === 'css') {
            const css = normalize(candidate.selector);
            if (!css) {continue;}
            const locatorMatches = orderedNodeIds(snapshot)
                .filter((nodeId) => locatorSelectors(snapshot, nodeId).some((selectorValue) => selectorEquals(selectorValue, css)));
            if (locatorMatches.length === 1) {return matchUnique(locatorMatches, 'candidate.css');}
            const attributeMatch = css.match(/^\[([^=\]]+)=["'](.+)["']\]$/);
            if (!attributeMatch) {continue;}
            const [, name, value] = attributeMatch;
            const attrMatches = orderedNodeIds(snapshot)
                .filter((nodeId) => normalize(
                    new Map(Object.entries(observation.attributes)).get(nodeId)?.[name],
                ) === normalize(value));
            if (attrMatches.length === 1) {return matchUnique(attrMatches, 'candidate.attr');}
        }
    }
    return [];
};

export const findControlByNodeId = (
    snapshot: RecordPageSnapshot,
    targetNodeId: ObservationNodeId,
): {
    controlRef: string;
    component: ControlComponent & {kind: SelectOptionKind};
    componentKind: SelectOptionKind;
    controlRootNodeId: ObservationNodeId;
} | undefined => {
    const controls = snapshot.control.controls;
    const componentIds = controls.byNodeId[targetNodeId] ?? [];
    const components = new Map(Object.entries(controls.controls));
    const matches = componentIds
        .map((componentId) => components.get(componentId))
        .filter((component): component is ControlComponent & {kind: SelectOptionKind} =>
            component !== undefined && isSelectOptionComponent(component));
    if (matches.length !== 1) {return undefined;}
    const component = matches[0];
    return {
        controlRef: component.ref,
        component,
        componentKind: component.kind,
        controlRootNodeId: component.rootNodeId,
    };
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
    return fromText || undefined;
};

export const readControlOptionByNodeId = (
    component: ControlComponent,
    nodeId: ObservationNodeId,
): ControlOption | undefined =>
    component.options.find((option) => option.nodeId === nodeId || option.semanticNodeId === nodeId);

export const readSelectedValuesFromControl = (component: ControlComponent): string[] =>
    component.options
        .filter((option) => option.selected)
        .map(readOptionRecordedValue)
        .filter((value): value is string => Boolean(value));

export const resolveRecordTargetBinding = async (input: {
    event: RecorderEvent;
    page?: Page;
    snapshotCache: Map<string, RecordSnapshotCacheEntry>;
    cacheKey: string;
    forceFreshSnapshot?: boolean;
}): Promise<RecordTargetBinding | undefined> => {
    const recordLog = getLogger('record');
    const selector = normalize(input.event.selector);
    if (!selector && !normalize(input.event.a11yHint?.role)) {
        recordLog('record_target_binding_result', {result: 'no_selector'});
        return undefined;
    }
    const snapshot = await snapshotResolver({...input, forceFresh: input.forceFreshSnapshot});
    if (!snapshot) {
        recordLog('record_target_binding_result', {result: 'no_snapshot', selector});
        return undefined;
    }

    const matched = collectMatchedNodeIds(snapshot, input.event);
    if (matched.length !== 1) {
        recordLog('record_target_binding_result', {
            result: matched.length === 0 ? 'no_node' : 'ambiguous_node',
            selector,
            matchedNodeCount: matched.length,
        });
        return undefined;
    }

    const targetNodeId = matched[0].nodeId;
    const byNode = findControlByNodeId(snapshot, targetNodeId);
    if (!byNode) {
        recordLog('record_target_binding_result', {
            result: 'no_control',
            selector,
            targetNodeId,
            matchedBy: matched[0].matchedBy,
        });
        return undefined;
    }

    recordLog('record_target_binding_result', {
        result: 'bound',
        selector,
        targetNodeId,
        matchedBy: matched[0].matchedBy,
        controlRef: byNode.controlRef,
        componentKind: byNode.componentKind,
        controlRootNodeId: byNode.controlRootNodeId,
    });
    return {
        snapshot,
        snapshotId: recordSnapshotId(snapshot),
        targetNodeId,
        matchedBy: matched[0].matchedBy,
        ...byNode,
    };
};
