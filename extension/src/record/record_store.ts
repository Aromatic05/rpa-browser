import type { RecordedStep } from '../shared/types.js';

export type RecordStore = {
    appendStep: (workspaceId: string, step: RecordedStep) => Promise<void>;
    getSteps: (workspaceId: string) => Promise<RecordedStep[]>;
    clearSteps: (workspaceId: string) => Promise<void>;
};

/**
 * record_store：录制步骤的本地缓存（仅内存）。
 *
 * 说明：
 * - 正式录制流程已迁移到 agent 侧
 * - extension 不再写入 chrome.storage
 * - 这里保留内存实现，便于调试或短暂过渡
 */
export const createRecordStore = (_storage?: chrome.storage.StorageArea): RecordStore => {
    const memory = new Map<string, RecordedStep[]>();

    const read = async (workspaceId: string) => memory.get(workspaceId) || [];

    const write = async (workspaceId: string, steps: RecordedStep[]) => {
        memory.set(workspaceId, steps);
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
