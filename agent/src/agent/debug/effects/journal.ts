import type {DslBeforeEffectEvent} from '../../../dsl/debug/contracts';
import type {WorldViewDescriptor} from '../../worldview/contracts';
import type {DebugEffectJournal, DebugEffectRecord} from './contracts';

type PendingEffect = Readonly<{
    event: DslBeforeEffectEvent;
    worldBefore: WorldViewDescriptor;
}>;

export const createDebugEffectJournal = (): DebugEffectJournal => {
    const pending = new Map<string, PendingEffect>();
    const records: DebugEffectRecord[] = [];

    return {
        begin: (event, worldBefore) => {
            pending.set(event.effect.stepId, Object.freeze({event, worldBefore}));
        },
        finish: (event, worldAfter) => {
            const started = pending.get(event.effect.stepId);
            if (!started) {
                throw new Error(`effect journal entry was not started: ${event.effect.stepId}`);
            }
            pending.delete(event.effect.stepId);
            records.push(Object.freeze({
                sequence: records.length + 1,
                location: started.event.location,
                effect: started.event.effect,
                outcome: event.outcome,
                worldBefore: started.worldBefore,
                worldAfter,
            }));
        },
        list: () => Object.freeze([...records]),
    };
};
