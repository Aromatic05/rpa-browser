import type { CheckpointCtx } from './types';

export const maybeRetryOriginalStep = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => ctx;

export const foldCheckpointResult = (ctx: CheckpointCtx): CheckpointCtx => ctx;
