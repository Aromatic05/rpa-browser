import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.resolve(__dirname, '../static');
const HOST = '127.0.0.1';
const PORT = 17334;

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
