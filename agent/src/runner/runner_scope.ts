export type RunnerScopeRegistry = {
    run: <T>(workspaceId: string, task: () => Promise<T>) => Promise<T>;
};

type Semaphore = {
    acquire: () => Promise<void>;
    release: () => void;
};

const createSemaphore = (maxConcurrent: number): Semaphore => {
    let inFlight = 0;
    const waiters: Array<() => void> = [];

    const acquire = async () => {
        if (inFlight < maxConcurrent) {
            inFlight += 1;
            return;
        }
        await new Promise<void>((resolve) => {
            waiters.push(resolve);
        });
        inFlight += 1;
    };

    const release = () => {
        inFlight = Math.max(0, inFlight - 1);
        const next = waiters.shift();
        if (next) next();
    };

    return { acquire, release };
};

export const createRunnerScopeRegistry = (maxConcurrent = 2): RunnerScopeRegistry => {
    const semaphore = createSemaphore(maxConcurrent);
    const queues = new Map<string, Promise<unknown>>();

    const run = async <T>(workspaceId: string, task: () => Promise<T>) => {
        const previous = queues.get(workspaceId) || Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                await semaphore.acquire();
                try {
                    return await task();
                } finally {
                    semaphore.release();
                }
            });
        queues.set(workspaceId, next);
        return next as Promise<T>;
    };

    return { run };
};
