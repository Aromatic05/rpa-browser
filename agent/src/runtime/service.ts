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

export type WorkspaceServiceLifecycle = {
    register: (service: WorkspaceService) => void;
    start: (serviceName: WorkspaceServiceName) => Promise<WorkspaceServiceStartResult>;
    stop: (serviceName: WorkspaceServiceName) => Promise<WorkspaceServiceStopResult>;
    status: (serviceName: WorkspaceServiceName) => WorkspaceServiceStatusResult;
};

export const createWorkspaceServiceLifecycle = (workspaceName: string): WorkspaceServiceLifecycle => {
    const services = new Map<WorkspaceServiceName, WorkspaceService>();

    return {
        register(service) {
            services.set(service.name, service);
        },

        async start(serviceName) {
            const service = services.get(serviceName);
            if (!service) {
                throw new Error(`service not registered: ${serviceName}`);
            }
            return await service.start();
        },

        async stop(serviceName) {
            const service = services.get(serviceName);
            if (!service) {
                throw new Error(`service not registered: ${serviceName}`);
            }
            return await service.stop();
        },

        status(serviceName) {
            const service = services.get(serviceName);
            if (!service) {
                return {
                    serviceName,
                    workspaceName,
                    port: null,
                    status: 'stopped' as const,
                };
            }
            return service.status();
        },
    };
};
