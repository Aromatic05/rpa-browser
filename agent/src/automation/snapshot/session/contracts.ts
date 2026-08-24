import type {ControlSnapshot} from '../components/control/model/contracts';
import type {FormSnapshot} from '../components/form/model/contracts';
import type {TableSnapshot} from '../components/table/model/contracts';
import type {
    AnchorResolution,
    Evidence,
    ObservationAnchor,
    ObservationIdentity,
    ObservationNodeId,
    PageObservation,
} from '../observation/model/contracts';
import type {EntityRulesExecutionResult} from '../rules/runtime/matcher';
import type {
    SemanticAnnotationRecord,
    SemanticBindingDomain,
    SemanticBindings,
    SemanticBusinessBinding,
    SemanticSuggestions,
} from '../rules/semantic/contracts';

export type PageSessionRefreshReason =
    | 'missing-snapshot'
    | 'dirty-interaction'
    | 'navigation'
    | 'explicit';

export type PageSessionFreshness =
    | {status: 'missing'; refreshReason: 'missing-snapshot'}
    | {status: 'dirty'; refreshReason: 'dirty-interaction'}
    | {status: 'navigation'; refreshReason: 'navigation'}
    | {status: 'fresh'};

export type PageSessionSelection =
    | {status: 'none'}
    | {status: 'resolved'; anchor: ObservationAnchor; nodeId: ObservationNodeId; evidence: Evidence[]}
    | {status: 'ambiguous'; anchor: ObservationAnchor; candidateNodeIds: ObservationNodeId[]; evidence: Evidence[]}
    | {status: 'stale'; anchor: ObservationAnchor; evidence: Evidence[]};

export type PageSessionSelectionConfirmation =
    | {ok: true; selection: Extract<PageSessionSelection, {status: 'resolved'}>}
    | {ok: false; reason: 'missing-session' | 'unanchorable-node' | 'non-unique-identity'; resolution?: AnchorResolution};

export type ManualSemanticBindingDraft = {
    id: string;
    nodeId: ObservationNodeId;
    domain?: SemanticBindingDomain;
    annotation: Omit<SemanticAnnotationRecord, 'ruleId' | 'origin' | 'disposition'>;
};

export type ManualSemanticBindingWriteResult =
    | {ok: true; entry: PageSnapshotSessionEntry; binding: SemanticBusinessBinding}
    | {ok: false; reason: 'missing-session' | 'unknown-node' | 'unanchorable-node' | 'non-unique-identity'};

export type ManualSemanticBindingIgnoreResult =
    | {ok: true; entry: PageSnapshotSessionEntry; bindings: SemanticBusinessBinding[]}
    | {ok: false; reason: 'missing-session' | 'unknown-binding'};

export type PageSnapshotCapture = {
    control: ControlSnapshot;
    form: FormSnapshot;
    table: TableSnapshot;
    entityRules?: EntityRulesExecutionResult;
};

export type PageSnapshotSessionEntry = {
    pageUrl: string;
    identity: ObservationIdentity;
    refreshReason: PageSessionRefreshReason;
    capture: PageSnapshotCapture;
    semanticBindingsByProfile: Readonly<Record<string, SemanticBindings>>;
    semanticSuggestionsByProfile: Readonly<Record<string, SemanticSuggestions>>;
};

export type EnsureFreshPageSessionInput<Key extends object> = {
    pageKey: Key;
    pageUrl: string;
    reason?: 'explicit';
    capture: () => Promise<PageSnapshotCapture>;
};

export type PageSnapshotSessionPort<Key extends object> = {
    read: (pageKey: Key) => PageSnapshotSessionEntry | undefined;
    readFreshness: (pageKey: Key, pageUrl: string) => PageSessionFreshness;
    markDirty: (pageKey: Key, reason: 'interaction') => void;
    ensureFresh: (input: EnsureFreshPageSessionInput<Key>) => Promise<PageSnapshotSessionEntry>;
    createAnchor: (pageKey: Key, nodeId: ObservationNodeId) => ObservationAnchor | undefined;
    resolveAnchor: (pageKey: Key, anchor: ObservationAnchor) => AnchorResolution;
    confirmSelection: (pageKey: Key, nodeId: ObservationNodeId) => PageSessionSelectionConfirmation;
    clearSelection: (pageKey: Key) => void;
    readSelection: (pageKey: Key) => PageSessionSelection;
    resolveSelectionForObservation: (pageKey: Key, observation: PageObservation) => PageSessionSelection;
    upsertManualSemanticBinding: (
        pageKey: Key,
        draft: ManualSemanticBindingDraft,
    ) => ManualSemanticBindingWriteResult;
    ignoreManualSemanticBindings: (
        pageKey: Key,
        bindingIds: readonly string[],
    ) => ManualSemanticBindingIgnoreResult;
};
