import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {promises as fs} from 'node:fs';
import {sendControlEval} from '../../src/interface/control/client';

/**
 * Extension-mode agent harness for the product smoke E2E slice. Spawns the
 * real headless agent (production composition) and drives a mode-aware
 * deterministic faux model over a real OpenAI-compatible SSE server so the
 * floating panel can select between program and react-baseline execution.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type ProductE2EHandle = {
    endpoint: string;
    model: {provider: string; model: string};
    close: () => Promise<void>;
};

const sseOpen = (res: http.ServerResponse): void => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.flushHeaders?.();
};

const sseWrite = (res: http.ServerResponse, payload: Record<string, unknown>): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const sseDone = (res: http.ServerResponse): void => {
    res.write('data: [DONE]\n\n');
    res.end();
};

const completionChunk = (delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> => ({
    id: 'e2e-smoke',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'e2e-smoke-model',
    choices: [{index: 0, delta, finish_reason: finishReason}],
});

const lastUserText = (messages: Array<Record<string, unknown>>): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user') {continue;}
        const content = message.content;
        if (typeof content === 'string') {return content;}
        if (Array.isArray(content)) {
            const text = content
                .map((block) => (block && typeof block === 'object' ? (block as Record<string, unknown>).text : null))
                .filter((part): part is string => typeof part === 'string')
                .join('');
            if (text) {return text;}
        }
    }
    return '';
};

const lastToolResultName = (messages: Array<Record<string, unknown>>): string | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'tool') {continue;}
        const toolCallId = message.tool_call_id;
        for (let j = messages.length - 1; j >= 0; j -= 1) {
            const candidate = messages[j];
            const toolCalls = candidate && typeof candidate === 'object' && Array.isArray((candidate as {tool_calls?: unknown}).tool_calls)
                ? (candidate as {tool_calls: Array<{id?: string; function?: {name?: string}}>}).tool_calls
                : [];
            for (const call of toolCalls) {
                if (call.id === toolCallId && call.function?.name) {
                    return call.function.name;
                }
            }
        }
        return null;
    }
    return null;
};

const lastToolResultText = (messages: Array<Record<string, unknown>>): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'tool') {continue;}
        const content = message.content;
        if (typeof content === 'string') {return content;}
        if (Array.isArray(content)) {
            const text = content
                .map((block) => (block && typeof block === 'object' ? (block as Record<string, unknown>).text : null))
                .filter((part): part is string => typeof part === 'string')
                .join('');
            if (text) {return text;}
        }
        return '';
    }
    return '';
};

const parseProgramOutcome = (text: string): {status: string; pause?: {reason: string}} | null => {
    try {
        return JSON.parse(text) as {status: string; pause?: {reason: string}};
    } catch {
        return null;
    }
};

const hasToolHistory = (messages: Array<Record<string, unknown>>): boolean =>
    messages.some((message) => message?.role === 'tool' || (Array.isArray(message?.tool_calls) && (message.tool_calls as unknown[]).length > 0));

const sendTool = (res: http.ServerResponse, name: string, args: Record<string, unknown>): void => {
    sseOpen(res);
    sseWrite(res, completionChunk({role: 'assistant', content: ''}, null));
    sseWrite(res, completionChunk({
        tool_calls: [{
            index: 0,
            id: `call_${name.replaceAll('.', '_')}`,
            type: 'function',
            function: {name, arguments: JSON.stringify(args)},
        }],
    }, null));
    sseWrite(res, completionChunk({}, 'stop'));
    sseDone(res);
};

const sendText = (res: http.ServerResponse, text: string): void => {
    sseOpen(res);
    sseWrite(res, completionChunk({role: 'assistant', content: text}, null));
    sseWrite(res, completionChunk({}, 'stop'));
    sseDone(res);
};

export const startModeAwareFauxModel = async (): Promise<{baseUrl: string; close: () => Promise<void>}> => {
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || !(req.url ?? '').includes('/chat/completions')) {
            res.writeHead(404);
            res.end();
            return;
        }
        let body = '';
        req.on('data', (chunk) => {
            body += String(chunk);
        });
        req.on('end', () => {
            let messages: Array<Record<string, unknown>> = [];
            try {
                const parsed = JSON.parse(body) as {messages?: Array<Record<string, unknown>>};
                if (Array.isArray(parsed.messages)) {messages = parsed.messages;}
            } catch {
                // malformed body routes as a plain completion
            }
            const prompt = lastUserText(messages);
            const isProgram = prompt.includes('program');
            const isBaseline = prompt.includes('baseline');
            if (isProgram && !hasToolHistory(messages)) {
                sendTool(res, 'agent.execute_program', {
                    source: 'fill input.target with input.value\noutput result = input.value',
                    input: {target: {selector: '#customerName'}, value: 'ProgramAlice'},
                });
                return;
            }
            if (isProgram) {
                const outcome = parseProgramOutcome(lastToolResultText(messages));
                if (outcome?.status === 'paused' && outcome.pause?.reason === 'barrier') {
                    // Unannotated mutations pause at an unknown-risk barrier;
                    // authorize it the way a real agent would.
                    sendTool(res, 'debug.cross_barrier', {});
                    return;
                }
                sendText(res, 'Completed task.');
                return;
            }
            if (isBaseline && !hasToolHistory(messages)) {
                sendTool(res, 'browser.snapshot', {});
                return;
            }
            if (isBaseline) {
                const lastTool = lastToolResultName(messages);
                if (lastTool === 'browser.snapshot') {
                    sendTool(res, 'browser.fill', {selector: '#customerName', value: 'BaselineBob'});
                    return;
                }
            }
            sendText(res, 'Completed task.');
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (typeof address === 'string' || !address) {
        server.close();
        throw new Error('failed to allocate mode-aware model port');
    }
    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: async () => {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        },
    };
};

const assertExtensionBuildReady = async (cwd: string): Promise<void> => {
    const rootStamp = path.resolve(cwd, '..', '.dev', 'extension-build.json');
    const stamp = await fs.readFile(rootStamp, 'utf8');
    const parsed = JSON.parse(stamp) as {mainExtensionPath?: unknown};
    if (typeof parsed.mainExtensionPath !== 'string') {
        throw new Error('extension build stamp is incomplete; run `pnpm build:extension` again');
    }
    const mainStat = await fs.stat(parsed.mainExtensionPath).catch(() => null);
    if (!mainStat?.isDirectory()) {
        throw new Error(`extension build main path is missing: ${parsed.mainExtensionPath}`);
    }
};

export const startProductAgent = async (): Promise<ProductE2EHandle> => {
    const cwd = path.resolve(process.cwd());
    await assertExtensionBuildReady(cwd);
    const provider = 'e2e-smoke';
    const model = 'e2e-smoke-model';
    const faux = await startModeAwareFauxModel();

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-e2e-product-'));
    const userDataDir = path.join(tempRoot, 'user-data');
    const endpoint = path.join(tempRoot, 'agent.sock');
    await fs.mkdir(userDataDir, {recursive: true});

    const proc = spawn('pnpm', ['dev:headless'], {
        cwd,
        env: {
            ...process.env,
            RPA_CONTROL_EVAL: '1',
            RPA_CONTROL_ENDPOINT: endpoint,
            RPA_USER_DATA_DIR: userDataDir,
            RPA_WORKFLOW_ROOT: path.join(tempRoot, 'workflow'),
            RPA_AGENT_API_KEY: 'test-key',
            RUNNER_AGENT_PROVIDER: provider,
            RUNNER_AGENT_MODEL: model,
            RUNNER_AGENT_BASE_URL: faux.baseUrl,
            RUNNER_AGENT_INTERACTION: 'headless',
            RUNNER_AGENT_SESSION_STORAGE_ROOT: path.join(tempRoot, 'sessions'),
            RUNNER_AGENT_REPORT_ROOT: path.join(tempRoot, 'sessions', 'reports'),
        },
        stdio: 'pipe',
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 12_000) {stderr = stderr.slice(-12_000);}
    });

    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) {
            throw new Error(`agent exited during startup: ${String(proc.exitCode)}\n${stderr}`);
        }
        try {
            const probe = await sendControlEval(
                {source: 'const w = ctx?.resolveWorkspace?.("default"); return { ready: !!ctx?.dispatch && !!ctx?.runStep && w?.browserSession?.status === "running" && w?.tabs?.listTabs?.().length > 0 };', timeoutMs: 2000},
                {endpoint, timeoutMs: 2000},
            );
            if (probe.ok && (probe.result as {ready?: boolean})?.ready) {
                return {
                    endpoint,
                    model: {provider, model},
                    close: async () => {
                        await faux.close().catch(() => undefined);
                        if (!proc.killed) {
                            proc.kill('SIGTERM');
                            await new Promise<void>((resolve) => {
                                const timer = setTimeout(resolve, 3000);
                                proc.once('exit', () => {
                                    clearTimeout(timer);
                                    resolve();
                                });
                            });
                        }
                        if (proc.exitCode === null) {proc.kill('SIGKILL');}
                        await fs.rm(tempRoot, {recursive: true, force: true}).catch(() => undefined);
                    },
                };
            }
        } catch {
            // retry while the agent listens on the control socket
        }
        await sleep(100);
    }
    await faux.close().catch(() => undefined);
    throw new Error(`agent startup timeout (control endpoint not ready)\n${stderr}`);
};