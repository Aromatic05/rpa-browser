export type ExtensionSessionConfig = {
    workspaceName: string;
    wsPort: number;
};

const STORAGE_KEYS = ['rpaWorkspaceName', 'rpaWsPort'] as const;

const readStorage = async (): Promise<Record<string, unknown>> =>
    await chrome.storage.local.get([...STORAGE_KEYS]);

export const readSessionConfig = async (): Promise<ExtensionSessionConfig | null> => {
    const values = await readStorage();
    const workspaceName = typeof values.rpaWorkspaceName === 'string' ? values.rpaWorkspaceName.trim() : '';
    const rawWsPort = values.rpaWsPort;
    const wsPort = typeof rawWsPort === 'number'
        ? rawWsPort
        : typeof rawWsPort === 'string'
          ? Number(rawWsPort)
          : NaN;
    if (!workspaceName || !Number.isInteger(wsPort) || wsPort <= 0) {
        return null;
    }
    return { workspaceName, wsPort };
};
