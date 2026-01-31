/**
 * Trace Hooks：在 op 生命周期提供钩子点。
 *
 * 注意：
 * - 当前默认 no-op，不做权限/脱敏处理
 * - 后续可在此层做观测/告警/审计
 */

import type { TraceHooks } from './types';

export const createNoopHooks = (): TraceHooks => ({
    beforeOp: async () => {},
    afterOp: async () => {},
    onError: async () => {},
});
