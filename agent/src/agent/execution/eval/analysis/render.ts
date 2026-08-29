import type {AgentEvalMode} from '../contracts';
import type {AgentEvalAnalysis, AgentEvalScenarioAnalysis} from './contracts';
import type {
    AgentEvalAggregateAnalysis,
    AgentEvalFailureCategory,
    PairedBooleanDelta,
    PairedNumericDelta,
    PairedRecoveryDelta,
} from './contracts';
import {
    AGENT_EVAL_ANALYSIS_JOURNAL_METRICS,
    AGENT_EVAL_ANALYSIS_METRICS,
    AGENT_EVAL_FAILURE_CATEGORIES,
} from './contracts';

/**
 * Paper-ready rendering of the paired analysis: stable JSON, CSV rows and a
 * concise Markdown table. All renderers are pure and deterministic.
 */

const fmt = (value: number | null | undefined, digits = 3): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return value.toFixed(digits);
};

const ciText = (ci: {lower: number; upper: number} | null): string =>
    ci ? `[${fmt(ci.lower)}, ${fmt(ci.upper)}]` : '';

type RowSource = Readonly<{
    label: string;
    trials: number;
    matchedPairs: number;
    unmatchedProgram: number;
    unmatchedBaseline: number;
    aggregate: AgentEvalAggregateAnalysis;
}>;

const scenarioRowSource = (scenario: AgentEvalScenarioAnalysis): RowSource => ({
    label: scenario.scenarioId,
    trials: scenario.trials,
    matchedPairs: scenario.matchedPairs,
    unmatchedProgram: scenario.unmatchedProgram.length,
    unmatchedBaseline: scenario.unmatchedBaseline.length,
    aggregate: scenario,
});

const overallRowSource = (analysis: AgentEvalAnalysis): RowSource => ({
    label: 'overall',
    trials: analysis.scenarios.reduce((acc, scenario) => acc + scenario.trials, 0),
    matchedPairs: analysis.pairing.matchedPairs,
    unmatchedProgram: analysis.pairing.unmatchedProgram.length,
    unmatchedBaseline: analysis.pairing.unmatchedBaseline.length,
    aggregate: analysis.overall,
});

const COLUMNS: readonly string[] = [
    'scenario',
    'trials',
    'matchedPairs',
    'unmatchedProgram',
    'unmatchedBaseline',
    'taskSuccessProgram',
    'taskSuccessBaseline',
    'taskSuccessDelta',
    'taskSuccessCI',
    'taskSuccessH',
    'win',
    'loss',
    'tie',
    'recoveryKnownPairs',
    'recoveryProgram',
    'recoveryBaseline',
    'recoveryDelta',
    'recoveryCI',
    'unknownProgram',
    'unknownBaseline',
    ...AGENT_EVAL_ANALYSIS_METRICS.flatMap((key) => [`${key}Delta`, `${key}CI`, `d_${key}`]),
    ...AGENT_EVAL_ANALYSIS_JOURNAL_METRICS.flatMap((key) => [
        `${key}ProgramMean`,
        `${key}BaselineMean`,
        `${key}Pairs`,
    ]),
    ...(['program', 'react-baseline'] as const).flatMap((mode) =>
        AGENT_EVAL_FAILURE_CATEGORIES.map((category) => `${mode}_${category}`)),
];

const buildRow = (source: RowSource): Readonly<Record<string, string>> => {
    const row: Record<string, string> = {};
    const set = (key: string, value: string): void => {
        row[key] = value;
    };
    set('scenario', source.label);
    set('trials', String(source.trials));
    set('matchedPairs', String(source.matchedPairs));
    set('unmatchedProgram', String(source.unmatchedProgram));
    set('unmatchedBaseline', String(source.unmatchedBaseline));

    const task = source.aggregate.taskSuccess;
    set('taskSuccessProgram', fmt(task.programRate));
    set('taskSuccessBaseline', fmt(task.baselineRate));
    set('taskSuccessDelta', fmt(task.delta));
    set('taskSuccessCI', ciText(task.ci));
    set('taskSuccessH', fmt(task.cohensH));
    set('win', String(task.win));
    set('loss', String(task.loss));
    set('tie', String(task.tie));

    const recovery = source.aggregate.recoverySuccess;
    set('recoveryKnownPairs', String(recovery.knownPairs));
    set('recoveryProgram', fmt(recovery.programRate));
    set('recoveryBaseline', fmt(recovery.baselineRate));
    set('recoveryDelta', fmt(recovery.delta));
    set('recoveryCI', ciText(recovery.ci));
    set('unknownProgram', String(recovery.unknownProgram));
    set('unknownBaseline', String(recovery.unknownBaseline));

    for (const key of AGENT_EVAL_ANALYSIS_METRICS) {
        const numeric = source.aggregate.numeric[key];
        set(`${key}Delta`, fmt(numeric.meanDelta));
        set(`${key}CI`, ciText(numeric.ci));
        set(`d_${key}`, fmt(numeric.cohensDz));
    }
    for (const key of AGENT_EVAL_ANALYSIS_JOURNAL_METRICS) {
        const journal = source.aggregate.journal[key];
        set(`${key}ProgramMean`, fmt(journal.programMean));
        set(`${key}BaselineMean`, fmt(journal.baselineMean));
        set(`${key}Pairs`, journal.unknown ? 'unknown' : String(journal.pairs));
    }
    for (const mode of ['program', 'react-baseline'] as const) {
        const taxonomy = source.aggregate.failureTaxonomy[mode];
        for (const category of AGENT_EVAL_FAILURE_CATEGORIES) {
            set(`${mode}_${category}`, String(taxonomy[category]));
        }
    }
    return Object.freeze(row);
};

const csvCell = (value: string): string => {
    if (/[",\n]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
};

export const analysisToCsv = (analysis: AgentEvalAnalysis): string => {
    const rows = [
        ...analysis.scenarios.map(scenarioRowSource),
        overallRowSource(analysis),
    ].map(buildRow);
    return [
        COLUMNS.join(','),
        ...rows.map((row) => COLUMNS.map((column) => csvCell(row[column] ?? '')).join(',')),
    ].join('\n');
};

const booleanCell = (task: PairedBooleanDelta): string => `${fmt(task.programRate)} / ${fmt(task.baselineRate)}`;

const recoveryCell = (recovery: PairedRecoveryDelta): string => {
    if (recovery.delta === null) {
        return `unknown (program ${recovery.unknownProgram}, baseline ${recovery.unknownBaseline})`;
    }
    return `${fmt(recovery.delta)} ${ciText(recovery.ci)}`;
};

const numericCell = (delta: PairedNumericDelta): string =>
    delta.meanDelta === null ? '' : `${fmt(delta.meanDelta)} ${ciText(delta.ci)}`;

const mdComparisonRow = (
    label: string,
    matched: number,
    task: PairedBooleanDelta,
    recovery: PairedRecoveryDelta,
    turns: PairedNumericDelta,
    duration: PairedNumericDelta,
): string => [
    label,
    String(matched),
    booleanCell(task),
    `${fmt(task.delta)} ${ciText(task.ci)}`,
    recoveryCell(recovery),
    numericCell(turns),
    numericCell(duration),
    `${task.win}/${task.loss}/${task.tie}`,
].join(' | ');

const mdTaxonomyRow = (
    label: string,
    mode: AgentEvalMode,
    taxonomy: Readonly<Record<AgentEvalFailureCategory, number>>,
): string => [
    label,
    mode,
    ...AGENT_EVAL_FAILURE_CATEGORIES.map((category) => String(taxonomy[category])),
].join(' | ');

export const analysisToMarkdown = (analysis: AgentEvalAnalysis): string => {
    const comparisonHeader = '| scenario | matched | task program / baseline | task Δ [95% CI] | recovery Δ [95% CI] | turns Δ [95% CI] | duration Δ [95% CI] | W/L/T |';
    const comparisonDivider = '|---|---|---|---|---|---|---|---|';
    const comparisonRows = analysis.scenarios.map((scenario) => mdComparisonRow(
        scenario.scenarioId,
        scenario.matchedPairs,
        scenario.taskSuccess,
        scenario.recoverySuccess,
        scenario.numeric.turns,
        scenario.numeric.durationMs,
    ));
    const overall = analysis.overall;
    const overallRow = mdComparisonRow(
        '**overall**',
        overall.matchedPairs,
        overall.taskSuccess,
        overall.recoverySuccess,
        overall.numeric.turns,
        overall.numeric.durationMs,
    );

    const taxonomyHeader = `| scenario | mode | ${AGENT_EVAL_FAILURE_CATEGORIES.join(' | ')} |`;
    const taxonomyDivider = `|${AGENT_EVAL_FAILURE_CATEGORIES.map(() => '---').join('|')}|---|---|---|`;
    const taxonomyRows: string[] = [];
    for (const scenario of analysis.scenarios) {
        for (const mode of ['program', 'react-baseline'] as const) {
            taxonomyRows.push(mdTaxonomyRow(scenario.scenarioId, mode, scenario.failureTaxonomy[mode]));
        }
    }
    for (const mode of ['program', 'react-baseline'] as const) {
        taxonomyRows.push(mdTaxonomyRow('**overall**', mode, overall.failureTaxonomy[mode]));
    }

    const unmatchedLines: string[] = [];
    const describe = (trial: {scenarioId: string; trialIndex: number}): string =>
        `${trial.scenarioId}#${trial.trialIndex}`;
    if (analysis.pairing.unmatchedProgram.length > 0) {
        unmatchedLines.push(
            `- unmatched program trials (excluded from paired statistics): ${analysis.pairing.unmatchedProgram.map(describe).join(', ')}`,
        );
    }
    if (analysis.pairing.unmatchedBaseline.length > 0) {
        unmatchedLines.push(
            `- unmatched react-baseline trials (excluded from paired statistics): ${analysis.pairing.unmatchedBaseline.map(describe).join(', ')}`,
        );
    }

    return [
        '# Program-first vs react-baseline: paired analysis',
        `corpus: ${analysis.corpusId}; seed: ${analysis.seed}`,
        '',
        '## Comparison',
        comparisonHeader,
        comparisonDivider,
        ...comparisonRows.map((row) => `| ${row} |`),
        `| ${overallRow} |`,
        '',
        '## Failure taxonomy (failed runs)',
        taxonomyHeader,
        taxonomyDivider,
        ...taxonomyRows.map((row) => `| ${row} |`),
        '',
        '## Pairing notes',
        `- matched pairs: ${analysis.pairing.matchedPairs} across ${analysis.pairing.scenarios} scenarios`,
        ...unmatchedLines,
        `- bootstrap: ${analysis.bootstrap.iterations} iterations, ${Math.round(analysis.bootstrap.level * 100)}% percentile CI, deterministic seed`,
        '- journal metrics (failed world-changing effects, compensation effects, world effect calls) are reported only when observable; react-baseline journal metrics stay unknown',
        '',
    ].join('\n');
};

const sortKeyed = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => sortKeyed(item));
    }
    if (value && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
            result[key] = sortKeyed(source[key]);
        }
        return result;
    }
    return value;
};

export const analysisToStableJson = (analysis: AgentEvalAnalysis, space = 2): string =>
    JSON.stringify(sortKeyed(analysis), null, space);