import {writeFile} from 'node:fs/promises';
import type {AgentEvalCorpusReport} from '../../../src/agent/execution/eval/corpus';
import {analyzeAgentEvalCorpus} from '../../../src/agent/execution/eval/analysis';
import {
    analysisToCsv,
    analysisToMarkdown,
    analysisToStableJson,
} from '../../../src/agent/execution/eval/analysis/render';
import {runLiveBenchmark} from './corpus_cli';
import type {LiveBenchmarkRunOptions} from './corpus_cli';

export type LiveAnalysisOptions = LiveBenchmarkRunOptions & Readonly<{
    outputDir?: string;
    jsonPath?: string;
    csvPath?: string;
    markdownPath?: string;
    bootstrapIterations?: number;
    bootstrapLevel?: number;
}>;

/**
 * Live CLI: run the real Workspace Agent benchmark corpus and emit the paired
 * analysis artifacts (stable JSON, CSV rows, Markdown appendix table) for the
 * committed Program-first vs react-baseline comparison.
 */
export const analyzeLiveBenchmark = async (
    options: LiveAnalysisOptions,
): Promise<AgentEvalCorpusReport> => {
    const report = await runLiveBenchmark(options);
    const analysis = analyzeAgentEvalCorpus(report, {
        ...(options.bootstrapIterations === undefined ? {} : {bootstrapIterations: options.bootstrapIterations}),
        ...(options.bootstrapLevel === undefined ? {} : {bootstrapLevel: options.bootstrapLevel}),
    });
    const base = options.outputDir ?? process.cwd();
    const artifacts = [
        [options.jsonPath ?? `${base}/analysis.json`, `${analysisToStableJson(analysis)}\n`],
        [options.csvPath ?? `${base}/analysis.csv`, `${analysisToCsv(analysis)}\n`],
        [options.markdownPath ?? `${base}/analysis.md`, `${analysisToMarkdown(analysis)}\n`],
    ] as const;
    await Promise.all(artifacts.map(([path, contents]) => writeFile(path, contents, 'utf8')));
    return report;
};