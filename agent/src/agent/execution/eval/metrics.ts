import type {AgentRunResult} from '../types';
import type {
    AgentEvalContextMetrics,
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
    const programs = result.programs;
    if (!programs?.every((program) => program.effects !== undefined)) {
        return null;
    }
    const effects = programs.flatMap((program) => program.effects ?? []);
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

const contextMetrics = (result: AgentRunResult): AgentEvalContextMetrics => {
    const context = result.trace.context;
    if (context === undefined) {
        return Object.freeze({
            availability: 'not-exposed' as const,
            peakChars: null,
            peakBytes: null,
            lastChars: null,
            lastBytes: null,
        });
    }
    return Object.freeze({
        availability: 'provider-visible' as const,
        peakChars: context.peakChars,
        peakBytes: context.peakBytes,
        lastChars: context.lastChars,
        lastBytes: context.lastBytes,
    });
};

export const collectAgentEvalMetrics = (
    result: AgentRunResult,
    mode: AgentEvalMode,
    taskSuccess: boolean,
    durationMs: number,
): AgentEvalMetrics => {
    const programs = result.programs;
    const journalEffects = mode === 'program' && programs?.every((program) => program.effects !== undefined)
        ? programs.flatMap((program) => program.effects ?? [])
        : null;
    const journalAvailable = journalEffects !== null;
    const worldEffectCalls = journalEffects
        ? journalEffects.length
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
        context: contextMetrics(result),
        repair: repairMetrics(result),
    };
};
