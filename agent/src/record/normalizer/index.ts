import type { RecorderEvent } from '../capture/recorder';
import type { NormalizeContext, RecordNormalizerResult } from './types';
import { normalizeSelectOption } from './select_option';

export type { NormalizeContext, RecordNormalizerResult } from './types';

export const normalizeRecorderEvent = async (
    context: NormalizeContext,
    event: RecorderEvent,
): Promise<RecordNormalizerResult> => {
    const selectOptionResult = await normalizeSelectOption(context, event);
    if (selectOptionResult.status !== 'pass') {
        return selectOptionResult;
    }
    return { status: 'pass' };
};
