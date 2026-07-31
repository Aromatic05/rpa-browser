import type { Page } from 'playwright';
import { captureControlSnapshot } from '../../control/capture/browser';
import type { BrowserObservationCaptureOptions } from '../../../observation/capture/browser';
import { buildTableSnapshot } from '../assembly/build';
import type { TableSnapshot } from '../model/contracts';

export const captureTableSnapshot = async (
    page: Page,
    options: BrowserObservationCaptureOptions & { selectionScopeNodeId?: string } = {},
): Promise<TableSnapshot> => {
    const controlSnapshot = await captureControlSnapshot(page, options);
    return buildTableSnapshot({
        observation: controlSnapshot.observation,
        relations: controlSnapshot.relations,
        locators: controlSnapshot.locators,
        controls: controlSnapshot.controls,
        selectionScopeNodeId: options.selectionScopeNodeId,
    });
};
