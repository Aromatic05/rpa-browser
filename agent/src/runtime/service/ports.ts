import net from 'node:net';

const DEFAULT_BASE_PORT = 17600;

export type PortAllocator = {
    allocate: (workspaceName: string, serviceName: string) => Promise<number>;
    release: (workspaceName: string, serviceName: string) => void;
    getPort: (workspaceName: string, serviceName: string) => number | null;
    listAllocations: () => Array<{ workspaceName: string; serviceName: string; port: number }>;
};

const keyOf = (workspaceName: string, serviceName: string) => `${workspaceName}::${serviceName}`;

const isPortAvailable = (port: number, host?: string): Promise<boolean> =>
    new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port, host || '127.0.0.1', () => {
            server.close(() => resolve(true));
        });
    });

export const createPortAllocator = (basePort?: number): PortAllocator => {
    const allocations = new Map<string, number>();
    const base = basePort ?? DEFAULT_BASE_PORT;
    let nextPort = base;

    const allocate = async (workspaceName: string, serviceName: string): Promise<number> => {
        const key = keyOf(workspaceName, serviceName);
        const existing = allocations.get(key);
        if (existing !== undefined) {
            return existing;
        }

        let port = nextPort;
        let attempts = 0;
        const maxAttempts = 1000;

        while (attempts < maxAttempts) {
            const available = await isPortAvailable(port);
            if (available) {
                allocations.set(key, port);
                nextPort = port + 1;
                return port;
            }
            port += 1;
            attempts += 1;
        }

        throw new Error(
            `port allocator: unable to find available port for ${workspaceName}/${serviceName} after ${maxAttempts} attempts`,
        );
    };

    const release = (workspaceName: string, serviceName: string): void => {
        allocations.delete(keyOf(workspaceName, serviceName));
    };

    const getPort = (workspaceName: string, serviceName: string): number | null =>
        allocations.get(keyOf(workspaceName, serviceName)) ?? null;

    const listAllocations = (): Array<{ workspaceName: string; serviceName: string; port: number }> =>
        Array.from(allocations.entries()).map(([key, port]) => {
            const [workspaceName, serviceName] = key.split('::');
            return { workspaceName, serviceName, port };
        });

    return { allocate, release, getPort, listAllocations };
};
