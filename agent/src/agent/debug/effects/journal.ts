import type {DslBeforeEffectEvent} from '../../../dsl/debug/contracts';
import {describeWorldView} from '../../worldview/descriptor';
import type {WorldView} from '../../worldview/contracts';
import type {DebugEffectJournal, DebugEffectJournalEntry} from './contracts';

type PendingEffect = Readonly<{
    event: DslBeforeEffectEvent;
    worldBefore: WorldView;
}>;

export const createDebugEffectJournal = (): DebugEffectJournal => {
    const pending = new Map<string, PendingEffect>();
    const entries: DebugEffectJournalEntry[] = [];

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
            const record = Object.freeze({
                sequence: entries.length + 1,
                location: started.event.location,
                effect: started.event.effect,
                outcome: event.outcome,
                worldBefore: describeWorldView(started.worldBefore),
                worldAfter: describeWorldView(worldAfter),
            });
            entries.push(Object.freeze({record, worldBefore: started.worldBefore, worldAfter}));
        },
        list: () => Object.freeze(entries.map((entry) => entry.record)),
        read: (sequence) => entries[sequence - 1] ?? null,
    };
};
