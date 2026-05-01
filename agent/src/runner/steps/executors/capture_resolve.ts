import type { RunStepsDeps } from '../../run_steps';
import { ensureFreshEntityContext } from './entity_context';
import type { SnapshotResult, UnifiedNode } from './snapshot/core/types';
import { normalizeText } from './snapshot/core/runtime_store';
import type { Step, StepResolve, StepResult } from '../types';
import { resolveTarget } from '../helpers/resolve_target';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

type CaptureResolveCandidate = {
    nodeId: string;
    selector?: string;
    role?: string;
    name?: string;
    text?: string;
    confidence: number;
    reason: string[];
};

type CaptureResolveData = {
    resolve: StepResolve;
    candidates: Array<{
        selector?: string;
        role?: string;
        name?: string;
        text?: string;
        nodeId?: string;
        confidence: number;
        reason: string[];
    }>;
    confidence: number;
    warnings: string[];
};

export const normalizeCaptureResolveLimit = (
    value: number | undefined,
): { ok: true; value: number } | { ok: false; error: StepResult['error'] } => {
    if (value === undefined) {
        return { ok: true, value: DEFAULT_LIMIT };
    }
    if (!Number.isInteger(value) || value <= 0 || value > MAX_LIMIT) {
        return {
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: `browser.capture_resolve limit must be an integer between 1 and ${MAX_LIMIT}`,
            },
        };
    }
    return { ok: true, value };
};

export const executeBrowserCaptureResolve = async (
    step: Step<'browser.capture_resolve'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const args = step.args;
    if (!args.nodeId && !args.selector && !args.text && !args.role && !args.name) {
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
    if (!normalizedLimit.ok) {
        return { stepId: step.id, ok: false, error: normalizedLimit.error };
    }

    const binding = await deps.runtime.resolveBinding(workspaceId);
    const cachedSnapshot = readLatestSnapshot(binding.traceCtx.cache);
    const snapshot =
        cachedSnapshot ||
        (await ensureFreshEntityContext(deps, workspaceId, 'browser.capture_resolve')).snapshot;
    const candidates = await findCandidates(binding, snapshot, step).then((items) => items.slice(0, normalizedLimit.value));
    if (candidates.length === 0) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'browser.capture_resolve target not found',
            },
        };
    }

    const warnings: string[] = [];
    if (candidates.length > 1) {
        warnings.push('AMBIGUOUS_TARGET');
    }
    if (candidates[0].confidence < 0.8) {
        warnings.push('LOW_CONFIDENCE_TARGET');
    }

    const data: CaptureResolveData = {
        resolve: buildResolveDraft(snapshot, candidates[0], args.selector, warnings),
        candidates: candidates.map((candidate) => ({
            selector: candidate.selector,
            role: candidate.role,
            name: candidate.name,
            text: candidate.text,
            nodeId: candidate.nodeId,
            confidence: candidate.confidence,
            reason: [...candidate.reason],
        })),
        confidence: candidates[0].confidence,
        warnings,
    };

    return {
        stepId: step.id,
        ok: true,
        data,
    };
};

const readLatestSnapshot = (cache: unknown): SnapshotResult | null => {
    if (!cache || typeof cache !== 'object') {return null;}
    const snapshot = (cache as { latestSnapshot?: unknown }).latestSnapshot;
    if (!snapshot || typeof snapshot !== 'object') {return null;}
    const typed = snapshot as Partial<SnapshotResult>;
    if (!typed.root || !typed.nodeIndex || !typed.locatorIndex || !typed.attrIndex || !typed.contentStore || !typed.bboxIndex) {
        return null;
    }
    return typed as SnapshotResult;
};

const findCandidates = async (
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['resolveBinding']>>,
    snapshot: SnapshotResult,
    step: Step<'browser.capture_resolve'>,
): Promise<CaptureResolveCandidate[]> => {
    const args = step.args;
    if (step.resolve) {
        const resolved = await resolveTarget(binding, { resolve: step.resolve });
        if (!resolved.ok) {
            return [];
        }
        return Object.values(snapshot.nodeIndex)
            .filter((node) => selectorMatchesNode(snapshot, node, resolved.target.selector))
            .map((node) => ({
                ...buildCandidate(snapshot, node, { kind: 'selector' as const, match: () => [] }, 1),
                selector: resolved.target.selector,
                confidence: 0.92,
                reason: ['matched resolveId sidecar'],
            }))
            .sort((left, right) => right.confidence - left.confidence || left.nodeId.localeCompare(right.nodeId));
    }

    const strategy = selectStrategy(args);
    const matches = strategy.match(snapshot);
    const count = matches.length;
    return matches
        .map((node) => buildCandidate(snapshot, node, strategy, count))
        .sort((left, right) => {
            if (right.confidence !== left.confidence) {
                return right.confidence - left.confidence;
            }
            return left.nodeId.localeCompare(right.nodeId);
        });
};

const selectStrategy = (args: Step<'browser.capture_resolve'>['args']) => {
    if (args.nodeId) {
        return {
            kind: 'nodeId' as const,
            match: (snapshot: SnapshotResult) => {
                const node = snapshot.nodeIndex[args.nodeId!];
                return node ? [node] : [];
            },
        };
    }
    if (args.selector) {
        return {
            kind: 'selector' as const,
            match: (snapshot: SnapshotResult) =>
                Object.values(snapshot.nodeIndex).filter((node) => selectorMatchesNode(snapshot, node, args.selector!)),
        };
    }
    if (args.role && args.name) {
        return {
            kind: 'role+name' as const,
            match: (snapshot: SnapshotResult) =>
                Object.values(snapshot.nodeIndex).filter((node) => {
                    const nodeName = normalizeLower(node.name);
                    return normalizeLower(node.role) === normalizeLower(args.role) && nodeName.includes(normalizeLower(args.name));
                }),
        };
    }
    if (args.text) {
        return {
            kind: 'text' as const,
            match: (snapshot: SnapshotResult) =>
                Object.values(snapshot.nodeIndex).filter((node) => normalizeLower(readNodeText(snapshot, node)).includes(normalizeLower(args.text))),
        };
    }
    if (args.role) {
        return {
            kind: 'role' as const,
            match: (snapshot: SnapshotResult) =>
                Object.values(snapshot.nodeIndex).filter((node) => normalizeLower(node.role) === normalizeLower(args.role)),
        };
    }
    return {
        kind: 'name' as const,
        match: (snapshot: SnapshotResult) =>
            Object.values(snapshot.nodeIndex).filter((node) => normalizeLower(node.name).includes(normalizeLower(args.name))),
    };
};

const buildCandidate = (
    snapshot: SnapshotResult,
    node: UnifiedNode,
    strategy: ReturnType<typeof selectStrategy>,
    totalMatches: number,
): CaptureResolveCandidate => {
    const selector = getPreferredSelector(snapshot, node);
    const text = readNodeText(snapshot, node);
    const unique = totalMatches === 1;
    const confidence =
        strategy.kind === 'nodeId'
            ? 1
            : strategy.kind === 'selector'
              ? unique ? 0.95 : 0.65
              : strategy.kind === 'role+name'
                ? unique ? 0.9 : 0.65
                : strategy.kind === 'text'
                  ? unique ? 0.75 : 0.55
                  : unique ? 0.7 : 0.45;
    const reason =
        strategy.kind === 'nodeId'
            ? ['matched nodeId']
            : strategy.kind === 'selector'
              ? ['matched selector heuristic']
              : strategy.kind === 'role+name'
                ? ['matched role and name']
                : strategy.kind === 'text'
                  ? ['matched text']
                  : strategy.kind === 'role'
                    ? ['matched role']
                    : ['matched name'];

    return {
        nodeId: node.id,
        selector,
        role: normalizeText(node.role),
        name: normalizeText(node.name),
        text,
        confidence,
        reason,
    };
};

const buildResolveDraft = (
    snapshot: SnapshotResult,
    candidate: CaptureResolveCandidate,
    rawSelector: string | undefined,
    warnings: string[],
): StepResolve => {
    const node = snapshot.nodeIndex[candidate.nodeId];
    const attrs = snapshot.attrIndex[candidate.nodeId];
    const locator = snapshot.locatorIndex[candidate.nodeId];
    const bbox = snapshot.bboxIndex[candidate.nodeId];
    const directQuery = locator?.direct?.kind === 'css' ? locator.direct.query : undefined;
    const selector = candidate.selector || directQuery || rawSelector;

    return {
        hint: {
            target: {
                nodeId: candidate.nodeId,
                primaryDomId: locator?.origin.primaryDomId,
                sourceDomIds: locator?.origin.sourceDomIds,
                role: candidate.role,
                tag: attrs?.tag || attrs?.tagName,
                name: candidate.name,
                text: candidate.text,
                attrs: attrs && Object.keys(attrs).length > 0 ? attrs : undefined,
                bbox,
            },
            locator: {
                direct:
                    selector
                        ? {
                              kind: 'css',
                              query: selector,
                              fallback: locator?.direct?.fallback,
                          }
                        : undefined,
                scope: locator?.scope
                    ? {
                          id: locator.scope.id,
                          kind: locator.scope.kind,
                      }
                    : undefined,
                origin: locator?.origin
                    ? {
                          primaryDomId: locator.origin.primaryDomId,
                          sourceDomIds: locator.origin.sourceDomIds,
                      }
                    : undefined,
            },
            raw: {
                selector: rawSelector || selector,
                locatorCandidates: buildLocatorCandidates(candidate, attrs),
                targetHint: normalizeText([node?.role, node?.name, candidate.text].filter(Boolean).join(' > ')),
            },
            capture: {
                source: 'capture_resolve',
                confidence: candidate.confidence,
                reason: [...candidate.reason],
                warnings: [...warnings],
            },
        },
        policy: {
            preferDirect: true,
            requireVisible: true,
            allowFuzzy: candidate.confidence < 0.8,
            allowIndexDrift: true,
        },
    };
};

const buildLocatorCandidates = (
    candidate: CaptureResolveCandidate,
    attrs: Record<string, string> | undefined,
): NonNullable<NonNullable<StepResolve['hint']>['raw']>['locatorCandidates'] => {
    const out: NonNullable<NonNullable<StepResolve['hint']>['raw']>['locatorCandidates'] = [];
    if (candidate.selector) {
        out.push({ kind: 'css', selector: candidate.selector, note: 'capture_resolve preferred selector' });
    }
    if (attrs?.['data-testid']) {
        out.push({ kind: 'testid', testId: attrs['data-testid'], note: 'capture_resolve data-testid' });
    }
    if (candidate.role || candidate.name) {
        out.push({
            kind: 'role',
            role: candidate.role,
            name: candidate.name,
            exact: true,
            note: 'capture_resolve role locator',
        });
    }
    if (candidate.text) {
        out.push({
            kind: 'text',
            text: candidate.text,
            exact: true,
            note: 'capture_resolve text locator',
        });
    }
    return out.length > 0 ? out : undefined;
};

const selectorMatchesNode = (snapshot: SnapshotResult, node: UnifiedNode, selector: string): boolean => {
    const normalizedSelector = selector.trim();
    if (!normalizedSelector) {return false;}

    const locator = snapshot.locatorIndex[node.id];
    if (locator?.direct?.query === normalizedSelector || locator?.direct?.fallback === normalizedSelector) {
        return true;
    }

    const attrs = snapshot.attrIndex[node.id] || {};
    if (normalizedSelector.startsWith('#')) {
        return attrs.id === normalizedSelector.slice(1);
    }
    const attributeMatch = normalizedSelector.match(/^\[(.+?)="(.+)"\]$/);
    if (attributeMatch) {
        const [, key, value] = attributeMatch;
        return attrs[key] === value;
    }
    if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(normalizedSelector)) {
        return normalizeLower(attrs.tag || attrs.tagName) === normalizeLower(normalizedSelector);
    }
    return false;
};

const getPreferredSelector = (snapshot: SnapshotResult, node: UnifiedNode): string | undefined => {
    const locator = snapshot.locatorIndex[node.id];
    if (locator?.direct?.kind === 'css' && locator.direct.query) {
        return locator.direct.query;
    }
    if (locator?.direct?.fallback) {
        return locator.direct.fallback;
    }

    const attrs = snapshot.attrIndex[node.id] || {};
    if (attrs.id) {
        return `#${attrs.id}`;
    }
    if (attrs['data-testid']) {
        return `[data-testid="${attrs['data-testid']}"]`;
    }
    if (attrs.name) {
        return `[name="${attrs.name}"]`;
    }
    return undefined;
};

const readNodeText = (snapshot: SnapshotResult, node: UnifiedNode): string | undefined => {
    const name = normalizeText(node.name);
    if (name) {return name;}
    if (typeof node.content === 'string') {
        return normalizeText(node.content);
    }
    if (node.content?.ref) {
        return normalizeText(snapshot.contentStore[node.content.ref]);
    }
    return undefined;
};

const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase() || '';
