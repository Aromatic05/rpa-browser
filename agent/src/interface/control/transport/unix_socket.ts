import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { ControlConnection, ControlTransport } from './types';

const createConnection = (socket: net.Socket): ControlConnection => {
    let buffer = '';
    const lineHandlers = new Set<(line: string) => void>();
    const closeHandlers = new Set<() => void>();

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
        buffer += chunk;
        while (true) {
            const index = buffer.indexOf('\n');
            if (index < 0) {
                break;
            }
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            for (const handler of lineHandlers) {
                handler(line);
            }
        }
    });
    socket.on('close', () => {
        for (const handler of closeHandlers) {
            handler();
        }
    });

    return {
        writeLine(line: string): void {
            socket.write(line);
        },
        close(): void {
            socket.end();
        },
        onLine(handler: (line: string) => void): void {
            lineHandlers.add(handler);
        },
        onClose(handler: () => void): void {
            closeHandlers.add(handler);
        },
    };
};

export const createUnixSocketTransport = (endpoint: string): ControlTransport => {
    const server = net.createServer();

    return {
        endpoint,
        async listen(onConnection): Promise<void> {
            await fs.mkdir(path.dirname(endpoint), { recursive: true });
            try {
                await fs.unlink(endpoint);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT') {
                    throw error;
                }
            }

            server.on('connection', (socket) => {
                onConnection(createConnection(socket));
            });

            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(endpoint, () => {
                    server.off('error', reject);
                    resolve();
                });
            });
        },
        async close(): Promise<void> {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
            try {
                await fs.unlink(endpoint);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT') {
                    throw error;
                }
            }
        },
    };
};
