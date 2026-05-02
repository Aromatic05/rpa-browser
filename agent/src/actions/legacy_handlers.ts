import type { ActionHandler } from './execute';
import { recordingHandlers } from './recording';
import { taskStreamHandlers } from './task_stream';
import { workspaceHandlers } from './workspace';
import { workflowHandlers } from './workflow';

export const actionHandlers: Partial<Record<string, ActionHandler>> = {
    ...recordingHandlers,
    ...taskStreamHandlers,
    ...workspaceHandlers,
    ...workflowHandlers,
};
