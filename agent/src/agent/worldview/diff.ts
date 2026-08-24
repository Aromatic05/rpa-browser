import {
    buildSnapshotProjection,
    diffSnapshotProjection,
    type SnapshotProjectionDiffResult,
} from '../../automation/snapshot/projection';
import type {WorldView, WorldViewDescriptor} from './contracts';
import {describeWorldView} from './descriptor';

export type WorldViewDiffResult =
    | Readonly<{
        ok: true;
        worldBefore: WorldViewDescriptor;
        worldAfter: WorldViewDescriptor;
        diff: SnapshotProjectionDiffResult;
    }>
    | Readonly<{
        ok: false;
        error: Readonly<{
            code: 'ERR_WORLD_DIFF';
            message: string;
            details?: unknown;
        }>;
    }>;

export const diffWorldViews = (before: WorldView, after: WorldView): WorldViewDiffResult => {
    const baseline = buildSnapshotProjection(before.entry);
    if (!baseline.ok) {
        return {
            ok: false,
            error: {
                code: 'ERR_WORLD_DIFF',
                message: baseline.error.message,
                ...(baseline.error.details === undefined ? {} : {details: baseline.error.details}),
            },
        };
    }
    const current = buildSnapshotProjection(after.entry);
    if (!current.ok) {
        return {
            ok: false,
            error: {
                code: 'ERR_WORLD_DIFF',
                message: current.error.message,
                ...(current.error.details === undefined ? {} : {details: current.error.details}),
            },
        };
    }
    return Object.freeze({
        ok: true as const,
        worldBefore: describeWorldView(before),
        worldAfter: describeWorldView(after),
        diff: diffSnapshotProjection(current.projection, baseline.projection),
    });
};
