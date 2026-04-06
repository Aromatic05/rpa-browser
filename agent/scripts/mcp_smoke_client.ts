import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const agentRoot = path.resolve(__dirname, '..');

type JsonRpcMessage = {
    jsonrpc: '2.0';
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startServer = (port: number, userDataDir: string) => {
    return spawn(process.execPath, ['--import', 'tsx/esm', 'src/mcp_main.ts'], {
        cwd: agentRoot,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
            ...process.env,
            RPA_MCP_HOST: '127.0.0.1',
            RPA_MCP_PORT: String(port),
            RPA_USER_DATA_DIR: userDataDir,
        },
    });
};

const waitForServer = async (baseUrl: string) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseUrl}/health`);
            if (res.ok) return;
        } catch {
            // ignore
        }
        await sleep(300);
    }
    throw new Error('failed to start MCP HTTP server');
};

const createSseClient = async (baseUrl: string) => {
    const abortController = new AbortController();
    const res = await fetch(`${baseUrl}/sse`, {
        headers: { accept: 'text/event-stream' },
        signal: abortController.signal,
    });
    if (!res.ok || !res.body) {
        throw new Error(`failed to open SSE: ${res.status}`);
    }

    let messageEndpoint = '';
    let nextId = 1;
    const pending = new Map<number, (message: JsonRpcMessage) => void>();
    let readyResolve: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
    });

    let currentEvent = '';
    let currentData = '';
    let buffer = '';
    const reader = res.body.getReader();

    const flushEvent = () => {
        if (!currentEvent) return;
        if (currentEvent === 'endpoint') {
            messageEndpoint = currentData.trim();
            if (messageEndpoint && readyResolve) {
                readyResolve();
                readyResolve = null;
            }
        } else if (currentEvent === 'message') {
            try {
                const message = JSON.parse(currentData) as JsonRpcMessage;
                if (typeof message.id === 'number') {
                    const resolver = pending.get(message.id);
                    if (resolver) {
                        pending.delete(message.id);
                        resolver(message);
                    }
                }
            } catch {
                // ignore malformed events
            }
        }
        currentEvent = '';
        currentData = '';
    };

    const loop = (async () => {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value, { stream: true });
            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
                buffer = buffer.slice(newlineIndex + 1);
                if (!line) {
                    flushEvent();
                } else if (line.startsWith('event:')) {
                    currentEvent = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                    const piece = line.slice(5).trim();
                    currentData = currentData ? `${currentData}\n${piece}` : piece;
                }
                newlineIndex = buffer.indexOf('\n');
            }
        }
    })();

    const request = async (method: string, params: Record<string, unknown>) => {
        await ready;
        const id = nextId++;
        const promise = new Promise<JsonRpcMessage>((resolve) => {
            pending.set(id, resolve);
        });
        const postUrl = new URL(messageEndpoint, baseUrl).toString();
        const postRes = await fetch(postUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params,
            }),
        });
        if (postRes.status !== 202) {
            throw new Error(`unexpected MCP POST status: ${postRes.status}`);
        }
        return promise;
    };

    return {
        request,
        close: async () => {
            abortController.abort();
            await loop.catch(() => undefined);
        },
    };
};

const parseToolResult = (message: JsonRpcMessage) => {
    const result = message.result as { content?: Array<{ type: string; text?: string }> } | undefined;
    const text = result?.content?.find((item) => item.type === 'text')?.text;
    if (!text) return null;
    return JSON.parse(text);
};

const main = async () => {
    const port = 17654 + Math.floor(Math.random() * 400);
    const baseUrl = `http://127.0.0.1:${port}`;
    const userDataDir = `/tmp/rpa-agent-mcp-smoke-${Date.now()}`;
    const child = startServer(port, userDataDir);

    try {
        await waitForServer(baseUrl);
        const client = await createSseClient(baseUrl);

        const listResp = await client.request('tools/list', {});
        console.log('tools/list:', JSON.stringify(listResp.result, null, 2));

        const tabToken = 'mcp-smoke-tab';
        const gotoResp = await client.request('tools/call', {
            name: 'browser.goto',
            arguments: { tabToken, url: 'https://example.com' },
        });
        const gotoResult = parseToolResult(gotoResp);
        console.log('browser.goto:', JSON.stringify(gotoResult, null, 2));

        const snapResp = await client.request('tools/call', {
            name: 'browser.snapshot',
            arguments: { tabToken },
        });
        const snapResult = parseToolResult(snapResp);
        console.log('browser.snapshot:', JSON.stringify(snapResult, null, 2));

        await client.close();

        const failures = [gotoResult, snapResult].filter((result) => result && result.ok === false);
        if (failures.length) {
            process.exitCode = 1;
        }
    } catch (error) {
        console.error('smoke client failed:', error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    } finally {
        child.kill('SIGTERM');
    }
};

void main();
