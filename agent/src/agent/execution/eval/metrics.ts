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
): AgentEvalMetrics => ({
    turns: result.trace.metrics.turns,
    toolCalls: result.trace.metrics.toolCalls,
    readCalls: result.trace.metrics.readCalls,
    controlCalls: result.trace.metrics.controlCalls,
    failedToolCalls: result.trace.metrics.failedToolCalls,
    postErrorEffectCalls: result.trace.metrics.postErrorEffectCalls,
    effects: mode === 'react-baseline'
        ? {
            toolEffectCalls: result.trace.metrics.effectCalls,
            worldEffectCalls: result.trace.metrics.effectCalls,
            availability: 'tool-trace',
        }
        : {
            toolEffectCalls: result.trace.metrics.effectCalls,
            worldEffectCalls: null,
            availability: 'not-exposed',
        },
    repair: repairMetrics(result),
});
