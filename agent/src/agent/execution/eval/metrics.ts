import type {AgentRunResult} from '../types';
import type {
    AgentEvalEffectMetrics,
    AgentEvalMetrics,
    AgentEvalMode,
    AgentEvalRepairMetrics,
} from './contracts';

const countTools = (result: AgentRunResult, names: ReadonlySet<string>): number =>
    result.trace.tools.filter((tool) => names.has(tool.toolName)).length;

const repairMetrics = (result: AgentRunResult): AgentEvalRepairMetrics => ({
    rewindCalls: countTools(result, new Set(['debug.rewind'])),
    rollbackCalls: countTools(result, new Set(['debug.rollback'])),
    patchCalls: countTools(result, new Set([
        'debug.patch_statement',
        'debug.patch_program',
        'debug.unpatch_program',
    ])),
    recomputeCalls: countTools(result, new Set(['debug.recompute', 'debug.recompute_effect'])),
    refreshCalls: countTools(result, new Set(['debug.refresh'])),
});

const isWorldChanging = (
    before: {pageEpoch: string; captureRevision: number},
    after: {pageEpoch: string; captureRevision: number},
): boolean =>
    before.pageEpoch !== after.pageEpoch || before.captureRevision !== after.captureRevision;

/**
 * Compute whether a failed world-changing effect was recovered.
 *
 * - Program mode with a journal can observe this directly.
 * - `react-baseline` cannot observe world-effect journals, so it is `null`.
 * - Program mode without effect exposure is also `null` (unknown, not zero).
 */
export const computeRecoverySuccess = (
    result: AgentRunResult,
    mode: AgentEvalMode,
): boolean | null => {
    if (mode !== 'program') {
        return null;
    }
    const journalAvailable = result.programs !== undefined
        && result.programs.every((program) => program.effects !== undefined);
    if (!journalAvailable) {
        return null;
    }
    const effects = result.programs!.flatMap((program) => program.effects ?? []);
    const failedWorldChanging = effects.filter(
        (effect) => effect.status === 'failed'
            && isWorldChanging(effect.worldBefore, effect.worldAfter),
    );
    if (failedWorldChanging.length === 0) {
        return true;
    }
    const compensationCount = effects.filter((effect) => effect.compensates !== undefined).length;
    const rollbackCount = countTools(result, new Set(['debug.rollback']));
    return compensationCount >= failedWorldChanging.length || rollbackCount > 0;
};

export const collectAgentEvalMetrics = (
    result: AgentRunResult,
    mode: AgentEvalMode,
    taskSuccess: boolean,
    durationMs: number,
): AgentEvalMetrics => {
    const journalAvailable = mode === 'program'
        && result.programs !== undefined
        && result.programs.every((program) => program.effects !== undefined);
    const worldEffectCalls = journalAvailable
        ? result.programs!.reduce((count, program) => count + (program.effects?.length ?? 0), 0)
        : null;
    const journalEffects = journalAvailable
        ? result.programs!.flatMap((program) => program.effects ?? [])
        : null;
    const failedWorldChangingEffects = journalEffects
        ? journalEffects.filter(
            (effect) => effect.status === 'failed'
                && isWorldChanging(effect.worldBefore, effect.worldAfter),
        ).length
        : null;
    const compensationEffects = journalEffects
        ? journalEffects.filter((effect) => effect.compensates !== undefined).length
        : null;

    const effects: AgentEvalEffectMetrics = {
        toolEffectCalls: result.trace.metrics.effectCalls,
        worldEffectCalls,
        failedWorldChangingEffects,
        compensationEffects,
        availability: journalAvailable ? 'program-journal' : 'not-exposed',
    };

    return {
        turns: result.trace.metrics.turns,
        toolCalls: result.trace.metrics.toolCalls,
        readCalls: result.trace.metrics.readCalls,
        controlCalls: result.trace.metrics.controlCalls,
        effectCalls: result.trace.metrics.effectCalls,
        failedToolCalls: result.trace.metrics.failedToolCalls,
        postErrorEffectCalls: result.trace.metrics.postErrorEffectCalls,
        taskSuccess,
        recoverySuccess: computeRecoverySuccess(result, mode),
        durationMs,
        effects,
        repair: repairMetrics(result),
    };
};
