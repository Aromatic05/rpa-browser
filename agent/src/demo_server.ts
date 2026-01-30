import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMaskedConfig, mergeConfig, readConfig, writeConfig } from './demo/config_store';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createWorkspaceManager } from './demo/workspace_manager';
import { cleanupRecording, createRecordingState, ensureRecorder } from './record/recording';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.resolve(__dirname, '../static');
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
const pageRegistry = createPageRegistry({
    tabTokenKey: TAB_TOKEN_KEY,
    getContext: contextManager.getContext,
    onPageBound: (page, token) => {
        if (recordingState.recordingEnabled.has(token)) {
            void ensureRecorder(recordingState, page, token, NAV_DEDUPE_WINDOW_MS);
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
