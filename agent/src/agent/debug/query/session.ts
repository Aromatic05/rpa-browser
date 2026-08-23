import {evaluateComputeExpression, type ComputeEvalScope} from '../../../compute/evaluate';
import {executePageSessionQueryIR} from '../../../runner/session/query_ir';
import type {ComputeExpr} from '../../../compute/types';
import type {QueryIR} from '../../../query/contracts';
import {describeWorldView} from '../../worldview/descriptor';
import type {WorldView} from '../../worldview/contracts';
import type {DebugQuerySession} from './contracts';

export const createDebugQuerySession = (view: WorldView): DebugQuerySession => {
    const world = describeWorldView(view);
    return Object.freeze({
        world,
        query: (ir: QueryIR) => {
            const result = executePageSessionQueryIR(view.entry, ir);
            return result.ok
                ? {ok: true as const, world, result: result.data}
                : {ok: false as const, world, error: result.error};
        },
        compute: (expr: ComputeExpr, scope: ComputeEvalScope = {}) => {
            try {
                return {
                    ok: true as const,
                    world,
                    value: evaluateComputeExpression(expr, scope),
                };
            } catch (error) {
                return {
                    ok: false as const,
                    world,
                    error: {
                        code: 'ERR_BAD_ARGS' as const,
                        message: error instanceof Error ? error.message : 'invalid compute expression',
                    },
                };
            }
        },
    });
};
