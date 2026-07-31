import type { Page } from 'playwright';
import { captureControlSnapshot } from '../../control/capture/browser';
import type { BrowserObservationCaptureOptions } from '../../../observation/capture/browser';
import { buildFormSnapshot } from '../assembly/build';
import type { FormSnapshot } from '../model/contracts';

export const captureFormSnapshot = async (
    page: Page,
    options: BrowserObservationCaptureOptions & { selectionScopeNodeId?: string } = {},
): Promise<FormSnapshot> => {
    const controlSnapshot = await captureControlSnapshot(page, options);
    return buildFormSnapshot({
        observation: controlSnapshot.observation,
        relations: controlSnapshot.relations,
        locators: controlSnapshot.locators,
        controls: controlSnapshot.controls,
        selectionScopeNodeId: options.selectionScopeNodeId,
    });
};
