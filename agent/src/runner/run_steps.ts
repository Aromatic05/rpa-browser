/**
 * runSteps：统一 MCP / play / script 的执行入口。
 *
 * 设计说明：
 * - v0 仅提供统一接口与结构化返回，不做实际执行
 * - 具体执行由后续的 step executors 与 runtime 绑定实现
 * - 所有错误均返回结构化结果（不抛异常）
 */

import type { RunStepsRequest, RunStepsResult } from './steps/types';

export const runSteps = async (_req: RunStepsRequest): Promise<RunStepsResult> => ({
    ok: false,
    results: [
        {
            stepId: 'not-implemented',
            ok: false,
            error: { code: 'ERR_NOT_IMPLEMENTED', message: 'runSteps not implemented' },
        },
    ],
});
