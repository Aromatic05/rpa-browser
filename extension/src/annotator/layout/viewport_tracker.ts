export type ViewportScheduler = {
    schedule: () => void;
    dispose: () => void;
};

export type SchedulerClock = {
    requestAnimationFrame: (callback: () => void) => number;
    cancelAnimationFrame: (handle: number) => void;
};

const defaultClock: SchedulerClock = {
    requestAnimationFrame: (callback) =>
        typeof globalThis.requestAnimationFrame === 'function'
            ? globalThis.requestAnimationFrame(callback)
            : (globalThis.setTimeout(callback, 16) as unknown as number),
    cancelAnimationFrame: (handle) =>
        typeof globalThis.cancelAnimationFrame === 'function'
            ? globalThis.cancelAnimationFrame(handle)
            : globalThis.clearTimeout(handle),
};

export const createViewportScheduler = (
    onInvalidate: () => void,
    clock: SchedulerClock = defaultClock,
): ViewportScheduler => {
    let handle: number | null = null;
    let disposed = false;

    const fire = (): void => {
        handle = null;
        if (disposed) {return;}
        onInvalidate();
    };

    return {
        schedule: () => {
            if (disposed) {return;}
            if (handle !== null) {return;}
            handle = clock.requestAnimationFrame(fire);
        },
        dispose: () => {
            disposed = true;
            if (handle !== null) {
                clock.cancelAnimationFrame(handle);
                handle = null;
            }
        },
    };
};
