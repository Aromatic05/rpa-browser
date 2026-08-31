import type {
    AgentProgramEffectSummary,
    AgentProgramExecutionSummary,
    AgentRunResult,
} from '../execution/types';
import type {AgentToolTrace, AgentTraceContextMetrics, AgentTraceSnapshot} from '../trace/collector';
import {
    AGENT_RUN_REPORT_SCHEMA,
    AGENT_RUN_REPORT_SCHEMA_VERSION,
    type AgentReportContextMetrics,
    type AgentReportContextTurn,
    type AgentReportEffect,
    type AgentReportError,
    type AgentReportExecutionMode,
    type AgentReportObservedWorldRevision,
    type AgentReportProgram,
    type AgentReportRepairMetrics,
    type AgentReportSavedArtifact,
    type AgentReportTerminal,
    type AgentReportToolCall,
    type AgentReportToolMetrics,
    type AgentReportWorldRevision,
    type AgentRunReport,
    type AgentRunReportOptions,
} from './contracts';
import {redactSecretValues} from './privacy';

const REPAIR_TOOL_NAMES: Record<keyof AgentReportRepairMetrics, readonly string[]> = {
    rewindCalls: ['debug.rewind'],
    rollbackCalls: ['debug.rollback'],
    patchCalls: ['debug.patch_statement', 'debug.patch_program', 'debug.unpatch_program'],
    recomputeCalls: ['debug.recompute', 'debug.recompute_effect'],
    refreshCalls: ['debug.refresh'],
};

const revisionOf = (revision: {pageEpoch: string; captureRevision: number}): AgentReportWorldRevision =>
    Object.freeze({pageEpoch: revision.pageEpoch, captureRevision: revision.captureRevision});

const compareRevisions = (
    left: AgentReportWorldRevision,
    right: AgentReportWorldRevision,
): number => left.pageEpoch === right.pageEpoch
    ? left.captureRevision - right.captureRevision
    : left.pageEpoch < right.pageEpoch ? -1 : 1;

const distinctRevisions = (
    revisions: readonly AgentReportWorldRevision[],
): readonly AgentReportWorldRevision[] => {
    const unique = new Map<string, AgentReportWorldRevision>();
    for (const revision of revisions) {
        unique.set(`${revision.pageEpoch}#${revision.captureRevision}`, revision);
    }
    return Object.freeze([...unique.values()].sort(compareRevisions));
};

const observedRevision = (
    revision: AgentToolTrace['worldBefore'],
): AgentReportObservedWorldRevision | null => revision === undefined || revision === null
    ? null
    : Object.freeze({
        pageEpoch: revision.pageEpoch,
        captureRevision: revision.captureRevision,
        freshness: revision.freshness,
    });

const countToolCalls = (trace: AgentTraceSnapshot, names: readonly string[]): number =>
    trace.tools.filter((tool) => names.includes(tool.toolName)).length;

const repairMetrics = (trace: AgentTraceSnapshot): AgentReportRepairMetrics => Object.freeze({
    rewindCalls: countToolCalls(trace, REPAIR_TOOL_NAMES.rewindCalls),
    rollbackCalls: countToolCalls(trace, REPAIR_TOOL_NAMES.rollbackCalls),
    patchCalls: countToolCalls(trace, REPAIR_TOOL_NAMES.patchCalls),
    recomputeCalls: countToolCalls(trace, REPAIR_TOOL_NAMES.recomputeCalls),
    refreshCalls: countToolCalls(trace, REPAIR_TOOL_NAMES.refreshCalls),
});

const toolCallOf = (tool: AgentToolTrace): AgentReportToolCall => {
    const redaction = redactSecretValues(tool.args);
    return Object.freeze({
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        classification: tool.classification,
        isError: tool.isError ?? null,
        startedAt: tool.startedAt,
        ...(tool.endedAt === undefined ? {} : {endedAt: tool.endedAt}),
        durationMs: tool.endedAt === undefined ? null : tool.endedAt - tool.startedAt,
        args: redaction.value,
        redactedPaths: redaction.redactedPaths,
        worldBefore: observedRevision(tool.worldBefore),
        worldAfter: observedRevision(tool.worldAfter),
    });
};

const errorOf = (
    error: Readonly<{code: string; message: string; details?: unknown}> | undefined,
): AgentReportError | undefined => {
    if (!error) {return undefined;}
    return Object.freeze({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : {details: redactSecretValues(error.details).value}),
    });
};

const programOf = (
    program: AgentProgramExecutionSummary,
    index: number,
): AgentReportProgram => {
    const error = errorOf(program.error);
    return Object.freeze({
        index,
        status: program.status,
        source: program.source,
        ...(program.materializedSource === undefined ? {} : {materializedSource: program.materializedSource}),
        inputKeys: Object.freeze(Object.keys(program.input).sort()),
        ...(program.text === undefined || program.text === '' ? {} : {output: program.text}),
        ...(error === undefined ? {} : {error}),
        effectsExposed: program.effects !== undefined,
        effectCount: program.effects === undefined ? null : program.effects.length,
    });
};

const effectWorldChanged = (effect: AgentProgramEffectSummary): boolean =>
    effect.worldBefore.pageEpoch !== effect.worldAfter.pageEpoch
    || effect.worldBefore.captureRevision !== effect.worldAfter.captureRevision;

const effectsOf = (
    programs: readonly AgentProgramExecutionSummary[],
    executionMode: AgentReportExecutionMode,
): AgentRunReport['effects'] => {
    const journalAvailable = executionMode === 'program'
        && programs.length > 0
        && programs.every((program) => program.effects !== undefined);
    if (!journalAvailable) {
        return Object.freeze({
            availability: 'not-exposed',
            worldEffectCalls: null,
            failedWorldChangingEffects: Object.freeze([]),
            compensationEffects: Object.freeze([]),
            records: Object.freeze([]),
        });
    }
    const records: AgentReportEffect[] = [];
    for (const [programIndex, program] of programs.entries()) {
        for (const effect of program.effects!) {
            records.push(Object.freeze({
                programIndex,
                sequence: effect.sequence,
                stepName: effect.stepName,
                status: effect.status,
                worldChanged: effectWorldChanged(effect),
                worldBefore: revisionOf(effect.worldBefore),
                worldAfter: revisionOf(effect.worldAfter),
                ...(effect.compensates === undefined ? {} : {compensates: effect.compensates}),
                compensatedBy: Object.freeze(
                    program.effects!
                        .filter((candidate) => candidate.compensates === effect.sequence)
                        .map((candidate) => candidate.sequence),
                ),
            }));
        }
    }
    return Object.freeze({
        availability: 'program-journal',
        worldEffectCalls: records.length,
        failedWorldChangingEffects: Object.freeze(records.filter(
            (effect) => effect.status === 'failed' && effect.worldChanged,
        )),
        compensationEffects: Object.freeze(records.filter((effect) => effect.compensates !== undefined)),
        records: Object.freeze(records),
    });
};

const terminalOf = (
    result: AgentRunResult,
    programs: readonly AgentProgramExecutionSummary[],
): AgentReportTerminal => {
    const latest = programs.at(-1);
    if (!latest) {
        return Object.freeze({
            status: 'completed' as const,
            ...(result.text === '' ? {} : {output: result.text}),
        });
    }
    const output = latest.text ?? result.text;
    return Object.freeze({
        status: latest.status,
        ...(output === '' ? {} : {output}),
        ...(latest.error === undefined ? {} : {error: errorOf(latest.error)!}),
    });
};

const savedArtifactsOf = (
    result: AgentRunResult,
): readonly AgentReportSavedArtifact[] => Object.freeze(
    (result.savedPrograms ?? []).map((artifact) => Object.freeze({
        kind: 'program' as const,
        name: artifact.name,
        artifactRevision: artifact.artifactRevision,
    })),
);

const contextTurnOf = (turn: AgentReportContextTurn): AgentReportContextTurn => Object.freeze({
    turn: turn.turn,
    chars: turn.chars,
    bytes: turn.bytes,
    ...(turn.exceededBudget === undefined ? {} : {exceededBudget: turn.exceededBudget}),
});

const contextOf = (context: AgentTraceContextMetrics | undefined): AgentReportContextMetrics | undefined => {
    if (context === undefined) {
        return undefined;
    }
    return Object.freeze({
        lastChars: context.lastChars,
        lastBytes: context.lastBytes,
        peakChars: context.peakChars,
        peakBytes: context.peakBytes,
        turns: Object.freeze(context.turns.map(contextTurnOf)),
    });
};

export const buildAgentRunReport = (
    result: AgentRunResult,
    options?: AgentRunReportOptions,
): AgentRunReport => {
    const executionMode: AgentReportExecutionMode = result.executionMode ?? 'unknown';
    const programs = result.programs ?? [];
    const effects = effectsOf(programs, executionMode);
    const traceRevisions = result.trace.tools.flatMap((tool) => [tool.worldBefore, tool.worldAfter]
        .filter((revision): revision is NonNullable<AgentToolTrace['worldBefore']> =>
            revision !== null && revision !== undefined)
        .map(revisionOf));
    const journalRevisions = effects.records.flatMap((effect) => [effect.worldBefore, effect.worldAfter]);
    const terminal = terminalOf(result, programs);
    const context = contextOf(result.trace.context);
    const toolMetrics: AgentReportToolMetrics = Object.freeze({
        turns: result.trace.metrics.turns,
        toolCalls: result.trace.metrics.toolCalls,
        readCalls: result.trace.metrics.readCalls,
        controlCalls: result.trace.metrics.controlCalls,
        effectCalls: result.trace.metrics.effectCalls,
        failedToolCalls: result.trace.metrics.failedToolCalls,
        postErrorEffectCalls: result.trace.metrics.postErrorEffectCalls,
        repair: repairMetrics(result.trace),
    });
    return Object.freeze({
        schema: AGENT_RUN_REPORT_SCHEMA,
        schemaVersion: AGENT_RUN_REPORT_SCHEMA_VERSION,
        run: Object.freeze({
            provider: result.provider,
            model: result.model,
            executionMode,
        }),
        terminal,
        toolMetrics,
        world: Object.freeze({
            revisionsObserved: distinctRevisions([...traceRevisions, ...journalRevisions]),
        }),
        toolCalls: Object.freeze(result.trace.tools.map(toolCallOf)),
        effects,
        programs: Object.freeze(programs.map(programOf)),
        savedArtifacts: savedArtifactsOf(result),
        ...(context === undefined ? {} : {context}),
        ...(options?.generatedAt === undefined ? {} : {generatedAt: options.generatedAt}),
    });
};
