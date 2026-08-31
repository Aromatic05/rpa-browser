import http from 'node:http';

/**
 * Scriptable OpenAI-compatible SSE model server for the closed-beta product
 * acceptance suite.
 *
 * The spawned production agent's real model runtime (`streamOpenAICompletions`)
 * streams `/v1/chat/completions` to this server. The "model" here is a pure,
 * deterministic script over the conversation — it reads only the tool results
 * the agent actually received and emits the next assistant tool call or text,
 * exactly like a real model would. Every product assertion inspects the real
 * browser DOM / WS product surface, never the model's self-report.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type WireStep = {tool: {name: string; args: Record<string, unknown>}} | {text: string};

export const wireTool = (name: string, args: Record<string, unknown>): WireStep => ({tool: {name, args}});
export const wireText = (text: string): WireStep => ({text});

export type WireToolResult = {
    toolName: string;
    isError: boolean;
    text: string;
    raw: unknown;
};

export type ClosedBetaModelCtx = {
    requestNumber: number;
    messages: readonly unknown[];
    lastUser: string;
    lastTool: WireToolResult | null;
    hasToolHistory: boolean;
    rawTools: readonly unknown[];
    /** Release the named hook from the test driver (async DOM mutation / nav). */
    releaseHook: (name: string) => void;
};

export type ClosedBetaScript = (ctx: ClosedBetaModelCtx) => WireStep | Promise<WireStep>;

type ToolResultLog = {name: string; requestNumber: number};

export type ClosedBetaModelHandle = {
    baseUrl: string;
    provider: string;
    model: string;
    requestCount: () => number;
    /** `model` field of every chat.completions request body the agent sent. */
    observedRequestModels: string[];
    /** Authorization headers received (proves the configured provider key). */
    receivedAuthHeaders: string[];
    /** Tool results the script branches on, in order seen. */
    toolResultLog: ToolResultLog[];
    awaitToolResult: (predicate: (entry: ToolResultLog) => boolean) => Promise<void>;
    releaseHook: (name: string) => void;
    close: () => Promise<void>;
};

const contentText = (content: unknown): string => {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((block) =>
            block && typeof block === 'object' && 'text' in block
                ? String((block as {text: unknown}).text)
                : '',
        )
        .join('');
};

const lastUserText = (messages: readonly unknown[]): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as {role?: string; content?: unknown};
        if (message.role !== 'user') {
            continue;
        }
        const text = contentText(message.content);
        if (text && typeof text === 'string' && text.trim().length > 0) {
            return text;
        }
    }
    return '';
};

const lastToolResult = (messages: readonly unknown[]): WireToolResult | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as {role?: string; tool_call_id?: unknown; content?: unknown};
        if (message.role !== 'tool') {
            continue;
        }
        let toolName = '';
        for (let j = 0; j < messages.length; j += 1) {
            const candidate = messages[j] as {role?: string; tool_calls?: unknown};
            const toolCalls = Array.isArray(candidate.tool_calls)
                ? (candidate.tool_calls as Array<{id?: unknown; function?: {name?: unknown}}>)
                : [];
            const matched = toolCalls.find((call) => call.id === message.tool_call_id);
            if (matched && typeof matched.function?.name === 'string') {
                toolName = matched.function.name;
                break;
            }
        }
        return {
            toolName,
            isError: false,
            text: contentText(message.content),
            raw: message,
        };
    }
    return null;
};

const hasToolHistory = (messages: readonly unknown[]): boolean =>
    messages.some((message) => {
        const candidate = message as {role?: string; tool_calls?: unknown; content?: unknown};
        if (candidate.role === 'tool') {
            return true;
        }
        return Array.isArray(candidate.tool_calls) && candidate.tool_calls.length > 0;
    });

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
    id: 'closed-beta-faux',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'closed-beta-faux-model',
    choices: [{index: 0, delta, finish_reason: finishReason}],
});

export type StartFauxModelOptions = {
    provider?: string;
    model?: string;
    script: ClosedBetaScript;
};

export const startClosedBetaFauxModel = async (
    options: StartFauxModelOptions,
): Promise<ClosedBetaModelHandle> => {
    const provider = options.provider ?? 'closed-beta';
    const model = options.model ?? 'closed-beta-model';
    const requestModels: string[] = [];
    const authHeaders: string[] = [];
    const toolResultLog: ToolResultLog[] = [];
    const hookWaiters = new Map<string, Array<() => void>>();
    let requestCount = 0;

    const releaseHook = (name: string): void => {
        const waiters = hookWaiters.get(name) ?? [];
        hookWaiters.delete(name);
        for (const resolve of waiters) {
            resolve();
        }
    };

    const script: ClosedBetaScript = options.script;

    const server = http.createServer((req, res) => {
        void (async () => {
            if (req.method !== 'POST' || !(req.url ?? '').includes('/chat/completions')) {
                res.writeHead(404);
                res.end();
                return;
            }
            const auth = req.headers.authorization;
            if (typeof auth === 'string') {
                authHeaders.push(auth);
            }
            let raw = '';
            for await (const chunk of req) {
                raw += String(chunk);
            }
            let body: {messages?: unknown[]; model?: unknown; response_format?: unknown; stream?: unknown; tools?: unknown} = {};
            try {
                body = JSON.parse(raw) as typeof body;
            } catch {
                // treats the body as an empty conversation
            }
            if (typeof body.model === 'string') {
                requestModels.push(body.model);
            }
            requestCount += 1;
            const messages = Array.isArray(body.messages) ? body.messages : [];
            const ctx: ClosedBetaModelCtx = {
                requestNumber: requestCount,
                messages,
                lastUser: lastUserText(messages),
                lastTool: lastToolResult(messages),
                hasToolHistory: hasToolHistory(messages),
                rawTools: Array.isArray(body.tools) ? body.tools : [],
                releaseHook,
            };
            if (ctx.lastTool) {
                toolResultLog.push({name: ctx.lastTool.toolName, requestNumber: requestCount});
            }
            let step: WireStep;
            try {
                step = await script(ctx);
            } catch (error) {
                // A script that hit an unexpected state terminates the turn with
                // a plain completion so the agent can finish visibly.
                sseOpen(res);
                sseWrite(res, completionChunk({role: 'assistant', content: `faux model error: ${String(error)}`}, null));
                sseWrite(res, completionChunk({}, 'stop'));
                sseDone(res);
                return;
            }
            sseOpen(res);
            if ('tool' in step) {
                sseWrite(res, completionChunk({role: 'assistant', content: ''}, null));
                sseWrite(res, completionChunk({
                    tool_calls: [{
                        index: 0,
                        id: `call_${step.tool.name.replaceAll('.', '_')}_${requestCount}`,
                        type: 'function',
                        function: {name: step.tool.name, arguments: JSON.stringify(step.tool.args)},
                    }],
                }, null));
                sseWrite(res, completionChunk({}, 'stop'));
            } else {
                sseWrite(res, completionChunk({role: 'assistant', content: step.text}, null));
                sseWrite(res, completionChunk({}, 'stop'));
            }
            sseDone(res);
        })();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (typeof address === 'string' || !address) {
        server.close();
        throw new Error('failed to allocate faux model port');
    }
    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        provider,
        model,
        requestCount: () => requestCount,
        observedRequestModels: requestModels,
        receivedAuthHeaders: authHeaders,
        toolResultLog,
        awaitToolResult: async (predicate) => {
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline) {
                const match = [...toolResultLog].find(predicate);
                if (match) {
                    return;
                }
                await sleep(25);
            }
            throw new Error(`faux model never observed the awaited tool result: ${String(predicate)}`);
        },
        releaseHook,
        close: async () => {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        },
    };
};

export const parseCaptureResolveTarget = (text: string): {nodeId: string; meta: {pageEpoch: string; captureRevision: number}} | null => {
    try {
        const envelope = JSON.parse(text) as {
            results?: Array<{data?: {target?: {nodeId?: string; meta?: {pageEpoch?: string; captureRevision?: number}}}}>;
        };
        const target = envelope.results?.[0]?.data?.target;
        const nodeId = target?.nodeId;
        const pageEpoch = target?.meta?.pageEpoch;
        const captureRevision = target?.meta?.captureRevision;
        if (typeof nodeId !== 'string' || typeof pageEpoch !== 'string' || typeof captureRevision !== 'number') {
            return null;
        }
        return {nodeId, meta: {pageEpoch, captureRevision}};
    } catch {
        return null;
    }
};

export const parseProgramOutcome = (text: string): {status: string; text?: string; error?: {code?: string}; pause?: {reason?: string}} | null => {
    try {
        return JSON.parse(text) as {status: string; text?: string; error?: {code?: string}; pause?: {reason?: string}};
    } catch {
        return null;
    }
};

export const parseDslPauseResult = (text: string): {code?: string} | null => {
    try {
        const parsed = JSON.parse(text) as {pause?: {failure?: {code?: string}}};
        return parsed.pause?.failure ?? null;
    } catch {
        return null;
    }
};

/**
 * Script: ordinary DOM form via snapshot -> capture_resolve -> Program, then
 * authorize the unannotated mutation barrier the way a real agent would.
 * Targets are resolved by explicit selector to stay deterministic.
 */
export const planFillProgramScript = (options: {selector: string; value: string; outputName?: string}): ClosedBetaScript => {
    const {selector, value} = options;
    const outputName = options.outputName ?? 'result';
    const source = [
        'fill input.target with input.value',
        `output ${outputName} = input.value`,
    ].join('\n');
    return (ctx) => {
        const last = ctx.lastTool;
        if (!last) {
            return wireTool('browser.snapshot', {});
        }
        if (last.toolName === 'browser.snapshot') {
            return wireTool('browser.capture_resolve', {selector});
        }
        if (last.toolName === 'browser.capture_resolve') {
            const target = parseCaptureResolveTarget(last.text);
            if (!target) {
                throw new Error('capture_resolve did not return an observed target envelope');
            }
            return wireTool('agent.execute_program', {source, input: {target, value}});
        }
        if (last.toolName === 'agent.execute_program') {
            const outcome = parseProgramOutcome(last.text);
            if (outcome?.status === 'paused' && outcome.pause?.reason === 'barrier') {
                return wireTool('debug.cross_barrier', {});
            }
            return wireText('task end');
        }
        if (last.toolName === 'debug.cross_barrier') {
            const outcome = parseProgramOutcome(last.text);
            if (outcome?.status === 'paused' && outcome.pause?.reason === 'barrier') {
                return wireTool('debug.cross_barrier', {});
            }
            return wireText('task end');
        }
        return wireText('task end');
    };
};