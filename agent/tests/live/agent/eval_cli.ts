import {writeFile} from 'node:fs/promises';
import {runAgentEvalScenario} from '../../../src/agent/execution/eval/harness';
import {filterScenarios} from '../../../src/agent/execution/eval/scenario';
import {allModesPassed, toAgentEvalJsonReport} from '../../../src/agent/execution/eval/report';
import type {AgentEvalMode, AgentEvalScenario} from '../../../src/agent/execution/eval/contracts';
import {fixtureScenarios} from '../../integration/agent/execution/eval/fixtures';

const usage = `Usage: tsx tests/live/agent/eval_cli.ts [options]

Options:
  --scenario <query>   Filter scenarios by id/name/description substring.
  --mode <mode>        Restrict to one mode (program | react-baseline).
  --trials <n>         Override the number of trials per scenario.
  --output <path>      Write JSON report to a file instead of stdout.
  --list               List available fixture scenarios and exit.
  --help               Show this message and exit.
`;

type ParsedArgs = Readonly<{
    scenarioQuery?: string;
    modes: readonly AgentEvalMode[];
    trials?: number;
    output?: string;
    list: boolean;
    help: boolean;
}>;

const parseArgs = (argv: string[]): ParsedArgs => {
    let scenarioQuery: string | undefined;
    const modes: AgentEvalMode[] = [];
    let trials: number | undefined;
    let output: string | undefined;
    let list = false;
    let help = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--help':
                help = true;
                break;
            case '--list':
                list = true;
                break;
            case '--scenario': {
                const value = argv[++i];
                if (value === undefined) {throw new Error('--scenario requires a value');}
                scenarioQuery = value;
                break;
            }
            case '--mode': {
                const value = argv[++i];
                if (value !== 'program' && value !== 'react-baseline') {
                    throw new Error(`Unknown mode: ${value}`);
                }
                modes.push(value);
                break;
            }
            case '--trials': {
                const value = Number(argv[++i]);
                if (!Number.isInteger(value) || value < 1) {
                    throw new Error('--trials must be a positive integer');
                }
                trials = value;
                break;
            }
            case '--output': {
                const value = argv[++i];
                if (value === undefined) {throw new Error('--output requires a value');}
                output = value;
                break;
            }
            default:
                throw new Error(`Unknown argument: ${arg}\n${usage}`);
        }
    }

    return {scenarioQuery, modes, trials, output, list, help};
};

const args = parseArgs(process.argv.slice(2));

if (args.help) {
    process.stdout.write(usage);
    process.exit(0);
}

if (args.list) {
    for (const {scenario} of fixtureScenarios) {
        process.stdout.write(`${scenario.id}\t${scenario.name}\t[${scenario.modes.join(', ')}]\n`);
    }
    process.exit(0);
}

const allScenarios = fixtureScenarios.map(({scenario}) => scenario);
const selected = filterScenarios(allScenarios, {
    query: args.scenarioQuery,
    modes: args.modes.length > 0 ? args.modes : undefined,
});

if (selected.length === 0) {
    process.stderr.write(`No scenarios matched${args.scenarioQuery ? ` "${args.scenarioQuery}"` : ''}.\n`);
    process.exit(1);
}

const reports = await Promise.all(
    selected.map(async (scenario) => {
        const entry = fixtureScenarios.find((candidate) => candidate.scenario.id === scenario.id);
        if (!entry) {
            throw new Error(`Runner not found for scenario ${scenario.id}`);
        }
        const effectiveScenario: AgentEvalScenario = {
            ...scenario,
            trials: args.trials ?? scenario.trials,
        };
        return runAgentEvalScenario({runner: entry.runner, modes: effectiveScenario.modes}, effectiveScenario);
    }),
);

const payload = Object.freeze({
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    scenarioCount: reports.length,
    reports: reports.map((report) => toAgentEvalJsonReport(report)),
});

const json = JSON.stringify(payload, null, 2);
if (args.output) {
    await writeFile(args.output, json, 'utf8');
    process.stdout.write(`Wrote report to ${args.output}\n`);
} else {
    process.stdout.write(`${json}\n`);
}

process.exitCode = reports.every((report) => allModesPassed(report)) ? 0 : 1;
