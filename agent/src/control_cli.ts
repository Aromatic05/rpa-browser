import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { sendControlRequest } from './control/client';

type CommandName = 'ping' | 'dsl' | 'tool' | 'action';

type CommonOptions = {
    endpoint?: string;
    timeoutMs?: number;
};

const usage = `Usage:
  pnpm -C agent control ping [--endpoint <endpoint>] [--timeout-ms <ms>]
  pnpm -C agent control dsl --workspace <id> (--source <dsl> | --file <path>) [--input <json>] [--endpoint <endpoint>]
  pnpm -C agent control tool <name> --workspace <id> [--args <json>] [--endpoint <endpoint>]
  pnpm -C agent control action <type> [--scope <json>] [--payload <json>] [--tab-token <token>] [--trace-id <id>] [--endpoint <endpoint>]`;

const parseJson = (label: string, raw?: string): unknown => {
    if (typeof raw !== 'string' || raw.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`${label} must be valid json: ${error instanceof Error ? error.message : String(error)}`);
    }
};

const parseCommonOptions = (values: Record<string, string | boolean | undefined>): CommonOptions => ({
    endpoint: typeof values.endpoint === 'string' ? values.endpoint : undefined,
    timeoutMs: (() => {
        if (typeof values['timeout-ms'] !== 'string') {
            return undefined;
        }
        const timeoutMs = Number(values['timeout-ms']);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new Error('--timeout-ms must be a positive number');
        }
        return timeoutMs;
    })(),
});

const normalizeToolMethod = (value: string): string => (value.startsWith('browser.') ? value : `browser.${value}`);

const parseCommand = async (argv: string[]) => {
    const [command, ...rest] = argv;
    if (!command || command === '--help' || command === '-h') {
        return { help: true as const };
    }

    switch (command as CommandName) {
        case 'ping': {
            const parsed = parseArgs({
                args: rest,
                allowPositionals: false,
                options: {
                    endpoint: { type: 'string' },
                    'timeout-ms': { type: 'string' },
                },
            });
            return {
                help: false as const,
                request: {
                    method: 'agent.ping',
                    params: {},
                },
                options: parseCommonOptions(parsed.values),
            };
        }
        case 'dsl': {
            const parsed = parseArgs({
                args: rest,
                allowPositionals: false,
                options: {
                    workspace: { type: 'string' },
                    source: { type: 'string' },
                    file: { type: 'string' },
                    input: { type: 'string' },
                    endpoint: { type: 'string' },
                    'timeout-ms': { type: 'string' },
                },
            });
            const workspaceId = parsed.values.workspace;
            const inlineSource = parsed.values.source;
            const file = parsed.values.file;
            if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
                throw new Error('dsl requires --workspace');
            }
            if ((typeof inlineSource === 'string') === (typeof file === 'string')) {
                throw new Error('dsl requires exactly one of --source or --file');
            }
            const source = typeof inlineSource === 'string' ? inlineSource : await fs.readFile(String(file), 'utf8');
            return {
                help: false as const,
                request: {
                    method: 'dsl.run',
                    params: {
                        workspaceId,
                        source,
                        ...(typeof parsed.values.input === 'string'
                            ? { input: parseJson('input', parsed.values.input) }
                            : {}),
                    },
                },
                options: parseCommonOptions(parsed.values),
            };
        }
        case 'tool': {
            const parsed = parseArgs({
                args: rest,
                allowPositionals: true,
                options: {
                    workspace: { type: 'string' },
                    args: { type: 'string' },
                    endpoint: { type: 'string' },
                    'timeout-ms': { type: 'string' },
                },
            });
            const name = parsed.positionals[0];
            if (typeof name !== 'string' || name.length === 0) {
                throw new Error('tool requires a method name');
            }
            if (typeof parsed.values.workspace !== 'string' || parsed.values.workspace.length === 0) {
                throw new Error('tool requires --workspace');
            }
            return {
                help: false as const,
                request: {
                    method: normalizeToolMethod(name),
                    params: {
                        workspaceId: parsed.values.workspace,
                        ...(typeof parsed.values.args === 'string'
                            ? { args: parseJson('args', parsed.values.args) }
                            : {}),
                    },
                },
                options: parseCommonOptions(parsed.values),
            };
        }
        case 'action': {
            const parsed = parseArgs({
                args: rest,
                allowPositionals: true,
                options: {
                    scope: { type: 'string' },
                    payload: { type: 'string' },
                    'tab-token': { type: 'string' },
                    'trace-id': { type: 'string' },
                    endpoint: { type: 'string' },
                    'timeout-ms': { type: 'string' },
                },
            });
            const type = parsed.positionals[0];
            if (typeof type !== 'string' || type.length === 0) {
                throw new Error('action requires an action type');
            }
            return {
                help: false as const,
                request: {
                    method: 'action.call',
                    params: {
                        type,
                        ...(typeof parsed.values.scope === 'string'
                            ? { scope: parseJson('scope', parsed.values.scope) }
                            : {}),
                        ...(typeof parsed.values.payload === 'string'
                            ? { payload: parseJson('payload', parsed.values.payload) }
                            : {}),
                        ...(typeof parsed.values['tab-token'] === 'string'
                            ? { tabToken: parsed.values['tab-token'] }
                            : {}),
                        ...(typeof parsed.values['trace-id'] === 'string'
                            ? { traceId: parsed.values['trace-id'] }
                            : {}),
                    },
                },
                options: parseCommonOptions(parsed.values),
            };
        }
        default:
            throw new Error(`unknown control command: ${command}`);
    }
};

const main = async () => {
    const parsed = await parseCommand(process.argv.slice(2));
    if (parsed.help) {
        console.log(usage);
        return;
    }

    const response = await sendControlRequest(parsed.request, parsed.options);
    const output = JSON.stringify(response, null, 2);
    if (response.ok) {
        console.log(output);
        return;
    }
    console.error(output);
    process.exitCode = 1;
};

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    process.exitCode = 1;
});
