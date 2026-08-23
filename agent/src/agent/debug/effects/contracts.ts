import type {DslAfterEffectEvent, DslBeforeEffectEvent, DslEffectDescriptor, DslEffectOutcome, DslStatementLocation} from '../../../dsl/debug/contracts';
import type {WorldViewDescriptor} from '../../worldview/contracts';

export type DebugEffectRecord = Readonly<{
    sequence: number;
    location: DslStatementLocation;
    effect: DslEffectDescriptor;
    outcome: DslEffectOutcome;
    worldBefore: WorldViewDescriptor;
    worldAfter: WorldViewDescriptor;
}>;

export type DebugEffectJournal = {
    begin: (event: DslBeforeEffectEvent, worldBefore: WorldViewDescriptor) => void;
    finish: (event: DslAfterEffectEvent, worldAfter: WorldViewDescriptor) => void;
    list: () => readonly DebugEffectRecord[];
};
