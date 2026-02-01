import type { ActionHandler } from '../execute';
import { recordingHandlers } from './recording';
import { a11yHandlers } from './a11y';
import { workspaceHandlers } from './workspace';
import { stepsHandlers } from './steps';

export const actionHandlers: Record<string, ActionHandler> = {
    ...recordingHandlers,
    ...a11yHandlers,
    ...workspaceHandlers,
    ...stepsHandlers,
};
