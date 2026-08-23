import type {ComputeEvalScope} from '../../../compute/evaluate';
import type {PageSessionQueryError} from '../../../runner/session/query';
import type {BrowserQueryResult, StepArgsMap} from '../../../runner/steps/types';
import type {ComputeExpr} from '../../../compute/types';
import type {WorldViewDescriptor} from '../../worldview/contracts';

export type DebugQueryReadResult =
    | {ok: true; world: WorldViewDescriptor; result: BrowserQueryResult}
    | {ok: false; world: WorldViewDescriptor; error: PageSessionQueryError};

export type DebugComputeResult =
    | {ok: true; world: WorldViewDescriptor; value: unknown}
    | {
        ok: false;
        world: WorldViewDescriptor;
        error: {code: 'ERR_BAD_ARGS'; message: string};
    };

export type DebugQuerySession = {
    readonly world: WorldViewDescriptor;
    query: (args: StepArgsMap['browser.query']) => DebugQueryReadResult;
    compute: (expr: ComputeExpr, scope?: ComputeEvalScope) => DebugComputeResult;
};
