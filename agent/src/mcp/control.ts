import type {
    WorkspaceService,
    WorkspaceServiceStartResult,
    WorkspaceServiceStopResult,
    WorkspaceServiceStatusResult,
} from '../runtime/service/types';

export type McpControl = {
    start: () => Promise<WorkspaceServiceStartResult>;
    stop: () => Promise<WorkspaceServiceStopResult>;
    status: () => WorkspaceServiceStatusResult;
};

export const createMcpControl = (service: WorkspaceService): McpControl => ({
    start: () => service.start(),
    stop: () => service.stop(),
    status: () => service.status(),
});
