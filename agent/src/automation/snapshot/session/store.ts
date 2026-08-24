import {
    createObservationAnchor,
    resolveObservationAnchor,
} from '../observation/model/anchor';
import type {
    AnchorResolution,
    Evidence,
    ObservationAnchor,
    ObservationNodeId,
    PageObservation,
} from '../observation/model/contracts';
import {mergeSemanticBindings} from '../rules/semantic/merge';
import {
    buildSemanticBindingIndexes,
    cloneSemanticAnnotation,
    cloneSemanticTarget,
} from '../rules/semantic/shared';
import type {
    SemanticBindingDiagnostic,
    SemanticBindings,
    SemanticBusinessBinding,
    SemanticSuggestions,
} from '../rules/semantic/contracts';
import type {
    EnsureFreshPageSessionInput,
    ManualSemanticBindingDraft,
    ManualSemanticBindingIgnoreResult,
    ManualSemanticBindingWriteResult,
    PageSessionFreshness,
    PageSessionRefreshReason,
    PageSessionSelection,
    PageSessionSelectionConfirmation,
    PageSnapshotCapture,
    PageSnapshotSessionEntry,
    PageSnapshotSessionPort,
} from './contracts';

type MutablePageSessionState = {
    entry?: PageSnapshotSessionEntry;
    dirtyRevision: number;
    appliedDirtyRevision: number;
    inFlight?: Promise<PageSnapshotSessionEntry>;
    selectionAnchor?: ObservationAnchor;
    manualBindings: SemanticBindings;
    manualAnchors: Map<string, ObservationAnchor>;
};

export class PageSnapshotSessionStore<Key extends object = object>
implements PageSnapshotSessionPort<Key> {
    private readonly states = new WeakMap<Key, MutablePageSessionState>();

    public read(pageKey: Key): PageSnapshotSessionEntry | undefined {
        return this.states.get(pageKey)?.entry;
    }

    public readFreshness(pageKey: Key, pageUrl: string): PageSessionFreshness {
        const state = this.states.get(pageKey);
        if (!state?.entry) {
            return {status: 'missing', refreshReason: 'missing-snapshot'};
        }
        if (state.entry.pageUrl !== pageUrl) {
            return {status: 'navigation', refreshReason: 'navigation'};
        }
        if (state.dirtyRevision > state.appliedDirtyRevision) {
            return {status: 'dirty', refreshReason: 'dirty-interaction'};
        }
        return {status: 'fresh'};
    }

    public markDirty(pageKey: Key, _reason: 'interaction'): void {
        const state = this.stateFor(pageKey);
        state.dirtyRevision += 1;
    }

    public async ensureFresh(
        input: EnsureFreshPageSessionInput<Key>,
    ): Promise<PageSnapshotSessionEntry> {
        const state = this.stateFor(input.pageKey);
        if (state.inFlight) {
            const activeRefresh = state.inFlight;
            await activeRefresh;
            if (state.inFlight === activeRefresh) {state.inFlight = undefined;}
            return this.ensureFresh(input);
        }

        const refreshReason = this.resolveRefreshReason(state, input);
        if (!refreshReason && state.entry) {return state.entry;}

        const appliedDirtyRevision = state.dirtyRevision;
        const refresh = this.captureEntry(state, input, refreshReason || 'missing-snapshot', appliedDirtyRevision);
        state.inFlight = refresh;
        try {
            return await refresh;
        } finally {
            if (state.inFlight === refresh) {state.inFlight = undefined;}
        }
    }

    public createAnchor(pageKey: Key, nodeId: ObservationNodeId): ObservationAnchor | undefined {
        const observation = this.states.get(pageKey)?.entry?.capture.control.observation;
        return observation ? createObservationAnchor(observation, nodeId) : undefined;
    }

    public resolveAnchor(pageKey: Key, anchor: ObservationAnchor): AnchorResolution {
        const observation = this.states.get(pageKey)?.entry?.capture.control.observation;
        return observation
            ? resolveObservationAnchor(anchor, observation)
            : {status: 'stale', evidence: [missingSessionEvidence(anchor.nodeId)]};
    }

    public confirmSelection(
        pageKey: Key,
        nodeId: ObservationNodeId,
    ): PageSessionSelectionConfirmation {
        const state = this.states.get(pageKey);
        const observation = state?.entry?.capture.control.observation;
        if (!state || !observation) {return {ok: false, reason: 'missing-session'};}
        const anchor = createObservationAnchor(observation, nodeId);
        if (!anchor) {return {ok: false, reason: 'unanchorable-node'};}
        const resolution = resolveObservationAnchor(anchor, observation);
        if (resolution.status !== 'resolved') {
            return {ok: false, reason: 'non-unique-identity', resolution};
        }
        state.selectionAnchor = cloneAnchor(anchor);
        return {
            ok: true,
            selection: {
                status: 'resolved',
                anchor: cloneAnchor(anchor),
                nodeId: resolution.nodeId,
                evidence: cloneEvidence(resolution.evidence),
            },
        };
    }

    public clearSelection(pageKey: Key): void {
        const state = this.states.get(pageKey);
        if (state) {state.selectionAnchor = undefined;}
    }

    public readSelection(pageKey: Key): PageSessionSelection {
        const state = this.states.get(pageKey);
        if (!state?.selectionAnchor) {return {status: 'none'};}
        const observation = state.entry?.capture.control.observation;
        if (!observation) {
            return {
                status: 'stale',
                anchor: cloneAnchor(state.selectionAnchor),
                evidence: [missingSessionEvidence(state.selectionAnchor.nodeId)],
            };
        }
        return selectionFromResolution(
            state.selectionAnchor,
            resolveObservationAnchor(state.selectionAnchor, observation),
        );
    }

    public resolveSelectionForObservation(
        pageKey: Key,
        observation: PageObservation,
    ): PageSessionSelection {
        const anchor = this.states.get(pageKey)?.selectionAnchor;
        return anchor
            ? selectionFromResolution(anchor, resolveObservationAnchor(anchor, observation))
            : {status: 'none'};
    }

    public upsertManualSemanticBinding(
        pageKey: Key,
        draft: ManualSemanticBindingDraft,
    ): ManualSemanticBindingWriteResult {
        const state = this.states.get(pageKey);
        const observation = state?.entry?.capture.control.observation;
        if (!state?.entry || !observation) {return {ok: false, reason: 'missing-session'};}
        if (!new Map(Object.entries(observation.nodes)).has(draft.nodeId)) {
            return {ok: false, reason: 'unknown-node'};
        }
        const anchor = createObservationAnchor(observation, draft.nodeId);
        if (!anchor) {return {ok: false, reason: 'unanchorable-node'};}
        const resolution = resolveObservationAnchor(anchor, observation);
        if (resolution.status !== 'resolved') {return {ok: false, reason: 'non-unique-identity'};}

        const bindingId = normalizeManualBindingId(draft.id);
        const binding: SemanticBusinessBinding = {
            id: bindingId,
            profileName: '@manual',
            ruleId: bindingId,
            planStepId: bindingId,
            domain: draft.domain ?? 'node',
            targetKind: 'node',
            origin: 'manual',
            disposition: 'active',
            status: 'active',
            annotation: cloneSemanticAnnotation({
                ...draft.annotation,
                ruleId: bindingId,
                origin: 'manual',
                disposition: 'active',
            }),
            target: {
                componentIds: [],
                nodeIds: [resolution.nodeId],
                fieldIds: [],
                actionIds: [],
                rowIds: [],
                columnIds: [],
            },
        };
        const next = Object.values(state.manualBindings.byId)
            .filter((current) => current.id !== bindingId)
            .map(cloneBinding);
        next.push(binding);
        state.manualAnchors.set(bindingId, cloneAnchor(anchor));
        const manualBindings = buildSemanticBindingIndexes(next);
        const entry = this.applyManualBindings(state, manualBindings);
        return {ok: true, entry, binding: cloneBinding(binding)};
    }

    public ignoreManualSemanticBindings(
        pageKey: Key,
        bindingIds: readonly string[],
    ): ManualSemanticBindingIgnoreResult {
        const state = this.states.get(pageKey);
        if (!state?.entry) {return {ok: false, reason: 'missing-session'};}
        const normalizedIds = [...new Set(bindingIds.map(normalizeManualBindingId))];
        const currentById = new Map(Object.entries(state.manualBindings.byId));
        if (normalizedIds.some((bindingId) => !currentById.has(bindingId))) {
            return {ok: false, reason: 'unknown-binding'};
        }
        const ignored = new Set(normalizedIds);
        const bindings = Object.values(state.manualBindings.byId).map((binding) => {
            const next = cloneBinding(binding);
            if (ignored.has(next.id)) {
                next.disposition = 'ignored';
                next.annotation.disposition = 'ignored';
            }
            return next;
        });
        const manualBindings = buildSemanticBindingIndexes(bindings, state.manualBindings.diagnostics);
        const entry = this.applyManualBindings(state, manualBindings);
        return {
            ok: true,
            entry,
            bindings: normalizedIds.map((bindingId) => cloneBinding(manualBindings.byId[bindingId])),
        };
    }

    private stateFor(pageKey: Key): MutablePageSessionState {
        const current = this.states.get(pageKey);
        if (current) {return current;}
        const created: MutablePageSessionState = {
            dirtyRevision: 0,
            appliedDirtyRevision: 0,
            manualBindings: buildSemanticBindingIndexes([]),
            manualAnchors: new Map(),
        };
        this.states.set(pageKey, created);
        return created;
    }

    private resolveRefreshReason(
        state: MutablePageSessionState,
        input: EnsureFreshPageSessionInput<Key>,
    ): PageSessionRefreshReason | undefined {
        if (!state.entry) {return 'missing-snapshot';}
        if (input.reason === 'explicit') {return 'explicit';}
        if (state.entry.pageUrl !== input.pageUrl) {return 'navigation';}
        if (state.dirtyRevision > state.appliedDirtyRevision) {return 'dirty-interaction';}
        return undefined;
    }

    private async captureEntry(
        state: MutablePageSessionState,
        input: EnsureFreshPageSessionInput<Key>,
        refreshReason: PageSessionRefreshReason,
        appliedDirtyRevision: number,
    ): Promise<PageSnapshotSessionEntry> {
        const capture = await input.capture();
        const manualBindings = remapManualBindings(state, capture.control.observation);
        state.manualBindings = manualBindings;
        const semantics = composeSemantics(state.entry, capture, manualBindings, refreshReason);
        const entry: PageSnapshotSessionEntry = Object.freeze({
            pageUrl: input.pageUrl,
            identity: {...capture.control.observation.identity},
            refreshReason,
            capture,
            semanticBindingsByProfile: Object.freeze(semantics.bindings),
            semanticSuggestionsByProfile: Object.freeze(semantics.suggestions),
        });
        state.entry = entry;
        state.appliedDirtyRevision = appliedDirtyRevision;
        return entry;
    }

    private applyManualBindings(
        state: MutablePageSessionState,
        manualBindings: SemanticBindings,
    ): PageSnapshotSessionEntry {
        state.manualBindings = manualBindings;
        const current = state.entry!;
        const entry: PageSnapshotSessionEntry = Object.freeze({
            ...current,
            semanticBindingsByProfile: Object.freeze({
                ...current.semanticBindingsByProfile,
                '@manual': manualBindings,
            }),
        });
        state.entry = entry;
        return entry;
    }
}

const composeSemantics = (
    previous: PageSnapshotSessionEntry | undefined,
    capture: PageSnapshotCapture,
    manualBindings: SemanticBindings,
    refreshReason: PageSessionRefreshReason,
): {
    bindings: Record<string, SemanticBindings>;
    suggestions: Record<string, SemanticSuggestions>;
} => {
    const bindings: Record<string, SemanticBindings> = Object.fromEntries(
        Object.entries(previous?.semanticBindingsByProfile || {}).filter(([profileName]) => profileName !== '@manual'),
    );
    const suggestions: Record<string, SemanticSuggestions> = Object.fromEntries(
        Object.entries(previous?.semanticSuggestionsByProfile || {}).filter(([profileName]) => profileName !== '@manual'),
    );
    const previousBindingsByProfile = new Map(Object.entries(previous?.semanticBindingsByProfile || {}));

    for (const [profileName, profile] of Object.entries(capture.entityRules?.profiles || {})) {
        const previousBindings = previousBindingsByProfile.get(profileName);
        bindings[profileName] = refreshReason === 'explicit'
            ? profile.semanticBindings
            : previousBindings
            ? mergeSemanticBindings(previousBindings, profile.semanticBindings).bindings
            : profile.semanticBindings;
        suggestions[profileName] = profile.semanticSuggestions;
    }

    if (Object.keys(manualBindings.byId).length > 0) {bindings['@manual'] = manualBindings;}
    return {bindings, suggestions};
};

const missingSessionEvidence = (nodeId: ObservationNodeId): Evidence => ({
    code: 'anchor.session.missing',
    strength: 'exact',
    source: 'platform',
    nodeIds: [nodeId],
});
const cloneAnchor = (anchor: ObservationAnchor): ObservationAnchor => ({...anchor});

const selectionFromResolution = (
    anchor: ObservationAnchor,
    resolution: AnchorResolution,
): Exclude<PageSessionSelection, {status: 'none'}> => {
    if (resolution.status === 'resolved') {
        return {
            status: 'resolved',
            anchor: cloneAnchor(anchor),
            nodeId: resolution.nodeId,
            evidence: cloneEvidence(resolution.evidence),
        };
    }
    if (resolution.status === 'ambiguous') {
        return {
            status: 'ambiguous',
            anchor: cloneAnchor(anchor),
            candidateNodeIds: [...resolution.candidateNodeIds],
            evidence: cloneEvidence(resolution.evidence),
        };
    }
    return {
        status: 'stale',
        anchor: cloneAnchor(anchor),
        evidence: cloneEvidence(resolution.evidence),
    };
};
const cloneEvidence = (evidence: readonly Evidence[]): Evidence[] =>
    evidence.map((item) => ({...item, nodeIds: [...item.nodeIds], detail: item.detail ? {...item.detail} : undefined}));

const remapManualBindings = (
    state: MutablePageSessionState,
    observation: PageObservation,
): SemanticBindings => {
    const diagnostics: SemanticBindingDiagnostic[] = state.manualBindings.diagnostics
        .filter((item) => item.code !== 'semantic-binding.manual-target.invalidated')
        .map((item) => ({...item}));
    const bindings = Object.values(state.manualBindings.byId).map((binding) => {
        const next = cloneBinding(binding);
        const anchor = state.manualAnchors.get(binding.id);
        const resolution = anchor ? resolveObservationAnchor(anchor, observation) : undefined;
        if (resolution?.status === 'resolved') {
            next.target.nodeIds = [resolution.nodeId];
            next.status = 'active';
            return next;
        }
        next.status = 'invalidated';
        diagnostics.push({
            code: 'semantic-binding.manual-target.invalidated',
            severity: 'error',
            stage: 'page-session',
            status: 'rejected',
            nodeIds: [...next.target.nodeIds],
            evidence: resolution ? cloneEvidence(resolution.evidence) : [],
            bindingId: next.id,
            ruleId: next.ruleId,
            message: `Manual semantic binding ${next.id} no longer resolves to one exact target.`,
        });
        return next;
    });
    return buildSemanticBindingIndexes(bindings, diagnostics);
};

const cloneBinding = (binding: SemanticBusinessBinding): SemanticBusinessBinding => ({
    ...binding,
    annotation: cloneSemanticAnnotation(binding.annotation),
    target: cloneSemanticTarget(binding.target),
});

const normalizeManualBindingId = (bindingId: string): string =>
    bindingId.startsWith('@manual:') ? bindingId : `@manual:${bindingId}`;
