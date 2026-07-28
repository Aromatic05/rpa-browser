import type {
    CanonicalLocator,
    ObservationNodeId,
    PageSnapshotSessionEntry,
} from '../../snapshot';
import type {StepResolve} from '../steps/types';
import {normalizeStepResolve} from '../steps/resolve_utils';

export type PageSessionResolveCandidate = {
    nodeId: ObservationNodeId;
    selector?: string;
    role?: string;
    name?: string;
    text?: string;
    confidence: number;
    reason: string[];
};

export const buildPageSessionResolve = (input: {
    entry: PageSnapshotSessionEntry;
    candidate: PageSessionResolveCandidate;
    rawSelector?: string;
    warnings?: string[];
}): StepResolve => {
    const {entry, candidate} = input;
    const snapshot = entry.capture.control;
    const observation = snapshot.observation;
    const attrs = observation.attributes[candidate.nodeId];
    const node = observation.nodes[candidate.nodeId];
    const locator = resolvedLocator(snapshot.locators.byNodeId[candidate.nodeId], snapshot.locators.locators);
    const directSelector = locator?.scopePath.length === 0 ? locator.selector : undefined;
    const geometryItems = new Map(Object.entries(observation.geometry)).get(candidate.nodeId) ?? [];
    const geometry = geometryItems.find((item) => item.space === 'top-css-viewport') ?? geometryItems.at(0);
    const warnings = input.warnings ?? [];
    const locatorCandidates: NonNullable<NonNullable<NonNullable<StepResolve['hint']>['raw']>['locatorCandidates']> = [
        ...(directSelector
            ? [{kind: 'css', selector: directSelector, note: 'capture_resolve canonical selector'}]
            : []),
        ...(attrs['data-testid']
            ? [{kind: 'testid', testId: attrs['data-testid'], note: 'capture_resolve data-testid'}]
            : []),
        ...(candidate.role || candidate.name
            ? [{kind: 'role', role: candidate.role, name: candidate.name, exact: true, note: 'capture_resolve role'}]
            : []),
        ...(candidate.text
            ? [{kind: 'text', text: candidate.text, exact: true, note: 'capture_resolve text'}]
            : []),
    ];

    return normalizeStepResolve({
        hint: {
            target: {
                nodeId: candidate.nodeId,
                role: candidate.role,
                tag: node.tag,
                name: candidate.name,
                text: candidate.text,
                attrs: Object.keys(attrs).length > 0 ? {...attrs} : undefined,
                bbox: geometry ? {...geometry.rect} : undefined,
            },
            locator: {
                direct: directSelector
                    ? {kind: 'css', query: directSelector}
                    : undefined,
                scope: {
                    id: node.scopeId,
                    kind: observation.scopes.scopes[node.scopeId].kind,
                },
            },
            raw: {
                selector: input.rawSelector || directSelector,
                locatorCandidates: locatorCandidates.length > 0 ? locatorCandidates : undefined,
                targetHint: normalizeText([candidate.role, candidate.name, candidate.text].filter(Boolean).join(' > ')),
            },
            capture: {
                source: 'capture_resolve',
                confidence: candidate.confidence,
                reason: [...candidate.reason],
                warnings: [...warnings],
            },
        },
        policy: {
            preferDirect: Boolean(directSelector),
            requireVisible: true,
            allowFuzzy: candidate.confidence < 0.8,
            allowIndexDrift: false,
        },
    }) ?? {};
};

type ResolvedCanonicalLocator = CanonicalLocator & {status: 'resolved'; selector: string};

const resolvedLocator = (
    locatorIds: readonly string[] | undefined,
    locators: Readonly<Record<string, CanonicalLocator>>,
): ResolvedCanonicalLocator | undefined => (locatorIds ?? [])
    .map((locatorId) => locators[locatorId])
    .find((locator): locator is ResolvedCanonicalLocator =>
        locator.status === 'resolved' && typeof locator.selector === 'string' && locator.selector.length > 0);

const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};
