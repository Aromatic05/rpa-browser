export type CreateAnnotatorLiveGeometryRefreshInput = {
    eventTargets: readonly EventTarget[];
    isActive: () => boolean;
    refresh: () => void | Promise<void>;
};

export type AnnotatorLiveGeometryRefresh = {
    dispose: () => void;
};

export const createAnnotatorLiveGeometryRefresh = (
    input: CreateAnnotatorLiveGeometryRefreshInput,
): AnnotatorLiveGeometryRefresh => {
    let disposed = false;
    let pending = false;
    let refreshing = false;

    const schedule = (): void => {
        if (disposed || pending || refreshing || !input.isActive()) {return;}
        pending = true;
        queueMicrotask(() => {
            pending = false;
            if (disposed || refreshing || !input.isActive()) {return;}
            refreshing = true;
            void Promise.resolve(input.refresh())
                .catch(() => undefined)
                .finally(() => {
                    refreshing = false;
                });
        });
    };

    for (const target of input.eventTargets) {
        target.addEventListener('scroll', schedule, {capture: true, passive: true});
        target.addEventListener('resize', schedule, {passive: true});
    }

    return {
        dispose: (): void => {
            disposed = true;
            for (const target of input.eventTargets) {
                target.removeEventListener('scroll', schedule, {capture: true});
                target.removeEventListener('resize', schedule);
            }
        },
    };
};
