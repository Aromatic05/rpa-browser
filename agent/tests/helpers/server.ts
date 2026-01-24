import http from 'http';
import path from 'path';
import { promises as fs } from 'fs';

export const startFixtureServer = async () => {
    const fixturesDir = path.resolve(process.cwd(), 'tests/fixtures');
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        let pathname = url.pathname === '/' ? '/choices.html' : url.pathname;
        const filePath = path.join(fixturesDir, pathname);
        try {
            const data = await fs.readFile(filePath);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        } catch {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (typeof address === 'string' || !address) {
        throw new Error('Failed to start server');
    }
    const baseURL = `http://127.0.0.1:${address.port}`;
    return {
        server,
        baseURL,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
    };
};
