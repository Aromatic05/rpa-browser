import { performance } from 'node:perf_hooks';
import type {
    ObservationPassCounter,
    PageObservation,
} from '../model/contracts';
import type {
    ObservationPassMetrics,
    PageObservationAnalysis,
} from './contracts';
import { deepFreeze } from '../model/freeze';
import { buildRelationIndex } from '../../indexes/relation/build';
import { diagnoseActivityConsistency } from './activity';
import { classifyCandidates } from './candidates';
import { buildCandidateQuotientViews } from './quotient';
import { buildObservationReport } from './report';
import { validateObservationAnalysis } from './validator';

export const analyzePageObservation = (
    observation: PageObservation,
): PageObservationAnalysis => {
    const passes: Record<string, ObservationPassMetrics> = {};
    const relations = measurePass(passes, 'relation', (counter) =>
        buildRelationIndex(observation, counter));
    const candidates = measurePass(passes, 'candidate', (counter) =>
        classifyCandidates(observation, counter));
    const quotients = measurePass(passes, 'quotient', (counter) =>
        buildCandidateQuotientViews(observation, relations, candidates, counter));
    const activityDiagnostics = measurePass(passes, 'activity-consistency', (counter) =>
        diagnoseActivityConsistency(observation, relations, counter));
    const validation = measurePass(passes, 'invariant', (counter) =>
        validateObservationAnalysis({ observation, relations, candidates, quotients }, counter));

    const diagnostics = [
        ...observation.diagnostics,
        ...relations.diagnostics,
        ...activityDiagnostics,
        ...validation.diagnostics,
    ];
    const report = buildObservationReport({
        observation,
        relations,
        candidates,
        quotients,
        diagnostics,
        passes,
    });
    return deepFreeze({
        observation,
        relations,
        candidates,
        quotients,
        diagnostics,
        validation,
        report,
    });
};

const measurePass = <T>(
    passes: Record<string, ObservationPassMetrics>,
    name: string,
    run: (counter: ObservationPassCounter) => T,
): T => {
    const counter: ObservationPassCounter = { nodeVisits: 0, edgeVisits: 0 };
    const startedAt = performance.now();
    const value = run(counter);
    passes[name] = {
        nodeVisits: counter.nodeVisits,
        edgeVisits: counter.edgeVisits,
        durationMs: performance.now() - startedAt,
    };
    return value;
};
