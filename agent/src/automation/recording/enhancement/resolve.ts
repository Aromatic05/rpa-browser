import type {StepResolve} from '../../runner/steps/types';
import {normalizeStepResolve} from '../../runner/steps/resolve_utils';
import type {CanonicalLocator} from '../../snapshot';
import type {RecordPageSnapshot} from '../pipeline/snapshot';

export type RecordResolveCandidate = {
    nodeId?: string;
    selector?: string;
    role?: string;
    name?: string;
    text?: string;
    confidence: number;
    reason: string[];
};

type RawLocatorCandidates = NonNullable<NonNullable<StepResolve['hint']>['raw']>['locatorCandidates'];

export const buildRecordResolveFromSnapshotCandidate = (input: {
    snapshot?: RecordPageSnapshot;
    candidate: RecordResolveCandidate;
    rawSelector?: string;
    rawLocatorCandidates?: RawLocatorCandidates;
    warnings?: string[];
}): StepResolve => {
    const {snapshot, candidate, rawSelector} = input;
    const warnings = input.warnings ?? [];
    const lowConfidenceRawOnly = warnings.includes('LOW_CONFIDENCE_RAW_ONLY');
    const nodeId = candidate.nodeId;
    const observation = snapshot?.control.observation;
    const node = nodeId && observation ? new Map(Object.entries(observation.nodes)).get(nodeId) : undefined;
    const attrs = nodeId && observation ? new Map(Object.entries(observation.attributes)).get(nodeId) : undefined;
    const locator = nodeId && snapshot ? resolvedLocator(snapshot, nodeId) : undefined;
    const canonicalSelector = locator?.scopePath.length === 0 ? locator.selector : undefined;
    const directSelector = rawSelector || candidate.selector || canonicalSelector;
    const geometry = nodeId && observation
        ? (observation.geometry[nodeId] ?? []).find((item) => item.space === 'top-css-viewport')
            ?? (observation.geometry[nodeId] ?? [])[0]
        : undefined;
    const identity = nodeId && observation ? observation.domIdentity[nodeId] : undefined;
    const scope = node && observation
        ? new Map(Object.entries(observation.scopes.scopes)).get(node.scopeId)
        : undefined;

    const locatorCandidates: NonNullable<RawLocatorCandidates> = [
        ...(input.rawLocatorCandidates ?? []),
        ...(directSelector
            ? [{kind: 'css', selector: directSelector, note: 'record_enrichment preferred selector'}]
            : []),
        ...(attrs?.['data-testid']
            ? [{kind: 'testid', testId: attrs['data-testid'], note: 'record_enrichment data-testid'}]
            : []),
        ...(candidate.role || candidate.name
            ? [{kind: 'role', role: candidate.role, name: candidate.name, exact: true, note: 'record_enrichment role'}]
            : []),
        ...(candidate.text
            ? [{kind: 'text', text: candidate.text, exact: true, note: 'record_enrichment text'}]
            : []),
    ];

    return normalizeStepResolve({
        hint: {
            target: {
                nodeId: lowConfidenceRawOnly ? undefined : nodeId,
                primaryDomId: lowConfidenceRawOnly ? undefined : identity?.backendNodeId,
                sourceDomIds: lowConfidenceRawOnly || !identity?.backendNodeId ? undefined : [identity.backendNodeId],
                role: candidate.role,
                tag: node?.tag,
                name: candidate.name,
                text: candidate.text,
                attrs: lowConfidenceRawOnly || !attrs || Object.keys(attrs).length === 0 ? undefined : {...attrs},
                bbox: lowConfidenceRawOnly || !geometry ? undefined : {...geometry.rect},
            },
            locator: {
                direct: directSelector ? {kind: 'css', query: directSelector} : undefined,
                scope: scope ? {id: scope.id, kind: scope.kind} : undefined,
                origin: lowConfidenceRawOnly || !identity?.backendNodeId
                    ? undefined
                    : {primaryDomId: identity.backendNodeId, sourceDomIds: [identity.backendNodeId]},
            },
            raw: {
                selector: rawSelector || directSelector,
                locatorCandidates: locatorCandidates.length > 0 ? locatorCandidates : undefined,
                targetHint: normalizeText([candidate.role, candidate.name, candidate.text].filter(Boolean).join(' > ')),
            },
            capture: {
                source: 'record_enrichment',
                confidence: candidate.confidence,
                reason: [...candidate.reason],
                warnings: [...warnings],
            },
        },
        policy: {
            preferDirect: Boolean(directSelector),
            requireVisible: true,
            allowFuzzy: candidate.confidence < 0.8,
            allowIndexDrift: true,
        },
    }) ?? {};
};

const resolvedLocator = (snapshot: RecordPageSnapshot, nodeId: string): CanonicalLocator | undefined => {
    const locators = snapshot.control.locators;
    const byId = new Map(Object.entries(locators.locators));
    return (locators.byNodeId[nodeId] ?? [])
        .map((locatorId) => byId.get(locatorId))
        .find((locator): locator is CanonicalLocator =>
            locator?.status === 'resolved' && typeof locator.selector === 'string' && locator.selector.length > 0);
};

const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};
