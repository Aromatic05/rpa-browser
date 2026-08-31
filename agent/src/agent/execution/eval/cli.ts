import type {AgentEvalMode} from './contracts';
import type {AgentEvalCorpus, RunAgentEvalCorpusOptions} from './corpus';
import {agentEvalCorpusExitCode, runAgentEvalCorpus, toAgentEvalCorpusJson} from './corpus';
import type {AgentEvalCorpusReport} from './corpus';

export type AgentEvalCliExtraFlag = 'string' | 'boolean';

export type ParsedAgentEvalCliArgs = Readonly<{
    scenarioQuery?: string;
    modes: readonly AgentEvalMode[];
    trials?: number;
    seed?: number;
    output?: string;
    list: boolean;
    help: boolean;
    extra: Readonly<Record<string, string | boolean>>;
}>;

export const agentEvalCliUsage = (invocation: string, extraUsage = ''): string => `Usage: ${invocation} [options]

Options:
  --scenario <query>   Filter scenarios by id/name/description substring.
  --mode <mode>        Restrict to a mode (program | react-baseline). Repeatable.
  --trials <n>         Override the number of trials per scenario (>= 1).
  --seed <n>           Deterministic corpus seed (>= 0).
  --output <path>      Write the deterministic JSON report to a file.
  --list               List corpus scenarios and exit.
  --help               Show this message and exit.
${extraUsage}`;

const parsePositiveInt = (raw: string | undefined, flag: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < (flag === '--seed' ? 0 : 1)) {
        throw new Error(`${flag} requires an integer >= ${flag === '--seed' ? 0 : 1}`);
    }
    return value;
};

export const parseAgentEvalCliArgs = (
    argv: readonly string[],
    extraFlags: Readonly<Record<string, AgentEvalCliExtraFlag>> = {},
): ParsedAgentEvalCliArgs => {
    let scenarioQuery: string | undefined;
    const modes: AgentEvalMode[] = [];
    let trials: number | undefined;
    let seed: number | undefined;
    let output: string | undefined;
    let list = false;
    let help = false;
    const extra: Record<string, string | boolean> = {};

    for (let index = 0; index < argv.length; index++) {
        const arg = argv.at(index);
        if (arg === '--scenario') {
            const value = argv.at(++index);
            if (value === undefined) {throw new Error('--scenario requires a value');}
            scenarioQuery = value;
        } else if (arg === '--mode') {
            const value = argv.at(++index);
            if (value !== 'program' && value !== 'react-baseline') {
                throw new Error(`Unknown mode: ${value}`);
            }
            if (!modes.includes(value)) {modes.push(value);}
        } else if (arg === '--trials') {
            trials = parsePositiveInt(argv.at(++index), '--trials');
        } else if (arg === '--seed') {
            seed = parsePositiveInt(argv.at(++index), '--seed');
        } else if (arg === '--output') {
            const value = argv.at(++index);
            if (value === undefined) {throw new Error('--output requires a value');}
            output = value;
        } else if (arg === '--list') {
            list = true;
        } else if (arg === '--help') {
            help = true;
        } else if (arg !== undefined && Object.hasOwn(extraFlags, arg)) {
            const name = arg.slice(2);
            if (extraFlags[arg] === 'boolean') {
                extra[name] = true;
            } else {
                const value = argv.at(++index);
                if (value === undefined) {throw new Error(`${arg} requires a value`);}
                extra[name] = value;
            }
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return {scenarioQuery, modes, trials, seed, output, list, help, extra};
};

export const corpusRunOptions = (args: ParsedAgentEvalCliArgs): RunAgentEvalCorpusOptions => ({
    scenarioQuery: args.scenarioQuery,
    modes: args.modes.length > 0 ? args.modes : undefined,
    trials: args.trials,
    seed: args.seed,
});

export type AgentEvalCliIo = Readonly<{
    stdout: (chunk: string) => void;
    stderr: (chunk: string) => void;
    writeFile?: (path: string, contents: string) => Promise<void>;
}>;

export type AgentEvalCliConfig = Readonly<{
    invocation: string;
    resolveCorpus: (args: ParsedAgentEvalCliArgs) => Promise<AgentEvalCorpus> | AgentEvalCorpus;
    onReport?: (report: AgentEvalCorpusReport) => void | Promise<void>;
    extraFlags?: Readonly<Record<string, AgentEvalCliExtraFlag>>;
    extraUsage?: string;
    /** Wraps execution so callers can open/close resources (browser, model client). */
    withExecution?: <T>(execute: () => Promise<T>) => Promise<T>;
    io?: Partial<AgentEvalCliIo>;
}>;

const defaultIo = (): AgentEvalCliIo => ({
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    writeFile: async (path, contents) => {
        const {writeFile} = await import('node:fs/promises');
        await writeFile(path, contents, 'utf8');
    },
});

/**
 * Production corpus-runner CLI. Resolves a corpus for the parsed arguments,
 * executes every selected scenario across trials/modes and emits a
 * deterministic JSON report. Returns the process exit code: 0 when every
 * executed scenario passed in every executed mode, 1 otherwise.
 */
export const runAgentEvalCli = async (
    config: AgentEvalCliConfig,
    argv: readonly string[] = process.argv.slice(2),
): Promise<number> => {
    const io: AgentEvalCliIo = {...defaultIo(), ...config.io};
    const extraFlags = config.extraFlags ?? {};
    let args: ParsedAgentEvalCliArgs;
    try {
        args = parseAgentEvalCliArgs(argv, extraFlags);
    } catch (error) {
        io.stderr(`${(error as Error).message}\n${agentEvalCliUsage(config.invocation, config.extraUsage ?? '')}`);
        return 1;
    }
    if (args.help) {
        io.stdout(agentEvalCliUsage(config.invocation, config.extraUsage ?? ''));
        return 0;
    }
    let corpus: AgentEvalCorpus;
    try {
        corpus = await config.resolveCorpus(args);
    } catch (error) {
        io.stderr(`Error: ${(error as Error).message}\n`);
        return 1;
    }
    if (args.list) {
        for (const {scenario} of corpus.entries) {
            io.stdout(`${scenario.id}\t${scenario.name}\t[${scenario.modes.join(', ')}]\n`);
        }
        return 0;
    }
    const execute = async (): Promise<number> => {
        const report = await runAgentEvalCorpus(corpus, corpusRunOptions(args));
        await config.onReport?.(report);
        const json = toAgentEvalCorpusJson(report);
        if (args.output) {
            if (!io.writeFile) {
                throw new Error('writeFile is not available for --output');
            }
            await io.writeFile(args.output, json);
            io.stdout(`Wrote report to ${args.output}\n`);
        } else {
            io.stdout(`${json}\n`);
        }
        return agentEvalCorpusExitCode(report);
    };
    try {
        return config.withExecution ? await config.withExecution(execute) : await execute();
    } catch (error) {
        io.stderr(`Error: ${(error as Error).message}\n`);
        return 1;
    }};
