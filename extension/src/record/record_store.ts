/**
 * record_store：录制步骤的本地缓存与持久化。
 */

import type { RecordedStep } from '../shared/types.js';

export type RecordStore = {
    appendStep: (workspaceId: string, step: RecordedStep) => Promise<void>;
    getSteps: (workspaceId: string) => Promise<RecordedStep[]>;
    clearSteps: (workspaceId: string) => Promise<void>;
};

export const createRecordStore = (storage: chrome.storage.StorageArea): RecordStore => {
    const memory = new Map<string, RecordedStep[]>();

    const read = async (workspaceId: string) => {
        const key = `record:${workspaceId}`;
        const result = await storage.get(key);
        const steps = (result[key] as RecordedStep[]) || [];
        memory.set(workspaceId, steps);
        return steps;
    };

    const write = async (workspaceId: string, steps: RecordedStep[]) => {
        const key = `record:${workspaceId}`;
        memory.set(workspaceId, steps);
        await storage.set({ [key]: steps });
    };

    return {
        appendStep: async (workspaceId, step) => {
            const current = memory.get(workspaceId) || (await read(workspaceId));
            await write(workspaceId, [...current, step]);
        },
        getSteps: async (workspaceId) => memory.get(workspaceId) || read(workspaceId),
        clearSteps: async (workspaceId) => write(workspaceId, []),
    };
};
