import { analyzePageObservation } from '../analysis/build';
import { buildPageObservation } from '../model/build';
import type { PageObservationAnalysis } from '../analysis/contracts';
import type { ObservationFixture } from './contracts';

export const replayObservationFixture = (
    fixture: ObservationFixture,
): PageObservationAnalysis => analyzePageObservation(buildPageObservation(fixture.capture));
