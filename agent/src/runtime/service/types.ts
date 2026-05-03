export type WorkspaceServiceName = 'mcp';
// `agent` will be added in a later phase.

export type WorkspaceServiceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export type WorkspaceServiceStartResult = {
    serviceName: WorkspaceServiceName;
    workspaceName: string;
    port: number;
    status: WorkspaceServiceStatus;
};

export type WorkspaceServiceStopResult = {
    serviceName: WorkspaceServiceName;
    workspaceName: string;
    status: WorkspaceServiceStatus;
};

export type WorkspaceServiceStatusResult = {
    serviceName: WorkspaceServiceName;
    workspaceName: string;
    port: number | null;
    status: WorkspaceServiceStatus;
};

export type WorkspaceService = {
    readonly name: WorkspaceServiceName;
    readonly workspaceName: string;
    start: () => Promise<WorkspaceServiceStartResult>;
    stop: () => Promise<WorkspaceServiceStopResult>;
    status: () => WorkspaceServiceStatusResult;
};
