import type {WorldView, WorldViewDescriptor} from '../../worldview/contracts';
import type {WorldViewDiffResult} from '../../worldview/diff';
import type {DebugEffectRecord} from '../effects/contracts';
import type {DebugEffectSemanticRisk, DebugPhysicalCompensationPlan} from './compensation/contracts';

export type DebugSavepoint = Readonly<{
    id: string;
    name?: string;
    effectSequence: number;
    world: WorldViewDescriptor;
}>;

export type DebugTransactionSnapshot = Readonly<{
    id: string;
    baseline: WorldViewDescriptor;
    current: WorldViewDescriptor;
    effectCount: number;
    savepoints: readonly DebugSavepoint[];
}>;

export type DebugTransactionState = Readonly<{
    id: string;
    baseline: WorldView;
    savepoints: readonly Readonly<{
        savepoint: DebugSavepoint;
        world: WorldView;
        visible: boolean;
    }>[];
}>;

export type DebugTransaction = {
    readonly id: string;
    readonly baseline: WorldView;
    savepoint: (world: WorldView, effectSequence: number, name?: string) => DebugSavepoint;
    internalSavepoint: (world: WorldView, effectSequence: number) => DebugSavepoint;
    promoteSavepoint: (id: string, name?: string) => DebugSavepoint;
    readSavepoint: (id: string) => Readonly<{savepoint: DebugSavepoint; world: WorldView}> | null;
    truncateSavepoints: (id: string) => void;
    snapshot: (current: WorldView, effectCount: number) => DebugTransactionSnapshot;
    exportState: () => DebugTransactionState;
};

export type DebugRollbackResult =
    | Readonly<{
        status: 'restored';
        mode: 'noop';
        savepoint: DebugSavepoint;
        world: WorldViewDescriptor;
    }>
    | Readonly<{
        status: 'restored';
        mode: 'physical_verified';
        semanticRisk: 'reversible';
        savepoint: DebugSavepoint;
        compensations: readonly DebugEffectRecord[];
        world: WorldViewDescriptor;
        residualDiff: WorldViewDiffResult;
    }>
    | Readonly<{
        status: 'blocked';
        reason:
            | 'effects_require_compensation'
            | 'world_drift'
            | 'compensation_executor_unavailable'
            | 'compensation_unavailable';
        savepoint: DebugSavepoint;
        world: WorldViewDescriptor;
        effects: readonly DebugEffectRecord[];
        diff: WorldViewDiffResult;
        plans?: readonly DebugPhysicalCompensationPlan[];
    }>
    | Readonly<{
        status: 'compensated';
        mode: 'physical';
        semanticRisk: DebugEffectSemanticRisk;
        savepoint: DebugSavepoint;
        compensations: readonly DebugEffectRecord[];
        world: WorldViewDescriptor;
        residualDiff: WorldViewDiffResult;
    }>
    | Readonly<{
        status: 'partial';
        mode: 'physical';
        semanticRisk: DebugEffectSemanticRisk;
        savepoint: DebugSavepoint;
        compensations: readonly DebugEffectRecord[];
        failure: Readonly<{code: string; message: string; details?: unknown}>;
        world: WorldViewDescriptor;
        residualDiff: WorldViewDiffResult;
    }>
    | Readonly<{
        status: 'conflict';
        conflict: Readonly<{
            expected: WorldViewDescriptor;
            actual: WorldViewDescriptor;
        }>;
    }>
    | Readonly<{
        status: 'not_found';
        error: Readonly<{
            code: 'ERR_NOT_FOUND';
            message: string;
        }>;
    }>;

export type DebugRollbackOptions = Readonly<{
    strategy?: 'none' | 'physical';
}>;
