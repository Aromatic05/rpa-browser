import type { RecordingEnhancementMap, RecordedStepEnhancement } from '../../../record/types';

const REPLAY_ENHANCEMENT_STORE_KEY = '__rpaReplayEnhancementStore';

const getWorkspaceEnhancementStore = (): Map<string, RecordingEnhancementMap> => {
    const globalObject = globalThis as typeof globalThis & {
        [REPLAY_ENHANCEMENT_STORE_KEY]?: Map<string, RecordingEnhancementMap>;
    };
    if (!globalObject[REPLAY_ENHANCEMENT_STORE_KEY]) {
        globalObject[REPLAY_ENHANCEMENT_STORE_KEY] = new Map<string, RecordingEnhancementMap>();
    }
    return globalObject[REPLAY_ENHANCEMENT_STORE_KEY] as Map<string, RecordingEnhancementMap>;
};

export const setReplayEnhancementContext = (workspaceId: string, enrichments: RecordingEnhancementMap) => {
    const workspaceEnhancementStore = getWorkspaceEnhancementStore();
    workspaceEnhancementStore.set(workspaceId, enrichments);
};

export const clearReplayEnhancementContext = (workspaceId: string) => {
    const workspaceEnhancementStore = getWorkspaceEnhancementStore();
    workspaceEnhancementStore.delete(workspaceId);
};

export const getReplayEnhancementForStep = (
    workspaceId: string,
    stepId: string | undefined,
): RecordedStepEnhancement | undefined => {
    if (!stepId) return undefined;
    const workspaceEnhancementStore = getWorkspaceEnhancementStore();
    const workspaceMap = workspaceEnhancementStore.get(workspaceId);
    if (!workspaceMap) return undefined;
    return workspaceMap[stepId];
};
