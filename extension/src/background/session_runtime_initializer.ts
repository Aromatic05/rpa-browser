export type SessionRuntimeInitializer = {
    request: () => Promise<void>;
};

export const createSessionRuntimeInitializer = (
    initialize: () => Promise<void>,
): SessionRuntimeInitializer => {
    let requestedGeneration = 0;
    let running: Promise<void> | null = null;

    const drain = async (): Promise<void> => {
        while (true) {
            const generation = requestedGeneration;
            try {
                await initialize();
            } catch (error) {
                if (generation === requestedGeneration) {throw error;}
                continue;
            }
            if (generation === requestedGeneration) {return;}
        }
    };

    const request = (): Promise<void> => {
        requestedGeneration += 1;
        if (running) {return running;}
        const current = drain();
        const tracked = current.finally(() => {
            if (running === tracked) {running = null;}
        });
        running = tracked;
        return tracked;
    };

    return {request};
};
