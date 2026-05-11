import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sendControlEval, type ControlClientOptions } from './control/client';
import type { ControlEvalRequest } from './control/protocol';

const usage = `Usage:
  pnpm -C agent control --source <js> [--workspace <id>] [--input <json>] [--endpoint <endpoint>] [--timeout-ms <ms>]
  pnpm -C agent control --file <path> [--workspace <id>] [--input <json>] [--endpoint <endpoint>] [--timeout-ms <ms>]`;

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

const parseTimeout = (raw?: string): number | undefined => {
    if (typeof raw !== 'string') {
        return undefined;
    }
    const timeoutMs = Number(raw);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
    }
    return timeoutMs;
};

export type ParsedControlEvalCli =
    | { help: true }
    | {
          help: false;
          request: Omit<ControlEvalRequest, 'id'>;
          options: ControlClientOptions;
      };

export const parseControlEvalCli = async (argv: string[]): Promise<ParsedControlEvalCli> => {
    const parsed = parseArgs({
        args: argv,
        allowPositionals: false,
        options: {
            source: { type: 'string' },
            file: { type: 'string' },
            workspace: { type: 'string' },
            input: { type: 'string' },
            endpoint: { type: 'string' },
            'timeout-ms': { type: 'string' },
            help: { type: 'boolean' },
        },
    });

    if (parsed.values.help) {
        return { help: true };
    }

    const inlineSource = parsed.values.source;
    const file = parsed.values.file;
    if ((typeof inlineSource === 'string') === (typeof file === 'string')) {
        throw new Error('control eval requires exactly one of --source or --file');
    }

    const timeoutMs = parseTimeout(parsed.values['timeout-ms']);
    const source = typeof inlineSource === 'string' ? inlineSource : await fs.readFile(String(file), 'utf8');
    return {
        help: false,
        request: {
            source,
            ...(typeof parsed.values.workspace === 'string' ? { workspaceName: parsed.values.workspace } : {}),
            ...(typeof parsed.values.input === 'string' ? { input: parseJson('input', parsed.values.input) } : {}),
            ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
        },
        options: {
            endpoint: typeof parsed.values.endpoint === 'string' ? parsed.values.endpoint : undefined,
            timeoutMs,
        },
    };
};

const main = async () => {
    const parsed = await parseControlEvalCli(process.argv.slice(2));
    if (parsed.help) {
        console.log(usage);
        return;
    }

    const response = await sendControlEval(parsed.request, parsed.options);
    const output = JSON.stringify(response, null, 2);
    if (response.ok) {
        console.log(output);
        return;
    }
    console.error(output);
    process.exitCode = 1;
};

const maybeMain = () => {
    const entry = process.argv[1];
    if (!entry) {
        return;
    }
    const currentFile = fileURLToPath(import.meta.url);
    if (path.resolve(entry) !== path.resolve(currentFile)) {
        return;
    }
    void main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        console.error(usage);
        process.exitCode = 1;
    });
};

maybeMain();
