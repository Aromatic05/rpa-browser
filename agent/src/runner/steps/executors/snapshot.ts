import type {RunStepsDeps} from '../../run_steps_types';
import type {Step, StepResult} from '../types';
import {ensureFreshPageSession} from '../../session/capture';
import {
    buildSnapshotProjection,
    buildSnapshotProjectionBaselineKey,
    diffSnapshotProjection,
    fullSnapshotProjectionWithoutBaseline,
} from '../../../snapshot/projection';

export const executeBrowserSnapshot = async (
    step: Step<'browser.snapshot'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    const depth = step.args.depth ?? -1;
    if (!Number.isInteger(depth) || depth < -1) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: 'browser.snapshot depth must be an integer greater than or equal to -1',
            },
        };
    }

    const {entry, binding} = await ensureFreshPageSession(deps, workspaceName, {
        explicit: step.args.refresh === true,
    });
    const built = buildSnapshotProjection(entry, {
        mode: step.args.mode,
        contain: step.args.contain,
        depth,
        filter: step.args.filter,
    });
    if (!built.ok) {
        return {stepId: step.id, ok: false, error: built.error};
    }

    const fullProjection = built.projection;
    const baselineKey = buildSnapshotProjectionBaselineKey(fullProjection);
    const baseline = deps.snapshotProjection.read(binding.page, baselineKey);
    const output = step.args.diff
        ? baseline
            ? diffSnapshotProjection(fullProjection, baseline.projection)
            : fullSnapshotProjectionWithoutBaseline(fullProjection)
        : {mode: 'full' as const, projection: fullProjection};

    deps.snapshotProjection.write(binding.page, {
        key: baselineKey,
        projection: fullProjection,
        createdAt: Date.now(),
    });

    return {
        stepId: step.id,
        ok: true,
        data: output.projection,
    };
};
