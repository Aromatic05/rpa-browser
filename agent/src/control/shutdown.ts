export type ControlShutdownHandle = {
    close(): Promise<void>;
};

export const registerControlShutdown = (
    server: ControlShutdownHandle,
    log: (...args: unknown[]) => void,
): void => {
    let closing: Promise<void> | null = null;

    const closeOnce = async (signal: NodeJS.Signals) => {
        if (!closing) {
            log(`Shutdown signal received: ${signal}`);
            closing = server.close().catch((error) => {
                log('Control RPC shutdown failed', error instanceof Error ? error.message : String(error));
            });
        }
        await closing;
    };

    const bind = (signal: NodeJS.Signals) => {
        process.once(signal, () => {
            void closeOnce(signal).finally(() => {
                process.exit(0);
            });
        });
    };

    bind('SIGINT');
    bind('SIGTERM');
};
