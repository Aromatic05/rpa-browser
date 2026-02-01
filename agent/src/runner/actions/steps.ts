/**
 * steps action：将 Step 列表交给 runSteps 执行。
 *
 * 说明：
 * - 这是 extension 侧录制回放的统一入口
 * - 若步骤非法，返回结构化错误
 */

import type { ActionHandler } from '../execute';
import { runSteps } from '../run_steps';
import type { StepUnion } from '../steps/types';
import { errorResult } from '../results';
import { ERROR_CODES } from '../error_codes';

export const stepsHandlers: Record<string, ActionHandler> = {
    'steps.run': async (ctx, command) => {
        const args = command.args as { steps?: StepUnion[]; stopOnError?: boolean } | undefined;
        if (!args?.steps || !Array.isArray(args.steps)) {
            return errorResult(ctx.tabToken, ERROR_CODES.ERR_BAD_ARGS, 'missing steps');
        }
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        const result = await runSteps({
            workspaceId: scope.workspaceId,
            steps: args.steps,
            options: { stopOnError: args.stopOnError ?? true },
        });
        if (!result.ok) {
            return errorResult(ctx.tabToken, ERROR_CODES.ERR_ASSERTION_FAILED, 'steps failed', undefined, result.results);
        }
        return { ok: true, tabToken: ctx.tabToken, data: result.results };
    },
};
