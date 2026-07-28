import type { Page } from 'playwright';
import { captureAndAnalyzePageObservation, type BrowserObservationCaptureOptions } from '../capture/browser';
import { buildLocatorIndex } from '../locator/build';
import { buildControlSnapshot } from './build';
import type { ControlSnapshot } from './contracts';

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
