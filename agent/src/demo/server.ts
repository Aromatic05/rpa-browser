import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMaskedConfig, mergeConfig, readConfig, writeConfig } from './config_store';
import { createContextManager, resolvePaths } from '../runtime/context_manager';
import { createPageRegistry } from '../runtime/page_registry';
import { createRuntimeRegistry } from '../runtime/runtime_registry';
import { createWorkspaceManager } from './workspace_manager';
import { cleanupRecording, createRecordingState, ensureRecorder } from '../record/recording';
import { runAgentLoop } from './agent_loop';
import { createChatCompletion } from './openai_compat_client';
import { createConsoleStepSink, setRunStepsDeps } from '../runner/run_steps';
import { getRunnerConfig } from '../runner/config';
import { FileSink, createLoggingHooks, createNoopHooks } from '../runner/trace';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.resolve(__dirname, '../../static');
const HOST = '127.0.0.1';
const PORT = 17334;
const TAB_TOKEN_KEY = '__rpa_tab_token';
const CLICK_DELAY_MS = 300;
const REPLAY_STEP_DELAY_MS = 900;
const NAV_DEDUPE_WINDOW_MS = 1200;
const SCROLL_CONFIG = { minDelta: 220, maxDelta: 520, minSteps: 2, maxSteps: 4 };

const readJsonBody = async (req: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (!chunks.length) return null;
    const raw = Buffer.concat(chunks).toString('utf8');
    return JSON.parse(raw);
};

const sendJson = (res: http.ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
};

const serveFile = async (res: http.ServerResponse, filePath: string, contentType: string) => {
    try {
        const data = await fs.readFile(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
};

const paths = resolvePaths();
const recordingState = createRecordingState();
const contextManager = createContextManager({
    extensionPath: paths.extensionPath,
    userDataDir: paths.userDataDir,
    onPage: (page) => {
        void pageRegistry.bindPage(page);
    },
});
let runtimeRegistry: ReturnType<typeof createRuntimeRegistry>;

const pageRegistry = createPageRegistry({
    tabTokenKey: TAB_TOKEN_KEY,
    getContext: contextManager.getContext,
    onPageBound: (page, token) => {
        if (recordingState.recordingEnabled.has(token)) {
            void ensureRecorder(recordingState, page, token, NAV_DEDUPE_WINDOW_MS);
        }
        if (runtimeRegistry) {
            runtimeRegistry.bindPage(page, token);
        }
    },
    onTokenClosed: (token) => cleanupRecording(recordingState, token),
});

const workspaceManager = createWorkspaceManager({
    pageRegistry,
    recordingState,
    log: (...args: unknown[]) => console.log('[RPA:demo]', ...args),
    replayOptions: {
        clickDelayMs: CLICK_DELAY_MS,
        stepDelayMs: REPLAY_STEP_DELAY_MS,
        scroll: SCROLL_CONFIG,
    },
    navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
});

const config = getRunnerConfig();
const traceSinks = config.observability.traceFileEnabled
    ? [new FileSink(config.observability.traceFilePath)]
    : [];

// 仅用于 demo；runSteps 直接通过 runtimeRegistry 执行
runtimeRegistry = createRuntimeRegistry({
    pageRegistry,
    traceSinks,
    traceHooks: config.observability.traceConsoleEnabled
        ? createLoggingHooks()
        : createNoopHooks(),
});
setRunStepsDeps({
    runtime: runtimeRegistry,
    stepSinks: [createConsoleStepSink('[step]')],
    config,
});

const buildToolDeps = () => ({
    pageRegistry,
    getActiveTabToken: async () => {
        const workspace = await workspaceManager.ensureActiveWorkspace();
        return workspace.tabToken;
    },
});

const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (url.pathname === '/api/config') {
        if (req.method === 'GET') {
            void getMaskedConfig().then((cfg) => sendJson(res, 200, cfg));
            return;
        }
        if (req.method === 'PUT') {
            void (async () => {
                const patch = (await readJsonBody(req)) || {};
                const current = await readConfig();
                const next = mergeConfig(current, patch);
                await writeConfig(next);
                const masked = await getMaskedConfig();
                sendJson(res, 200, masked);
            })().catch(() => {
                sendJson(res, 400, { error: 'invalid request body' });
            });
            return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }
    if (url.pathname === '/api/env/prepare' && req.method === 'POST') {
        void (async () => {
            const body = (await readJsonBody(req)) || {};
            const urlHint = typeof body.url === 'string' ? body.url : undefined;
            await workspaceManager.ensureActiveWorkspace();
            if (urlHint) {
                await workspaceManager.gotoInWorkspace(urlHint);
            }
            const info = await workspaceManager.getActiveWorkspacePublicInfo();
            sendJson(res, 200, info);
        })().catch(() => {
            sendJson(res, 400, { error: 'invalid request body' });
        });
        return;
    }
    if (url.pathname === '/api/env/status' && req.method === 'GET') {
        void workspaceManager.getActiveWorkspacePublicInfo().then((info) => sendJson(res, 200, info));
        return;
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
        void (async () => {
            const body = (await readJsonBody(req)) || {};
            const message = typeof body.message === 'string' ? body.message : '';
            if (!message) {
                sendJson(res, 400, { error: 'missing message' });
                return;
            }
            await workspaceManager.ensureActiveWorkspace();
            const config = await readConfig();
            const result = await runAgentLoop({
                message,
                config,
                toolDeps: buildToolDeps(),
            });
            sendJson(res, 200, result);
        })().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { error: message });
        });
        return;
    }
    if (url.pathname === '/api/llm/debug' && req.method === 'POST') {
        void (async () => {
            const config = await readConfig();
            const start = Date.now();
            const response = await createChatCompletion({
                apiBase: config.apiBase || 'http://127.0.0.1:11434',
                apiKey: config.apiKey,
                model: config.model || 'gpt-4.1-mini',
                temperature: config.temperature,
                maxTokens: config.maxTokens,
                messages: [
                    { role: 'system', content: 'You are a concise assistant.' },
                    { role: 'user', content: 'Say OK.' },
                ],
            });
            sendJson(res, 200, {
                ok: true,
                latencyMs: Date.now() - start,
                message: response.message?.content || '',
            });
        })().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { ok: false, error: message });
        });
        return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
        const filePath = path.join(STATIC_DIR, 'index.html');
        void serveFile(res, filePath, 'text/html; charset=utf-8');
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(PORT, HOST, () => {
    console.log(`[RPA:demo] server listening at http://${HOST}:${PORT}`);
});

void contextManager.getContext().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[RPA:demo]', 'Failed to launch Playwright Chromium:', message);
});
