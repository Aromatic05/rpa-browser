import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
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
            if (res.ok) {return;}
        } catch {
            // ignore
        }
        await sleep(300);
    }
    throw new Error('failed to start MCP HTTP server');
};

const stopServer = async (child: ChildProcess) => {
    if (child.killed || child.exitCode !== null) {return;}
    child.kill('SIGTERM');
    const graceful = await Promise.race([
        new Promise<boolean>((resolve) => {
            child.once('exit', () => resolve(true));
        }),
        sleep(3000).then(() => false),
    ]);
    if (!graceful && child.exitCode === null) {
        child.kill('SIGKILL');
    }
};

const createHttpClient = (baseUrl: string) => {
    let nextId = 1;

    const request = async (method: string, params: Record<string, unknown>) => {
        const id = nextId++;
        const postRes = await fetch(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                connection: 'close',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params,
            }),
        });
        if (!postRes.ok) {
            throw new Error(`unexpected MCP POST status: ${postRes.status}`);
        }
        return (await postRes.json()) as JsonRpcMessage;
    };

    return {
        request,
        close: async () => undefined,
    };
};

const parseToolResult = (message: JsonRpcMessage) => {
    const result = message.result as { content?: Array<{ type: string; text?: string }> } | undefined;
    const text = result?.content?.find((item) => item.type === 'text')?.text;
    if (!text) {return null;}
    return JSON.parse(text);
};

const main = async () => {
    const port = 17654 + Math.floor(Math.random() * 400);
    const baseUrl = `http://127.0.0.1:${port}`;
    const userDataDir = `/tmp/rpa-agent-mcp-smoke-${Date.now()}`;
    const child = startServer(port, userDataDir);

    try {
        await waitForServer(baseUrl);
        const client = createHttpClient(baseUrl);

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
        await stopServer(child);
    }
};

void main();
