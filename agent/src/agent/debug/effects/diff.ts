import {diffWorldViews} from '../../worldview/diff';
import type {DebugEffectDiffResult, DebugEffectJournal} from './contracts';

export const diffDebugEffect = (
    journal: DebugEffectJournal,
    effectSequence: number,
): DebugEffectDiffResult => {
    if (!Number.isInteger(effectSequence) || effectSequence < 1) {
        return {
            ok: false,
            error: {code: 'ERR_NOT_FOUND', message: `effect journal entry not found: ${effectSequence}`},
        };
    }
    const entry = journal.read(effectSequence);
    if (!entry) {
        return {
            ok: false,
            error: {code: 'ERR_NOT_FOUND', message: `effect journal entry not found: ${effectSequence}`},
        };
    }
    const delta = diffWorldViews(entry.worldBefore, entry.worldAfter);
    if (!delta.ok) {return delta;}
    return Object.freeze({
        ok: true as const,
        effectSequence,
        worldBefore: delta.worldBefore,
        worldAfter: delta.worldAfter,
        diff: delta.diff,
    });
};
