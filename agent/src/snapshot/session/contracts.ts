import type {ControlSnapshot} from '../components/control/model/contracts';
import type {FormSnapshot} from '../components/form/model/contracts';
import type {TableSnapshot} from '../components/table/model/contracts';
import type {
    AnchorResolution,
    ObservationAnchor,
    ObservationIdentity,
    ObservationNodeId,
} from '../observation/model/contracts';
import type {EntityRulesExecutionResult} from '../rules/runtime/matcher';
import type {SemanticBindings, SemanticSuggestions} from '../rules/semantic/contracts';

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
};
