import {z} from 'zod';
import {
    AGENT_RUN_REPORT_SCHEMA,
    AGENT_RUN_REPORT_SCHEMA_VERSION,
    type AgentRunReport,
} from './contracts';

const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {return value.map(stableValue);}
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, entry]) => entry !== undefined)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, entry]) => [key, stableValue(entry)]),
        );
    }
    return value;
};

const worldRevisionSchema = z.object({
    pageEpoch: z.string(),
    captureRevision: z.number().int(),
}).strict();

const observedWorldRevisionSchema = z.object({
    pageEpoch: z.string(),
    captureRevision: z.number().int(),
    freshness: z.enum(['missing', 'dirty', 'navigation', 'fresh']),
}).strict();

const errorSchema = z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
}).strict();

const terminalSchema = z.object({
    status: z.enum(['completed', 'paused', 'failed', 'aborted', 'invalid']),
    output: z.string().optional(),
    error: errorSchema.optional(),
}).strict();

const repairMetricsSchema = z.object({
    rewindCalls: z.number().int(),
    rollbackCalls: z.number().int(),
    patchCalls: z.number().int(),
    recomputeCalls: z.number().int(),
    refreshCalls: z.number().int(),
}).strict();

const toolMetricsSchema = z.object({
    turns: z.number().int(),
    toolCalls: z.number().int(),
    readCalls: z.number().int(),
    controlCalls: z.number().int(),
    effectCalls: z.number().int(),
    failedToolCalls: z.number().int(),
    postErrorEffectCalls: z.number().int(),
    repair: repairMetricsSchema,
}).strict();

const toolCallSchema = z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    classification: z.enum(['read', 'effect', 'control']),
    isError: z.union([z.boolean(), z.null()]),
    startedAt: z.number().int(),
    endedAt: z.number().int().optional(),
    durationMs: z.union([z.number().int(), z.null()]),
    args: z.unknown(),
    redactedPaths: z.array(z.string()),
    worldBefore: z.union([observedWorldRevisionSchema, z.null()]),
    worldAfter: z.union([observedWorldRevisionSchema, z.null()]),
}).strict();

const worldSchema = z.object({
    revisionsObserved: z.array(worldRevisionSchema),
}).strict();

const effectSchema = z.object({
    programIndex: z.number().int(),
    sequence: z.number().int(),
    stepName: z.string(),
    status: z.enum(['succeeded', 'failed']),
    worldChanged: z.boolean(),
    worldBefore: worldRevisionSchema,
    worldAfter: worldRevisionSchema,
    compensates: z.number().int().optional(),
    compensatedBy: z.array(z.number().int()),
}).strict();

const effectsSchema = z.object({
    availability: z.enum(['program-journal', 'not-exposed']),
    worldEffectCalls: z.union([z.number().int(), z.null()]),
    failedWorldChangingEffects: z.array(effectSchema),
    compensationEffects: z.array(effectSchema),
    records: z.array(effectSchema),
}).strict();

const programSchema = z.object({
    index: z.number().int(),
    status: z.enum(['completed', 'paused', 'failed', 'aborted', 'invalid']),
    source: z.string(),
    materializedSource: z.string().optional(),
    inputKeys: z.array(z.string()),
    output: z.string().optional(),
    error: errorSchema.optional(),
    effectsExposed: z.boolean(),
    effectCount: z.union([z.number().int(), z.null()]),
}).strict();

const savedArtifactSchema = z.object({
    kind: z.literal('program'),
    name: z.string(),
    artifactRevision: z.string(),
}).strict();

const contextTurnSchema = z.object({
    turn: z.number().int().nonnegative(),
    chars: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    exceededBudget: z.boolean().optional(),
}).strict();

const contextMetricsSchema = z.object({
    lastChars: z.number().int().nonnegative(),
    lastBytes: z.number().int().nonnegative(),
    peakChars: z.number().int().nonnegative(),
    peakBytes: z.number().int().nonnegative(),
    turns: z.array(contextTurnSchema),
}).strict();

const agentRunReportSchema = z.object({
    schema: z.literal(AGENT_RUN_REPORT_SCHEMA),
    schemaVersion: z.literal(AGENT_RUN_REPORT_SCHEMA_VERSION),
    run: z.object({
        provider: z.string(),
        model: z.string(),
        executionMode: z.enum(['program', 'react-baseline', 'unknown']),
    }).strict(),
    terminal: terminalSchema,
    toolMetrics: toolMetricsSchema,
    world: worldSchema,
    toolCalls: z.array(toolCallSchema),
    effects: effectsSchema,
    programs: z.array(programSchema),
    savedArtifacts: z.array(savedArtifactSchema),
    context: contextMetricsSchema.optional(),
    generatedAt: z.string().optional(),
}).strict();

export const serializeAgentRunReport = (report: AgentRunReport): string =>
    JSON.stringify(stableValue(report));

export const parseAgentRunReport = (json: string): AgentRunReport =>
    agentRunReportSchema.parse(JSON.parse(json)) as AgentRunReport;
