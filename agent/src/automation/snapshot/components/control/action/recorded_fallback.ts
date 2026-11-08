import type {Locator, Page} from 'playwright';
import type {ControlSnapshot} from '../model/contracts';
import {captureLocatorTarget} from './selector_capture';

export type RecordedTargetCandidate = {kind: string; locator: Locator};
export type RecordedTargetOptions = {
    getReplayCandidates?: () => readonly RecordedTargetCandidate[];
};

type RecordedFallback =
    | {ok: true; snapshot: ControlSnapshot; nodeId: string; details: Record<string, unknown>}
    | {
        ok: false;
        code: 'ERR_NOT_FOUND' | 'ERR_STALE' | 'ERR_AMBIGUOUS' | 'ERR_UNRESOLVED';
        message: string;
        details: Record<string, unknown>;
    };

export const captureRecordedFallback = async (
    page: Page,
    options: RecordedTargetOptions,
    primary: {code: string; message: string; details?: Record<string, unknown>},
): Promise<RecordedFallback | undefined> => {
    if (primary.code !== 'ERR_NOT_FOUND' && primary.code !== 'ERR_STALE') {return undefined;}
    const candidates = options.getReplayCandidates?.();
    if (!candidates?.length) {return undefined;}
    const details = {
        resolution: 'recorded-target-fallback',
        primaryCode: primary.code,
        candidateKinds: [...new Set(candidates.map((candidate) => candidate.kind))],
    };
    // The union deduplicates matching elements and rejects disagreements.
    const locator = candidates.slice(1)
        .reduce((combined, candidate) => combined.or(candidate.locator), candidates[0].locator);
    const captured = await captureLocatorTarget(page, locator, details, true);
    if (!captured.ok) {
        if (captured.code === 'ERR_AMBIGUOUS') {
            return {
                ok: false, code: captured.code,
                message: 'recorded fallback candidates matched multiple elements',
                details: {...captured.details, ...details},
            };
        }
        return {
            ok: false, code: primary.code, message: primary.message,
            details: {...primary.details, ...details, fallbackCode: captured.code, fallbackReason: captured.message},
        };
    }
    const observation = captured.snapshot.observation;
    const scopeId = observation.nodes[captured.nodeId].scopeId;
    if (!observation.scopes.rootScopeIds.includes(scopeId) || observation.scopes.scopes[scopeId].kind !== 'document') {
        return {ok: false, code: 'ERR_UNRESOLVED', message: 'recorded fallback target is outside the main document', details};
    }
    return {...captured, details};
};
