import type { Checkpoint, CheckpointCtx, MatchRule } from './types';

let checkpointStore: Checkpoint[] = [];

export const setCheckpoints = (checkpoints: Checkpoint[]) => {
    checkpointStore = [...checkpoints];
};

export const listCheckpoints = (injected?: Checkpoint[]) => (injected ? [...injected] : [...checkpointStore]);

export const maybeEnterCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => ctx;

export const maybePickCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => ctx;

export const evalMatchRule = async (_rule: MatchRule, _ctx: CheckpointCtx): Promise<boolean> => true;
