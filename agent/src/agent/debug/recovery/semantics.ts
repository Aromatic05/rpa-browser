import type {DslFailureDescriptor} from '../../../automation/dsl/debug/contracts';
import type {EffectReversibility} from '../../../program/effects/contracts';
import type {DebugEffectRecord} from '../effects/contracts';
import type {ExecutedEffectRisk, FailureClass} from './contracts';

export const classifyFailure = (failure: DslFailureDescriptor): FailureClass => {
    if (failure.kind === 'invariant') {return 'invariant';}
    return failure.classification === 'read' ? 'read' : 'world_effect';
};

export const effectReversibility = (record: DebugEffectRecord): EffectReversibility =>
    record.effect.semantics.reversibility;

export const compensatedEffectSequences = (
    records: readonly DebugEffectRecord[],
): ReadonlySet<number> => new Set(
    records
        .filter((record) => record.compensates && record.outcome.status === 'succeeded')
        .map((record) => record.compensates!.effectSequence),
);

export const executedEffectsSince = (
    records: readonly DebugEffectRecord[],
    effectSequence: number,
): readonly DebugEffectRecord[] => records.filter((record) =>
    record.sequence > effectSequence && !record.compensates);

export const effectsToUndoSince = (
    records: readonly DebugEffectRecord[],
    effectSequence: number,
): readonly DebugEffectRecord[] => {
    const compensated = compensatedEffectSequences(records);
    return executedEffectsSince(records, effectSequence)
        .filter((record) => !compensated.has(record.sequence));
};

export const aggregateEffectRisk = (
    records: readonly DebugEffectRecord[],
): ExecutedEffectRisk => {
    if (records.length === 0) {return 'none';}
    const risks = records.map((record) => effectReversibility(record));
    if (risks.some((risk) => risk === 'irreversible')) {return 'irreversible';}
    if (risks.some((risk) => risk === 'unknown')) {return 'unknown';}
    if (risks.some((risk) => risk === 'compensatable')) {return 'compensatable';}
    return 'reversible';
};