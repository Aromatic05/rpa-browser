import {createDslDebugExecutionSession, type CreateDslDebugExecutionSessionOptions} from '../debug/execution/dsl_session';
import type {WorldViewSource} from '../worldview/contracts';
import {describeWorldView} from '../worldview/descriptor';
import {isSameWorldView} from '../worldview/revision';
import {
    type ProgramExecutionImage,
    type ProgramExecutionImageExportResult,
    type ProgramExecutionRehydrateResult,
} from './contracts';
import {parseProgramExecutionImage, jsonRoundTripProgramExecutionImage} from './image';

export * from './contracts';
export * from './image';

export const exportProgramExecutionImage = (
    session: {exportProgramExecutionImage: () => ProgramExecutionImageExportResult},
): ProgramExecutionImageExportResult => session.exportProgramExecutionImage();

export const rehydrateProgramExecutionImage = async (
    input: unknown,
    options: Omit<CreateDslDebugExecutionSessionOptions, 'source' | 'debug' | 'restore'> & {
        worldViewSource: WorldViewSource;
        debug?: CreateDslDebugExecutionSessionOptions['debug'];
    },
): Promise<ProgramExecutionRehydrateResult> => {
    const parsed = parseProgramExecutionImage(input);
    if (!parsed.ok) {return parsed;}
    const roundTrip = jsonRoundTripProgramExecutionImage(parsed.image);
    if (!roundTrip.ok) {return roundTrip;}
    const liveView = await options.worldViewSource.pin();
    const expected = describeWorldView(roundTrip.image.active.view);
    const actual = describeWorldView(liveView);
    if (!isSameWorldView(expected, actual)) {
        return {
            ok: false,
            error: {
                code: 'ERR_CONTINUATION_WORLD_CONFLICT',
                message: 'live WorldView does not match the persisted continuation pause',
                details: {expected, actual},
            },
        };
    }
    const session = createDslDebugExecutionSession({
        ...options,
        source: roundTrip.image.mainSource,
        debug: options.debug ?? roundTrip.image.debug,
        restore: {image: roundTrip.image, liveView},
    });
    const pause = await session.waitForPause();
    if (pause.reason !== 'barrier') {
        return {
            ok: false,
            error: {code: 'ERR_CONTINUATION_INVALID', message: 'rehydrated image did not expose a barrier'},
        };
    }
    return {ok: true, session, pause};
};
