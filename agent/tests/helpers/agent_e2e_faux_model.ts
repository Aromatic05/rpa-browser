import http from 'node:http';

/**
 * Deterministic faux OpenAI-compatible model used by the agent e2e specs.
 *
 * The agent's model runtime resolves `RUNNER_AGENT_PROVIDER`/`RUNNER_AGENT_MODEL`
 * to a binding whose `streamFn` streams chat completions from `baseUrl`. This
 * server answers those streams without any network dependency:
 *
 * - the first turn of a task script (no tool history yet) returns a tool call to
 *   a fixed program source (optionally after `firstTurnDelayMs`) so the run
 *   stays visibly `running` before it settles;
 * - any later turn (a tool result is present in the history) returns a plain
 *   text completion;
 * - a prompt containing `long-running` holds the stream open (`longHoldMs`,
 *   default forever) so the run can be cancelled mid-flight.
 */

export type FauxModelOptions = {
    provider?: string;
    model?: string;
    programSource?: string;
    programInput?: Record<string, unknown>;
    firstTurnDelayMs?: number;
    longHoldMs?: number;
};

export type FauxModelHandle = {
    baseUrl: string;
    port: number;
    requestCount: () => number;
    toolCallCount: () => number;
    reset: () => void;
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

const completionChunk = (
    id: string,
    model: string,
    delta: Record<string, unknown>,
    finishReason: string | null,
): Record<string, unknown> => ({
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
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

const hasToolHistory = (messages: Array<Record<string, unknown>>): boolean =>
    messages.some((message) => {
        if (message?.role === 'tool') {return true;}
        if (message?.role === 'assistant') {
            return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        }
        return false;
    });

export const startFauxModel = async (options: FauxModelOptions = {}): Promise<FauxModelHandle> => {
    const provider = options.provider ?? 'faux';
    const model = options.model ?? 'faux-model';
    const programSource = options.programSource ?? [
        'let ok = compute eq(input.value, input.expected)',
        'ensure ok',
        'output result = ok',
    ].join('\n');
    const programInput = options.programInput ?? {value: 7, expected: 7};
    const firstTurnDelayMs = options.firstTurnDelayMs ?? 0;
    const longHoldMs = options.longHoldMs ?? Number.POSITIVE_INFINITY;

    let requestCount = 0;
    let toolCallCount = 0;
    const held = new Set<http.ServerResponse>();

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
            const sendToolCompletion = (): void => {
                toolCallCount += 1;
                sseOpen(res);
                sseWrite(res, completionChunk('fc-1', model, { role: 'assistant', content: '' }, null));
                sseWrite(res, completionChunk('fc-1', model, {
                    tool_calls: [{
                        index: 0,
                        id: 'call_program_1',
                        type: 'function',
                        function: {
                            name: 'agent.execute_program',
                            arguments: JSON.stringify({source: programSource, input: programInput}),
                        },
                    }],
                }, null));
                sseWrite(res, completionChunk('fc-1', model, {}, 'stop'));
                sseDone(res);
            };
            const sendTextCompletion = (): void => {
                sseOpen(res);
                sseWrite(res, completionChunk('fc-2', model, { role: 'assistant', content: 'Completed task.' }, null));
                sseWrite(res, completionChunk('fc-2', model, {}, 'stop'));
                sseDone(res);
            };
            const hold = (): void => {
                sseOpen(res);
                sseWrite(res, completionChunk('fc-hold', model, { role: 'assistant', content: '' }, null));
                held.add(res);
                res.on('close', () => {
                    held.delete(res);
                });
                if (Number.isFinite(longHoldMs) && longHoldMs > 0) {
                    setTimeout(() => {
                        if (held.has(res)) {
                            held.delete(res);
                            sendTextCompletion();
                        }
                    }, longHoldMs);
                }
            };

            let messages: Array<Record<string, unknown>> = [];
            try {
                const parsed = JSON.parse(body) as { messages?: Array<Record<string, unknown>> };
                if (Array.isArray(parsed.messages)) {messages = parsed.messages;}
            } catch {
                // Treat a malformed body as an empty history so routing stays safe.
            }
            requestCount += 1;
            if (lastUserText(messages).includes('long-running')) {
                hold();
                return;
            }
            if (hasToolHistory(messages)) {
                sendTextCompletion();
                return;
            }
            if (firstTurnDelayMs > 0) {
                setTimeout(sendToolCompletion, firstTurnDelayMs);
                return;
            }
            sendToolCompletion();
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (typeof address === 'string' || !address) {
        server.close();
        throw new Error('failed to allocate faux model port');
    }

    const close = async (): Promise<void> => {
        for (const res of held) {
            res.destroy();
        }
        held.clear();
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    };

    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        port: address.port,
        requestCount: () => requestCount,
        toolCallCount: () => toolCallCount,
        reset: () => {
            requestCount = 0;
            toolCallCount = 0;
        },
        close,
    };
};