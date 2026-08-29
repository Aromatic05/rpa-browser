import type {AgentEvalMode, AgentEvalRun} from './contracts';
import type {AgentEvalModeAggregate} from './aggregate';
import type {AgentEvalScenarioReport} from './harness';

export type AgentEvalTrialSummary = Readonly<{
    taskId: string;
    mode: AgentEvalMode;
    trialIndex: number;
    success: boolean;
    recoverySuccess: boolean | null;
    durationMs: number;
    verification: {passed: boolean; evidence?: unknown};
    metrics: AgentEvalRun['metrics'];
    resultSummary: Readonly<{
        text: string;
        executionMode?: AgentEvalMode;
        programStatuses?: readonly string[];
        toolSummary: Readonly<{
            total: number;
            read: number;
            control: number;
            effect: number;
            failed: number;
        }>;
    }>;
}>;

export type AgentEvalJsonReport = Readonly<{
    version: AgentEvalScenarioReport['version'];
    generatedAt: AgentEvalScenarioReport['generatedAt'];
    scenario: AgentEvalScenarioReport['scenario'];
    runs: Readonly<Partial<Record<AgentEvalMode, readonly AgentEvalTrialSummary[]>>>;
    aggregates: AgentEvalScenarioReport['aggregates'];
}>;

const summarizeRun = (run: AgentEvalRun): AgentEvalTrialSummary => ({
    taskId: run.taskId,
    mode: run.mode,
    trialIndex: run.trialIndex,
    success: run.success,
    recoverySuccess: run.metrics.recoverySuccess,
    durationMs: run.durationMs,
    verification: run.verification,
    metrics: run.metrics,
    resultSummary: {
        text: run.result.text,
        executionMode: run.result.executionMode,
        programStatuses: run.result.programs?.map((program) => program.status),
        toolSummary: {
            total: run.result.trace.metrics.toolCalls,
            read: run.result.trace.metrics.readCalls,
            control: run.result.trace.metrics.controlCalls,
            effect: run.result.trace.metrics.effectCalls,
            failed: run.result.trace.metrics.failedToolCalls,
        },
    },
});

/**
 * Convert a scenario report to a JSON-serializable summary. Full raw results are
 * omitted by default to keep reports focused and deterministic; pass
 * `includeRawResults` to retain them.
 */
export const toAgentEvalJsonReport = (
    report: AgentEvalScenarioReport,
    options: Readonly<{includeRawResults?: boolean}> = {},
): AgentEvalJsonReport => {
    const runs: Partial<Record<AgentEvalMode, readonly AgentEvalTrialSummary[]>> = {};
    for (const [mode, modeRuns] of Object.entries(report.runs) as [AgentEvalMode, readonly AgentEvalRun[] | undefined][]) {
        if (modeRuns) {
            runs[mode] = Object.freeze(modeRuns.map((run) => {
                const summary = summarizeRun(run);
                if (options.includeRawResults) {
                    return {...summary, rawResult: run.result} as unknown as AgentEvalTrialSummary;
                }
                return summary;
            }));
        }
    }
    return Object.freeze({
        version: report.version,
        generatedAt: report.generatedAt,
        scenario: report.scenario,
        runs: Object.freeze(runs),
        aggregates: report.aggregates,
    });
};

export const agentEvalReportToJson = (
    report: AgentEvalScenarioReport,
    options?: Readonly<{includeRawResults?: boolean; space?: number}>,
): string => JSON.stringify(toAgentEvalJsonReport(report, options), null, options?.space ?? 2);

export const writeAgentEvalReport = async (
    report: AgentEvalScenarioReport,
    path: string,
    options?: Readonly<{includeRawResults?: boolean; space?: number}>,
): Promise<void> => {
    const {writeFile} = await import('node:fs/promises');
    await writeFile(path, agentEvalReportToJson(report, options), 'utf8');
};

/**
 * True if the aggregate report shows every executed mode passed its task.
 */
export const allModesPassed = (report: AgentEvalScenarioReport): boolean => {
    for (const modeRuns of Object.values(report.runs) as (readonly AgentEvalRun[] | undefined)[]) {
        if (!modeRuns) {
            continue;
        }
        if (modeRuns.some((run) => !run.success)) {
            return false;
        }
    }
    return true;
};
