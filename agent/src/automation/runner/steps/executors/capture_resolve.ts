import type {RunStepsDeps, RunStepsExecutionContext} from '../../run_steps';
import {
    ensureFreshPageSession,
    buildPageSessionResolve,
    type PageSessionResolveCandidate,
} from '../../session';
import {
    resolveSemanticRole,
    type ObservationNodeId,
    type PageSnapshotSessionEntry,
} from '../../../snapshot';
import type {ResolveHint, Step, StepResult} from '../types';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

type CaptureResolveData = {
    resolve: ReturnType<typeof buildPageSessionResolve>;
    candidates: PageSessionResolveCandidate[];
    confidence: number;
    warnings: string[];
    target: {
        nodeId: string;
        resolve: ReturnType<typeof buildPageSessionResolve>;
        meta: {pageEpoch: string; captureRevision: number};
    };
};

export const normalizeCaptureResolveLimit = (
    value: number | undefined,
): {ok: true; value: number} | {ok: false; error: StepResult['error']} => {
    if (value === undefined) {return {ok: true, value: DEFAULT_LIMIT};}
    if (!Number.isInteger(value) || value <= 0 || value > MAX_LIMIT) {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: `browser.capture_resolve limit must be an integer between 1 and ${MAX_LIMIT}`,
            },
        };
    }
    return {ok: true, value};
};

export const executeBrowserCaptureResolve = async (
    step: Step<'browser.capture_resolve'>,
    deps: RunStepsDeps,
    workspaceName: string,
    context?: RunStepsExecutionContext,
): Promise<StepResult> => {
    const args = step.args;
    if (!args.nodeId && !args.selector && !args.text && !args.role && !args.name && !step.resolve) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'browser.capture_resolve requires nodeId, selector, text, role, or name',
            },
        };
    }
    const normalizedLimit = normalizeCaptureResolveLimit(args.limit);
    if (!normalizedLimit.ok) {return {stepId: step.id, ok: false, error: normalizedLimit.error};}

    const {entry} = await ensureFreshPageSession(deps, workspaceName, {entityRulesProvider: context?.entityRulesProvider});
    const candidates = findCandidates(entry, step).slice(0, normalizedLimit.value);
    if (candidates.length === 0) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'browser.capture_resolve target not found',
                details: captureResolveFailureDetails(entry, workspaceName, step, candidates.length),
            },
        };
    }

    const warnings: string[] = [];
    if (candidates.length > 1) {warnings.push('AMBIGUOUS_TARGET');}
    if (candidates[0].confidence < 0.8) {warnings.push('LOW_CONFIDENCE_TARGET');}
    const resolve = buildPageSessionResolve({
        entry,
        candidate: candidates[0],
        rawSelector: args.selector,
        warnings,
    });
    const data: CaptureResolveData = {
        resolve,
        candidates: candidates.map((candidate) => ({...candidate, reason: [...candidate.reason]})),
        confidence: candidates[0].confidence,
        warnings,
        target: {
            nodeId: candidates[0].nodeId,
            resolve,
            meta: {
                pageEpoch: entry.identity.pageEpoch,
                captureRevision: entry.identity.captureRevision,
            },
        },
    };
    return {stepId: step.id, ok: true, data};
};



const captureResolveFailureDetails = (
    entry: PageSnapshotSessionEntry,
    workspaceName: string,
    step: Step<'browser.capture_resolve'>,
    candidateCount: number,
): Record<string, unknown> => ({
    workspaceName,
    pageEpoch: entry.identity.pageEpoch,
    captureRevision: entry.identity.captureRevision,
    scopeIds: [...entry.capture.control.observation.scopes.rootScopeIds],
    activeNodeCount: orderedActiveNodeIds(entry).length,
    candidateCount,
    query: captureResolveQuery(step),
});

const captureResolveQuery = (
    step: Step<'browser.capture_resolve'>,
): Record<string, unknown> => {
    const query: Record<string, unknown> = {};
    const {nodeId, selector, text, role, name} = step.args;
    if (nodeId) {query.nodeId = nodeId;}
    if (selector) {query.selector = selector;}
    if (text) {query.text = text;}
    if (role) {query.role = role;}
    if (name) {query.name = name;}
    if (step.resolve) {query.resolve = structuredClone(step.resolve);}
    return query;
};

const findCandidates = (
    entry: PageSnapshotSessionEntry,
    step: Step<'browser.capture_resolve'>,
): PageSessionResolveCandidate[] => {
    if (step.resolve) {
        return matchResolveHint(entry, step)
            .map((nodeId) => buildCandidate(entry, nodeId, 'resolve', 1));
    }
    const strategy = selectStrategy(entry, step.args);
    const nodeIds = strategy.match();
    return nodeIds
        .map((nodeId) => buildCandidate(entry, nodeId, strategy.kind, nodeIds.length))
        .sort(compareCandidates);
};

const selectStrategy = (
    entry: PageSnapshotSessionEntry,
    args: Step<'browser.capture_resolve'>['args'],
): {kind: 'nodeId' | 'selector' | 'role+name' | 'text' | 'role' | 'name'; match: () => ObservationNodeId[]} => {
    const all = () => orderedActiveNodeIds(entry);
    if (args.nodeId) {
        return {
            kind: 'nodeId',
            match: () => isActiveNode(entry, args.nodeId!) ? [args.nodeId!] : [],
        };
    }
    if (args.selector) {
        return {kind: 'selector', match: () => all().filter((nodeId) => selectorMatchesNode(entry, nodeId, args.selector!))};
    }
    if (args.role && args.name) {
        return {
            kind: 'role+name',
            match: () => all().filter((nodeId) =>
                normalizeLower(readRole(entry, nodeId)) === normalizeLower(args.role)
                && normalizeLower(readName(entry, nodeId)).includes(normalizeLower(args.name))),
        };
    }
    if (args.text) {
        return {
            kind: 'text',
            match: () => all().filter((nodeId) =>
                normalizeLower(readSearchText(entry, nodeId)).includes(normalizeLower(args.text))),
        };
    }
    if (args.role) {
        return {
            kind: 'role',
            match: () => all().filter((nodeId) => normalizeLower(readRole(entry, nodeId)) === normalizeLower(args.role)),
        };
    }
    return {
        kind: 'name',
        match: () => all().filter((nodeId) => normalizeLower(readName(entry, nodeId)).includes(normalizeLower(args.name))),
    };
};

const matchResolveHint = (
    entry: PageSnapshotSessionEntry,
    step: Step<'browser.capture_resolve'>,
): ObservationNodeId[] => {
    const hint = step.resolve?.hint;
    if (!hint) {return [];}
    let candidates = orderedActiveNodeIds(entry);
    let constrained = false;

    if (hint.target?.nodeId) {
        constrained = true;
        candidates = isActiveNode(entry, hint.target.nodeId) ? [hint.target.nodeId] : [];
    } else if (hint.entity && Object.values(hint.entity).some(Boolean)) {
        constrained = true;
        const semanticNodeIds = new Set<ObservationNodeId>();
        for (const profile of Object.values(entry.semanticBindingsByProfile)) {
            for (const binding of Object.values(profile.byId)) {
                if (binding.status !== 'active' || binding.disposition !== 'active') {continue;}
                if (!annotationMatches(binding.annotation, hint.entity)) {continue;}
                for (const nodeId of binding.target.nodeIds) {semanticNodeIds.add(nodeId);}
            }
        }
        candidates = candidates.filter((nodeId) => semanticNodeIds.has(nodeId));
    }

    const selectors = unique([
        hint.locator?.direct?.query,
        hint.locator?.direct?.fallback,
        hint.raw?.selector,
        ...(hint.raw?.locatorCandidates ?? [])
            .filter((candidate) => candidate.kind === 'css')
            .map((candidate) => candidate.selector),
    ].filter((value): value is string => Boolean(value)));
    if (selectors.length > 0) {
        constrained = true;
        candidates = candidates.filter((nodeId) => selectors.some((selector) => selectorMatchesNode(entry, nodeId, selector)));
    }

    const target = hint.target;
    if (target?.primaryDomId || target?.sourceDomIds?.length) {
        constrained = true;
        const identities = new Set([target.primaryDomId, ...(target.sourceDomIds ?? [])].filter(Boolean));
        candidates = candidates.filter((nodeId) => {
            const identity = new Map(Object.entries(entry.capture.control.observation.domIdentity)).get(nodeId);
            return identity?.backendNodeId !== undefined && identities.has(identity.backendNodeId);
        });
    }
    if (target?.role) {
        constrained = true;
        candidates = candidates.filter((nodeId) => normalizeLower(readRole(entry, nodeId)) === normalizeLower(target.role));
    }
    if (target?.name) {
        constrained = true;
        candidates = candidates.filter((nodeId) => normalizeLower(readName(entry, nodeId)).includes(normalizeLower(target.name)));
    }
    if (target?.text) {
        constrained = true;
        candidates = candidates.filter((nodeId) => normalizeLower(readSearchText(entry, nodeId)).includes(normalizeLower(target.text)));
    }
    if (target?.tag) {
        constrained = true;
        candidates = candidates.filter((nodeId) =>
            normalizeLower(entry.capture.control.observation.nodes[nodeId].tag) === normalizeLower(target.tag));
    }
    return constrained ? candidates.sort((left, right) => compareNodeOrder(entry, left, right)) : [];
};

const annotationMatches = (
    annotation: Readonly<Record<string, unknown>>,
    hint: ResolveHint['entity'],
): boolean => {
    if (!hint) {return false;}
    return (!hint.businessTag || annotation.businessTag === hint.businessTag)
        && (!hint.fieldKey || annotation.fieldKey === hint.fieldKey)
        && (!hint.actionIntent || annotation.actionIntent === hint.actionIntent);
};

const buildCandidate = (
    entry: PageSnapshotSessionEntry,
    nodeId: ObservationNodeId,
    strategy: 'nodeId' | 'selector' | 'role+name' | 'text' | 'role' | 'name' | 'resolve',
    totalMatches: number,
): PageSessionResolveCandidate => {
    const uniqueMatch = totalMatches === 1;
    const confidence = strategy === 'nodeId'
        ? 1
        : strategy === 'resolve'
            ? uniqueMatch ? 0.92 : 0.65
            : strategy === 'selector'
                ? uniqueMatch ? 0.95 : 0.65
                : strategy === 'role+name'
                    ? uniqueMatch ? 0.9 : 0.65
                    : strategy === 'text'
                        ? uniqueMatch ? 0.75 : 0.55
                        : uniqueMatch ? 0.7 : 0.45;
    return {
        nodeId,
        selector: preferredSelector(entry, nodeId),
        role: readRole(entry, nodeId),
        name: readName(entry, nodeId),
        text: readNodeText(entry, nodeId),
        confidence,
        reason: [`matched ${strategy}`],
    };
};

const preferredSelector = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string | undefined => {
    const locators = entry.capture.control.locators;
    return (locators.byNodeId[nodeId] ?? [])
        .map((locatorId) => locators.locators[locatorId])
        .find((locator) => locator.status === 'resolved')?.selector;
};

const selectorMatchesNode = (
    entry: PageSnapshotSessionEntry,
    nodeId: ObservationNodeId,
    selector: string,
): boolean => {
    const normalized = selector.trim();
    if (!normalized) {return false;}
    if (preferredSelector(entry, nodeId) === normalized) {return true;}
    const attrs = entry.capture.control.observation.attributes[nodeId] ?? {};
    if (normalized.startsWith('#')) {return attrs.id === normalized.slice(1);}
    const attributeMatch = normalized.match(/^\[([^=\]]+)=["'](.+)["']\]$/);
    if (attributeMatch) {return attrs[attributeMatch[1]] === attributeMatch[2];}
    if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(normalized)) {
        return normalizeLower(entry.capture.control.observation.nodes[nodeId].tag) === normalizeLower(normalized);
    }
    return false;
};

const orderedActiveNodeIds = (entry: PageSnapshotSessionEntry): ObservationNodeId[] =>
    Object.keys(entry.capture.control.observation.nodes)
        .filter((nodeId) => isActiveNode(entry, nodeId))
        .sort((left, right) => compareNodeOrder(entry, left, right));

const isActiveNode = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): boolean => {
    const activity = entry.capture.control.observation.activity[nodeId];
    return activity.rendered && !activity.hiddenByStyle && !activity.inert
        && activity.subtreeActive && activity.ariaExposed !== false;
};

const compareNodeOrder = (entry: PageSnapshotSessionEntry, left: ObservationNodeId, right: ObservationNodeId): number =>
    (entry.capture.control.observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
    - (entry.capture.control.observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER);

const compareCandidates = (left: PageSessionResolveCandidate, right: PageSessionResolveCandidate): number =>
    right.confidence - left.confidence || left.nodeId.localeCompare(right.nodeId);

const readRole = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string | undefined =>
    normalizeText(resolveSemanticRole(entry.capture.control.observation, nodeId).value);

const readName = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string | undefined => {
    const observation = entry.capture.control.observation;
    const attrs = observation.attributes[nodeId] ?? {};
    return normalizeText(observation.accessibility[nodeId]?.name)
        ?? normalizeText(attrs['aria-label'])
        ?? normalizeText(attrs.title)
        ?? readNodeText(entry, nodeId);
};

const readSearchText = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string | undefined =>
    normalizeText([readName(entry, nodeId), readNodeText(entry, nodeId)].filter(Boolean).join(' '));

const readNodeText = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string | undefined => {
    const observation = entry.capture.control.observation;
    const values: string[] = [];
    const stack = [nodeId];
    while (stack.length > 0) {
        const current = stack.pop()!;
        const text = normalizeText(observation.text[current]);
        if (text && !values.includes(text)) {values.push(text);}
        stack.push(...[...(observation.children[current] ?? [])].reverse());
    }
    return values.length > 0 ? values.join(' ') : undefined;
};

const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};
const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase() ?? '';
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
