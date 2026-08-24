import type {ComputeEvalScope} from '../../../program/compute/evaluate';
import type {QueryIRExecutionError} from '../../../runner/session/query_ir';
import type {BrowserQueryResult} from '../../../runner/steps/types';
import type {ComputeExpr} from '../../../program/compute/types';
import type {QueryIR} from '../../../program/query/contracts';
import type {WorldViewDescriptor} from '../../worldview/contracts';

export type DebugQueryReadResult =
    | {ok: true; world: WorldViewDescriptor; result: BrowserQueryResult}
    | {ok: false; world: WorldViewDescriptor; error: QueryIRExecutionError};

export type DebugComputeResult =
    | {ok: true; world: WorldViewDescriptor; value: unknown}
    | {
        ok: false;
        world: WorldViewDescriptor;
        error: {code: 'ERR_BAD_ARGS'; message: string};
    };

export type DebugQuerySession = {
    readonly world: WorldViewDescriptor;
    query: (ir: QueryIR) => DebugQueryReadResult;
    compute: (expr: ComputeExpr, scope?: ComputeEvalScope) => DebugComputeResult;
};
