import type {DslAfterEffectEvent, DslBeforeEffectEvent, DslEffectDescriptor, DslEffectOutcome, DslStatementLocation} from '../../../automation/dsl/debug/contracts';
import type {WorldView, WorldViewDescriptor} from '../../worldview/contracts';
import type {SnapshotProjectionDiffResult} from '../../../automation/snapshot/projection';

export type DebugEffectRecord = Readonly<{
    sequence: number;
    location: DslStatementLocation;
    effect: DslEffectDescriptor;
    outcome: DslEffectOutcome;
    worldBefore: WorldViewDescriptor;
    worldAfter: WorldViewDescriptor;
    compensates?: Readonly<{effectSequence: number}>;
}>;

export type DebugEffectJournalEntry = Readonly<{
    record: DebugEffectRecord;
    worldBefore: WorldView;
    worldAfter: WorldView;
}>;

export type DebugEffectDiffResult =
    | Readonly<{
        ok: true;
        effectSequence: number;
        worldBefore: WorldViewDescriptor;
        worldAfter: WorldViewDescriptor;
        diff: SnapshotProjectionDiffResult;
    }>
    | Readonly<{
        ok: false;
        error: Readonly<{
            code: 'ERR_NOT_FOUND' | 'ERR_WORLD_DIFF';
            message: string;
            details?: unknown;
        }>;
    }>;

export type DebugEffectJournal = {
    begin: (
        event: DslBeforeEffectEvent,
        worldBefore: WorldView,
        metadata?: Readonly<{compensates?: Readonly<{effectSequence: number}>}>,
    ) => void;
    finish: (event: DslAfterEffectEvent, worldAfter: WorldView) => void;
    list: () => readonly DebugEffectRecord[];
    read: (sequence: number) => DebugEffectJournalEntry | null;
};
