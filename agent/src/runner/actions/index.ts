import type { ActionHandler } from '../execute';
import { recordingHandlers } from './recording';
import { workspaceHandlers } from './workspace';

export const actionHandlers: Record<string, ActionHandler> = {
    ...recordingHandlers,
    ...workspaceHandlers,
};
