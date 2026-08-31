import test from 'node:test';
import assert from 'node:assert/strict';
import {corpusRunOptions, parseAgentEvalCliArgs, runAgentEvalCli} from '../../../../../src/agent/execution/eval/cli';
import type {AgentEvalCorpus} from '../../../../../src/agent/execution/eval/corpus';
import {agentEvalCorpusExitCode, runAgentEvalCorpus, toAgentEvalCorpusJson} from '../../../../../src/agent/execution/eval/corpus';
import {deriveTrialSeed} from '../../../../../src/agent/execution/eval/seed';
import {
    fixtureScenarios,
    successScenario,
    successRunner,
    unrecoveredFailureRunner,
    unrecoveredFailureScenario,
} from './fixtures';

const testCorpus: AgentEvalCorpus = Object.freeze({
    id: 'test-corpus',
    version: 1,
    entries: fixtureScenarios,
});

const createIo = () => {
    const out: string[] = [];
    const err: string[] = [];
    const files = new Map<string, string>();
    return {
        io: {
            stdout: (chunk: string) => out.push(chunk),
            stderr: (chunk: string) => err.push(chunk),
            writeFile: async (path: string, contents: string): Promise<void> => {
                files.set(path, contents);
            },
        },
        out,
        err,
        files,
    };
};

test('cli parses scenario filter, repeated modes, trials, seed, output and list', () => {
    const args = parseAgentEvalCliArgs([
        '--scenario', 'form',
        '--mode', 'program',
        '--mode', 'react-baseline',
        '--trials', '3',
        '--seed', '7',
        '--output', 'report.json',
    ]);
    assert.equal(args.scenarioQuery, 'form');
    assert.deepEqual(args.modes, ['program', 'react-baseline']);
    assert.equal(args.trials, 3);
    assert.equal(args.seed, 7);
    assert.equal(args.output, 'report.json');
    const options = corpusRunOptions(args);
    assert.equal(options.scenarioQuery, 'form');
    assert.equal(options.trials, 3);
    assert.equal(options.seed, 7);
});

test('cli supports caller-declared extra flags', () => {
    const args = parseAgentEvalCliArgs(
        ['--backend', 'live', '--json'],
        {'--backend': 'string', '--json': 'boolean'},
    );
    assert.deepEqual(args.extra, {backend: 'live', json: true});
    assert.throws(() => parseAgentEvalCliArgs(['--backend', 'live']), /Unknown argument: --backend/);
    assert.throws(() => parseAgentEvalCliArgs(['--backend'], {'--backend': 'string'}), /--backend requires a value/);
});

test('cli validates numeric flags and modes', () => {
    assert.throws(() => parseAgentEvalCliArgs(['--trials', '0']), /--trials requires an integer >= 1/);
    assert.throws(() => parseAgentEvalCliArgs(['--trials', 'x']), /--trials requires an integer >= 1/);
    assert.throws(() => parseAgentEvalCliArgs(['--seed', '-1']), /--seed requires an integer >= 0/);
    assert.throws(() => parseAgentEvalCliArgs(['--mode', 'turbo']), /Unknown mode: turbo/);
    assert.throws(() => parseAgentEvalCliArgs(['--nope']), /Unknown argument: --nope/);
});

test('runAgentEvalCli executes filtered scenarios and returns success exit code', async () => {
    const {io, out} = createIo();
    const exitCode = await runAgentEvalCli(
        {invocation: 'test', resolveCorpus: () => testCorpus, io},
        ['--scenario', 'fixture-success', '--mode', 'program', '--trials', '2', '--seed', '5'],
    );
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(out.join(''));
    assert.equal(parsed.corpus.id, 'test-corpus');
    assert.equal(parsed.corpus.seed, 5);
    assert.deepEqual(parsed.corpus.scenarioIds, ['fixture-success']);
    assert.equal(parsed.reports.length, 1);
    assert.equal(parsed.reports[0].runs.program.length, 2);
    assert.deepEqual(parsed.reports[0].runs['react-baseline'], undefined);
    assert.deepEqual(parsed.trialSeeds['fixture-success'], [
        deriveTrialSeed(5, 'fixture-success', 0),
        deriveTrialSeed(5, 'fixture-success', 1),
    ]);
    assert.deepEqual(
        parsed.corpus.models,
        [{provider: 'fixture', model: 'deterministic', scenarioIds: ['fixture-success']}],
    );
    assert.equal(JSON.stringify(parsed).includes('apiKey'), false);
});

test('runAgentEvalCli exits 1 when any scenario fails verification', async () => {
    const {io} = createIo();
    const exitCode = await runAgentEvalCli(
        {invocation: 'test', resolveCorpus: () => testCorpus, io},
        ['--scenario', 'fixture-unrecovered-failure', '--mode', 'program'],
    );
    assert.equal(exitCode, 1);
});

test('runAgentEvalCli lists scenarios without executing and flags unmatched filters', async () => {
    const listIo = createIo();
    const listExit = await runAgentEvalCli(
        {invocation: 'test', resolveCorpus: () => testCorpus, io: listIo.io},
        ['--list'],
    );
    assert.equal(listExit, 0);
    assert.equal(listIo.out.join('').split('\n').filter(Boolean).length, fixtureScenarios.length);

    const missIo = createIo();
    const missExit = await runAgentEvalCli(
        {invocation: 'test', resolveCorpus: () => testCorpus, io: missIo.io},
        ['--scenario', 'does-not-exist'],
    );
    assert.equal(missExit, 1);
});

test('runAgentEvalCli writes the deterministic report to --output and wraps execution', async () => {
    const {io, files} = createIo();
    let executionWraps = 0;
    const exitCode = await runAgentEvalCli({
        invocation: 'test',
        resolveCorpus: () => testCorpus,
        io,
        withExecution: async (execute) => {
            executionWraps += 1;
            const result = await execute();
            executionWraps += 1;
            return result;
        },
    }, ['--scenario', 'fixture-success', '--trials', '2', '--seed', '11', '--output', 'bench.json']);
    assert.equal(exitCode, 0);
    assert.equal(executionWraps, 2);
    const written = files.get('bench.json');
    assert.ok(written);
    assert.equal(JSON.parse(written).corpus.seed, 11);
    assert.equal(written.includes('generatedAt'), false);
});

test('corpus reports serialize byte-identically for the same seed', async () => {
    const first = await runAgentEvalCorpus(testCorpus, {seed: 3, trials: 2});
    const second = await runAgentEvalCorpus(testCorpus, {seed: 3, trials: 2});
    assert.equal(toAgentEvalCorpusJson(first), toAgentEvalCorpusJson(second));
    assert.notEqual(
        toAgentEvalCorpusJson(first),
        toAgentEvalCorpusJson(await runAgentEvalCorpus(testCorpus, {seed: 4, trials: 2})),
    );
});

test('corpus aggregates every scenario per mode and distinguishes unknown baselines', async () => {
    const report = await runAgentEvalCorpus(testCorpus, {seed: 9});
    assert.equal(report.reports.length, fixtureScenarios.length);
    assert.equal(report.aggregates.program?.trials, 7);
    assert.equal(report.aggregates['react-baseline']?.trials, 5);
    assert.equal(report.aggregates.program?.taskSuccess.passed, 5);
    assert.equal(report.aggregates.program?.taskSuccess.count, 7);
    assert.equal(report.aggregates['react-baseline']?.taskSuccess.rate, 1);
    assert.equal(agentEvalCorpusExitCode(report), 1);
    const baselineSuccess = report.aggregates['react-baseline']?.recoverySuccess;
    assert.ok(baselineSuccess && 'unknown' in baselineSuccess && baselineSuccess.unknown === true);
});

test('trial summaries carry trial index, model and provider metadata', async () => {
    const report = await runAgentEvalCorpus(
        {id: 'solo', version: 1, entries: [{scenario: successScenario, runner: successRunner}]},
        {seed: 1, trials: 2},
    );
    const json = JSON.parse(toAgentEvalCorpusJson(report));
    const rows = json.reports[0].runs.program;
    assert.deepEqual(rows.map((row: {trialIndex: number}) => row.trialIndex), [0, 1]);
    assert.equal(json.corpus.models[0].provider, successScenario.task.provider);
    assert.equal(json.corpus.models[0].model, successScenario.task.model);
    assert.equal(report.corpus.trialsOverride, 2);
});

test('scenario filtering can exclude failing scenarios for product-only regressions', async () => {
    const report = await runAgentEvalCorpus(
        {
            id: 'solo-fail',
            version: 1,
            entries: [{scenario: unrecoveredFailureScenario, runner: unrecoveredFailureRunner}],
        },
        {seed: 0, modes: ['program'], scenarioQuery: 'unrecovered'},
    );
    assert.equal(report.reports.length, 1);
    assert.equal(agentEvalCorpusExitCode(report), 1);
});
