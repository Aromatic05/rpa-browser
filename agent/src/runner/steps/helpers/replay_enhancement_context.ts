import type { RecordingEnhancementMap, RecordedStepEnhancement } from '../../../record/types';

const workspaceEnhancementStore = new Map<string, RecordingEnhancementMap>();

export const setReplayEnhancementContext = (workspaceId: string, enrichments: RecordingEnhancementMap) => {
    workspaceEnhancementStore.set(workspaceId, enrichments);
};

export const clearReplayEnhancementContext = (workspaceId: string) => {
    workspaceEnhancementStore.delete(workspaceId);
};

export const getReplayEnhancementForStep = (
    workspaceId: string,
    stepId: string | undefined,
): RecordedStepEnhancement | undefined => {
    if (!stepId) return undefined;
    const workspaceMap = workspaceEnhancementStore.get(workspaceId);
    if (!workspaceMap) return undefined;
    return workspaceMap[stepId];
};
