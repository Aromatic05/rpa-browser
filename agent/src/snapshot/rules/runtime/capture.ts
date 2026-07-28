import type { Page } from 'playwright';
import type { BrowserObservationCaptureOptions } from '../../observation/capture/browser';
import type { ObservationNodeId } from '../../observation/model/contracts';
import { captureControlSnapshot } from '../../components/control/capture/browser';
import type { ControlSnapshot } from '../../components/control/model/contracts';
import { buildFormSnapshot } from '../../components/form/assembly/build';
import { buildTableSnapshot } from '../../components/table/assembly/build';
import {
    executeEntityRules,
    type EntityRuleComponentSnapshots,
    type EntityRulesExecutionResult,
    type ExecuteEntityRulesInput,
} from './matcher';
import { resolveStepEntityRulesExecution } from './step_control';

export const buildEntityRuleComponentSnapshots = (
    controlSnapshot: ControlSnapshot,
    selectionScopeNodeId?: ObservationNodeId,
): Required<EntityRuleComponentSnapshots> => ({
    form: buildFormSnapshot({
        observation: controlSnapshot.observation,
        relations: controlSnapshot.relations,
        locators: controlSnapshot.locators,
        controls: controlSnapshot.controls,
        selectionScopeNodeId,
    }),
    table: buildTableSnapshot({
        observation: controlSnapshot.observation,
        relations: controlSnapshot.relations,
        locators: controlSnapshot.locators,
        controls: controlSnapshot.controls,
        selectionScopeNodeId,
    }),
});

export const captureEntityRuleComponentSnapshots = async (
    page: Page,
    options: BrowserObservationCaptureOptions & { selectionScopeNodeId?: string } = {},
): Promise<Required<EntityRuleComponentSnapshots>> => {
    const controlSnapshot = await captureControlSnapshot(page, options);
    return buildEntityRuleComponentSnapshots(controlSnapshot, options.selectionScopeNodeId);
};


export type ExecuteEntityRulesOnPageInput = Omit<ExecuteEntityRulesInput, 'snapshots'> & {
    captureOptions?: BrowserObservationCaptureOptions & { selectionScopeNodeId?: ObservationNodeId };
};

export const executeEntityRulesOnPage = async (
    page: Page,
    input: ExecuteEntityRulesOnPageInput,
): Promise<EntityRulesExecutionResult> => {
    const resolution = resolveStepEntityRulesExecution(input.control, input.config, input.provider);
    if (resolution.status !== 'ready' || resolution.profiles.length === 0) {
        return executeEntityRules({
            control: input.control,
            config: input.config,
            provider: input.provider,
            snapshots: {},
        });
    }
    return executeEntityRules({
        control: input.control,
        config: input.config,
        provider: input.provider,
        snapshots: await captureEntityRuleComponentSnapshots(page, input.captureOptions),
    });
};
