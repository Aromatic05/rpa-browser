import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const agentRoot = path.resolve(__dirname, '..');

type JsonRpcResponse = {
    jsonrpc: string;
    id: number;
    result?: any;
    error?: any;
};

const startServer = () => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/mcp_main.ts'], {
        cwd: agentRoot,
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env },
    });
    return child;
};

const waitForResponse = () => {
    let buffer = '';
    const pending = new Map<number, (resp: JsonRpcResponse) => void>();

    const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line.length) {
                try {
                    const parsed = JSON.parse(line) as JsonRpcResponse;
                    const resolver = pending.get(parsed.id);
                    if (resolver) {
                        pending.delete(parsed.id);
                        resolver(parsed);
                    }
                } catch {
                    // ignore malformed lines
                }
            }
            idx = buffer.indexOf('\n');
        }
    };

    return { pending, onData };
};

const sendRequest = (
    stdin: NodeJS.WritableStream,
    pending: Map<number, (resp: JsonRpcResponse) => void>,
    id: number,
    method: string,
    params: Record<string, unknown>,
) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    stdin.write(`${payload}\n`);
    return new Promise<JsonRpcResponse>((resolve) => {
        pending.set(id, resolve);
    });
};

const parseToolResult = (response: JsonRpcResponse) => {
    const text = response.result?.content?.find((item: any) => item.type === 'text')?.text;
    if (!text) return null;
    return JSON.parse(text);
};

const main = async () => {
    const child = startServer();
    const { pending, onData } = waitForResponse();
    if (!child.stdout || !child.stdin) {
        console.error('failed to start MCP server');
        process.exit(1);
    }
    child.stdout.on('data', onData);

    const tabToken = 'mcp-smoke-tab';

    try {
        const listResp = await sendRequest(child.stdin, pending, 1, 'tools/list', {});
        console.log('tools/list:', JSON.stringify(listResp.result, null, 2));

        const gotoResp = await sendRequest(child.stdin, pending, 2, 'tools/call', {
            name: 'browser.goto',
            arguments: { tabToken, url: 'https://example.com' },
        });
        const gotoResult = parseToolResult(gotoResp);
        console.log('browser.goto:', JSON.stringify(gotoResult, null, 2));

        const snapResp = await sendRequest(child.stdin, pending, 3, 'tools/call', {
            name: 'browser.snapshot',
            arguments: { tabToken },
        });
        const snapResult = parseToolResult(snapResp);
        console.log('browser.snapshot:', JSON.stringify(snapResult, null, 2));

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
