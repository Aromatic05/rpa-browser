import type {AgentRunResult} from '../types';
import type {AgentEvalMetrics, AgentEvalMode, AgentEvalRepairMetrics} from './contracts';

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

export const collectAgentEvalMetrics = (
    result: AgentRunResult,
    mode: AgentEvalMode,
): AgentEvalMetrics => {
    const journalAvailable = mode === 'program'
        && result.programs !== undefined
        && result.programs.every((program) => program.effects !== undefined);
    const worldEffectCalls = journalAvailable
        ? result.programs!.reduce((count, program) => count + (program.effects?.length ?? 0), 0)
        : null;
    return {
        turns: result.trace.metrics.turns,
        toolCalls: result.trace.metrics.toolCalls,
        readCalls: result.trace.metrics.readCalls,
        controlCalls: result.trace.metrics.controlCalls,
        failedToolCalls: result.trace.metrics.failedToolCalls,
        postErrorEffectCalls: result.trace.metrics.postErrorEffectCalls,
        effects: {
            toolEffectCalls: result.trace.metrics.effectCalls,
            worldEffectCalls,
            availability: journalAvailable ? 'program-journal' : 'not-exposed',
        },
        repair: repairMetrics(result),
    };
};
