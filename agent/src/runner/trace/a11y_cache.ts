import type { TraceCache, TraceTags } from './types';
import { getLogger } from '../../logging/logger';

const log = getLogger('trace');

export const invalidateA11yCache = (cache: TraceCache, reason: string, tags?: TraceTags) => {
    delete cache.a11ySnapshotRaw;
    delete cache.a11yNodeMap;
    delete cache.a11yTree;
    delete cache.lastSnapshotId;
    cache.a11yCacheGen = (cache.a11yCacheGen ?? 0) + 1;

    log('[trace] a11y cache invalidated', {
        reason,
        tags,
        gen: cache.a11yCacheGen,
    });
};
