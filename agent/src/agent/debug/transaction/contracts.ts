import type {WorldView, WorldViewDescriptor} from '../../worldview/contracts';

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

export type DebugTransaction = {
    readonly id: string;
    readonly baseline: WorldView;
    savepoint: (world: WorldView, effectSequence: number, name?: string) => DebugSavepoint;
    snapshot: (current: WorldView, effectCount: number) => DebugTransactionSnapshot;
};
