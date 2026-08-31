const DEFAULT_RUNTIME_PORT_BASE = 17600;
const WORKER_PORT_STRIDE = 1000;

export const e2eRuntimePortEnv = (): Record<string, string> => {
    const raw = process.env.TEST_WORKER_INDEX?.trim();
    if (!raw) {return {};}
    const workerIndex = Number(raw);
    if (!Number.isInteger(workerIndex) || workerIndex < 0 || workerIndex > 40) {
        throw new Error(`invalid Playwright TEST_WORKER_INDEX: ${raw}`);
    }
    return {
        RPA_RUNTIME_PORT_BASE: String(DEFAULT_RUNTIME_PORT_BASE + workerIndex * WORKER_PORT_STRIDE),
    };
};
