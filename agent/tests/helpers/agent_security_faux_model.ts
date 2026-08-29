import http from 'node:http';

/**
 * Deterministic faux OpenAI-compatible model for the security e2e slice.
 *
 * Routing is based purely on the request payload so the run stays deterministic:
 * - a system prompt that names the retained-transaction control phase returns a
 *   plain text completion (the model never crosses an irreversible barrier by
 *   itself, so the paused run remains pending for a human decision);
 * - a first turn with no tool history returns an `agent.execute_program` tool
 *   call for the configured program source/input;
 * - any later turn (a tool result is present) returns a plain text completion.
 *
 * Every request body is retained so tests can sweep it for a canary secret.
 */

export type SecurityFauxModelOptions = {
    programSource?: string;
    programInput?: Record<string, unknown>;
};

export type SecurityFauxModelHandle = {
    baseUrl: string;
    port: number;
    requestCount: () => number;
    requestBodies: () => string[];
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

const systemText = (messages: Array<Record<string, unknown>>): string => {
    for (const message of messages) {
        if (message?.role === 'system') {
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

export const startSecurityFauxModel = async (
    options: SecurityFauxModelOptions = {},
): Promise<SecurityFauxModelHandle> => {
    const model = 'security-e2e-model';
    const programSource = options.programSource
        ?? [
            'let ok = compute eq(input.value, input.expected)',
            'ensure ok',
            'output result = ok',
        ].join('\n');
    const programInput = options.programInput ?? {value: 7, expected: 7};

    const bodies: string[] = [];
    let requestCount = 0;

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
            requestCount += 1;
            bodies.push(body);
            let messages: Array<Record<string, unknown>> = [];
            try {
                const parsed = JSON.parse(body) as { messages?: Array<Record<string, unknown>> };
                if (Array.isArray(parsed.messages)) {messages = parsed.messages;}
            } catch {
                // treat a malformed body as empty history
            }
            sseOpen(res);
            if (systemText(messages).includes('retained transaction')) {
                sseWrite(res, completionChunk('sc-1', model, { role: 'assistant', content: 'Retained execution left pending for approval.' }, null));
                sseWrite(res, completionChunk('sc-1', model, {}, 'stop'));
                sseDone(res);
                return;
            }
            if (hasToolHistory(messages)) {
                sseWrite(res, completionChunk('sc-2', model, { role: 'assistant', content: 'Completed the task.' }, null));
                sseWrite(res, completionChunk('sc-2', model, {}, 'stop'));
                sseDone(res);
                return;
            }
            sseWrite(res, completionChunk('sc-3', model, { role: 'assistant', content: '' }, null));
            sseWrite(res, completionChunk('sc-3', model, {
                tool_calls: [{
                    index: 0,
                    id: 'call_security_1',
                    type: 'function',
                    function: {
                        name: 'agent.execute_program',
                        arguments: JSON.stringify({source: programSource, input: programInput}),
                    },
                }],
            }, null));
            sseWrite(res, completionChunk('sc-3', model, {}, 'stop'));
            sseDone(res);
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (typeof address === 'string' || !address) {
        server.close();
        throw new Error('failed to allocate security faux model port');
    }

    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        port: address.port,
        requestCount: () => requestCount,
        requestBodies: () => [...bodies],
        close: async () => {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        },
    };
};