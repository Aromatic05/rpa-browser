import type { Page } from 'playwright';
import { captureAndAnalyzePageObservation, capturePageObservation, type BrowserObservationCaptureOptions } from '../../../observation/capture/browser';
import { buildLocatorIndex } from '../../../indexes/locator/build';
import { buildControlSnapshot } from '../assembly/build';
import type { ControlSnapshot } from '../model/contracts';

export const captureControlSnapshot = async (
    page: Page,
    options: BrowserObservationCaptureOptions = {},
): Promise<ControlSnapshot> => {
    const analysis = await captureAndAnalyzePageObservation(page, {
        ...options,
        captureRuntimeState: options.captureRuntimeState ?? true,
    });
    const locators = buildLocatorIndex(analysis.observation);
    return buildControlSnapshot({
        observation: analysis.observation,
        relations: analysis.relations,
        locators,
    });
};


export const captureLocatorExecutionSnapshot = async (page: Page) => {
    const observation = await capturePageObservation(page);
    return { observation, index: buildLocatorIndex(observation) };
};
