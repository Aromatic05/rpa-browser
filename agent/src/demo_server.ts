import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMaskedConfig, mergeConfig, readConfig, writeConfig } from './demo/config_store';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.resolve(__dirname, '../static');
const HOST = '127.0.0.1';
const PORT = 17334;

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
