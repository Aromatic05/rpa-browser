import type {
    AnalysisDiagnostic,
    Evidence,
    ObservationNodeId,
    PageObservation,
    TreeScopeId,
} from '../../observation/model/contracts';
import { deepFreeze } from '../../observation/model/freeze';
import { resolveLocatorScopePath } from '../../observation/model/locator_scope';
import type { CanonicalLocator, CanonicalLocatorStrategy, LocatorIndex } from './contracts';
import { observationLocatorFingerprint } from './fingerprint';

export const buildLocatorIndex = (observation: PageObservation): LocatorIndex => {
    const locators: Record<string, CanonicalLocator> = {};
    const byNodeId: Record<ObservationNodeId, string[]> = {};
    const diagnostics: AnalysisDiagnostic[] = [];
    const uniqueness = buildScopeAttributeUniqueness(observation);

    for (const nodeId of orderedNodeIds(observation)) {
        const node = observation.nodes[nodeId];
        if (node.tag === '#shadow-root') {continue;}
        const scopeResolution = resolveLocatorScopePath(observation, nodeId);
        const locatorId = `locator:${nodeId}`;
        const base = {
            id: locatorId,
            targetNodeId: nodeId,
            identity: { ...observation.identity },
            scopePath: scopeResolution.status === 'resolved' ? [...scopeResolution.value] : [],
            evidence: [...scopeResolution.evidence],
        };

        let locator: CanonicalLocator;
        if (scopeResolution.status !== 'resolved') {
            locator = {
                ...base,
                status: scopeResolution.status === 'ambiguous' ? 'ambiguous' : 'unresolved',
            };
            diagnostics.push(locatorDiagnostic(
                scopeResolution.status === 'ambiguous' ? 'locator.scope.ambiguous' : 'locator.scope.unresolved',
                scopeResolution.status === 'ambiguous' ? 'ambiguous' : 'partial',
                nodeId,
                locator.evidence,
                'locator scope path is not executable',
            ));
        } else {
            const selector = chooseSelector(observation, nodeId, uniqueness);
            locator = selector
                ? {
                    ...base,
                    status: 'resolved',
                    strategy: selector.strategy,
                    selector: selector.selector,
                    fingerprint: selector.fingerprint,
                    evidence: [...base.evidence, selector.evidence],
                }
                : {
                    ...base,
                    status: 'unresolved',
                };
            if (!selector) {
                diagnostics.push(locatorDiagnostic(
                    'locator.selector.unresolved',
                    'partial',
                    nodeId,
                    locator.evidence,
                    'canonical selector could not be built',
                ));
            }
        }
        locators[locatorId] = locator;
        (byNodeId[nodeId] ??= []).push(locatorId);
    }

    return deepFreeze({ locators, byNodeId, diagnostics });
};

type UniqueIndex = Map<TreeScopeId, Map<string, Map<string, ObservationNodeId[]>>>;

const buildScopeAttributeUniqueness = (observation: PageObservation): UniqueIndex => {
    const result: UniqueIndex = new Map();
    for (const nodeId of orderedNodeIds(observation)) {
        const node = observation.nodes[nodeId];
        const attrs = observation.attributes[nodeId] ?? {};
        for (const name of ['id', 'data-testid', 'name']) {
            const value = attrs[name];
            if (typeof value !== 'string' || value.length === 0) {continue;}
            const scope = result.get(node.scopeId) ?? new Map<string, Map<string, ObservationNodeId[]>>();
            const attribute = scope.get(name) ?? new Map<string, ObservationNodeId[]>();
            const bucket = attribute.get(value) ?? [];
            bucket.push(nodeId);
            attribute.set(value, bucket);
            scope.set(name, attribute);
            result.set(node.scopeId, scope);
        }
    }
    return result;
};

const chooseSelector = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    uniqueness: UniqueIndex,
): { selector: string; strategy: CanonicalLocatorStrategy; fingerprint?: string; evidence: Evidence } | undefined => {
    if (!Object.hasOwn(observation.nodes, nodeId)) {return undefined;}
    const node = observation.nodes[nodeId];
    const attrs = observation.attributes[nodeId] ?? {};
    const fingerprint = observationLocatorFingerprint(observation, nodeId);
    const unique = (name: string, value: string | undefined) =>
        typeof value === 'string'
        && value.length > 0
        && (uniqueness.get(node.scopeId)?.get(name)?.get(value)?.length ?? 0) === 1;

    if (unique('id', attrs.id)) {
        return selectorResult('id', `[id=${quoteCss(attrs.id)}]`, nodeId, undefined, 'locator.selector.id');
    }
    if (unique('data-testid', attrs['data-testid'])) {
        return selectorResult(
            'test-id',
            `[data-testid=${quoteCss(attrs['data-testid'])}]`,
            nodeId,
            undefined,
            'locator.selector.test-id',
        );
    }
    if (unique('name', attrs.name) && normalizeTag(node.tag)) {
        return selectorResult(
            'name',
            `${normalizeTag(node.tag)}[name=${quoteCss(attrs.name)}]`,
            nodeId,
            undefined,
            'locator.selector.name',
        );
    }
    const structural = buildStructuralPath(observation, nodeId);
    if (!structural) {return undefined;}
    return selectorResult('structural', structural, nodeId, fingerprint, 'locator.selector.structural');
};

const selectorResult = (
    strategy: CanonicalLocatorStrategy,
    selector: string,
    nodeId: ObservationNodeId,
    fingerprint: string | undefined,
    code: string,
) => ({
    strategy,
    selector,
    fingerprint,
    evidence: {
        code,
        strength: strategy === 'structural' ? 'strong' as const : 'exact' as const,
        source: 'dom' as const,
        nodeIds: [nodeId],
        detail: { selector },
    },
});

const buildStructuralPath = (observation: PageObservation, nodeId: ObservationNodeId): string | undefined => {
    const segments: string[] = [];
    let current: ObservationNodeId | undefined = nodeId;
    const visited = new Set<ObservationNodeId>();
    while (current) {
        if (visited.has(current)) {return undefined;}
        visited.add(current);
        if (!Object.hasOwn(observation.nodes, current)) {return undefined;}
        const node = observation.nodes[current];
        const tag = normalizeTag(node.tag);
        if (tag) {
            segments.push(`${tag}:nth-of-type(${nthOfType(observation, current, tag)})`);
        }
        const parentId: ObservationNodeId | undefined = observation.parents[current];
        if (!parentId) {break;}
        if (observation.nodes[parentId].scopeId !== node.scopeId) {break;}
        current = parentId;
    }
    return segments.length > 0 ? segments.reverse().join(' > ') : undefined;
};

const nthOfType = (observation: PageObservation, nodeId: ObservationNodeId, tag: string): number => {
    const parent = observation.parents[nodeId];
    if (!parent) {return 1;}
    let position = 0;
    for (const sibling of observation.children[parent] ?? []) {
        if (normalizeTag(observation.nodes[sibling].tag) !== tag) {continue;}
        position += 1;
        if (sibling === nodeId) {return position;}
    }
    return 1;
};

const normalizeTag = (value: string | undefined): string => {
    const tag = (value ?? '').trim().toLowerCase();
    return tag && !tag.startsWith('#') ? tag : '';
};

const quoteCss = (value: string): string => JSON.stringify(value);
const orderedNodeIds = (observation: PageObservation): ObservationNodeId[] =>
    Object.keys(observation.nodes).sort((a, b) =>
        (observation.documentOrder[a] ?? Number.MAX_SAFE_INTEGER)
        - (observation.documentOrder[b] ?? Number.MAX_SAFE_INTEGER));

const locatorDiagnostic = (
    code: string,
    status: 'partial' | 'ambiguous',
    nodeId: ObservationNodeId,
    evidence: readonly Evidence[],
    message: string,
): AnalysisDiagnostic => ({
    code,
    severity: status === 'ambiguous' ? 'error' : 'warning',
    stage: 'locator',
    status,
    nodeIds: [nodeId],
    evidence: [...evidence],
    message,
});
