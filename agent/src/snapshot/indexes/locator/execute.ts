import type { FrameLocator, Locator, Page } from 'playwright';
import type { Evidence, PageObservation } from '../../observation/model/contracts';
import { createObservationAnchor, resolveObservationAnchor } from '../../observation/model/anchor';
import type { CanonicalLocator, ExecutableLocatorResolution, LocatorExecutionOptions, LocatorIndex } from './contracts';
import { liveLocatorFingerprint } from './fingerprint';

type LocatorContext = Page | FrameLocator | Locator;

export const resolveExecutableLocator = async (
    page: Page,
    observation: PageObservation,
    index: LocatorIndex,
    locatorId: string,
    options: LocatorExecutionOptions = {},
): Promise<ExecutableLocatorResolution> => {
    const canonical = index.locators[locatorId];
    if (!canonical) {
        return unresolved('locator is not present in the canonical index', locatorEvidence('locator.execution.missing', []));
    }
    if (canonical.identity.pageEpoch !== observation.identity.pageEpoch
        || canonical.identity.captureRevision !== observation.identity.captureRevision) {
        return stale('locator belongs to a different observation revision', 'locator.execution.identity-stale', canonical.targetNodeId);
    }

    const anchor = createObservationAnchor(observation, canonical.targetNodeId);
    if ((anchor?.backendNodeId || anchor?.runtimeIdentityToken) && options.refresh) {
        const refreshed = await options.refresh();
        const freshObservation = refreshed.observation;
        const remap = resolveObservationAnchor(anchor, freshObservation);
        if (remap.status === 'stale') {
            return stale('canonical node identity no longer exists', 'locator.execution.target-identity-stale', canonical.targetNodeId);
        }
        if (remap.status === 'ambiguous') {
            return {
                status: 'ambiguous',
                message: 'canonical node identity resolved to multiple nodes',
                count: remap.candidateNodeIds.length,
                evidence: [...remap.evidence],
            };
        }
        const freshIndex = refreshed.index;
        const freshLocatorId = freshIndex.byNodeId[remap.nodeId]?.[0];
        if (!freshLocatorId) {
            return unresolved(
                'remapped canonical node has no executable locator',
                locatorEvidence('locator.execution.remap-unresolved', [remap.nodeId]),
            );
        }
        const result = await resolveCurrentLocator(page, freshObservation, freshIndex, freshLocatorId);
        return result.status === 'resolved'
            ? { ...result, evidence: [...remap.evidence, ...result.evidence] }
            : result;
    }

    return await resolveCurrentLocator(page, observation, index, locatorId);
};

const resolveCurrentLocator = async (
    page: Page,
    observation: PageObservation,
    index: LocatorIndex,
    locatorId: string,
): Promise<ExecutableLocatorResolution> => {
    const canonical = index.locators[locatorId];
    if (!canonical) {
        return unresolved('locator is not present in the canonical index', locatorEvidence('locator.execution.missing', []));
    }
    if (canonical.status === 'ambiguous') {
        return { status: 'ambiguous', message: 'canonical locator is ambiguous', evidence: [...canonical.evidence] };
    }
    if (canonical.status !== 'resolved' || !canonical.selector) {
        return unresolved('canonical locator is unresolved', ...canonical.evidence);
    }

    let context: LocatorContext = page;
    for (const step of canonical.scopePath) {
        const hostLocatorId = index.byNodeId[step.hostNodeId]?.[0];
        const hostCanonical = hostLocatorId ? index.locators[hostLocatorId] : undefined;
        if (hostCanonical?.status !== 'resolved' || !hostCanonical.selector) {
            return unresolved('scope host has no executable locator', locatorEvidence(
                'locator.execution.scope-host-unresolved',
                [canonical.targetNodeId, step.hostNodeId],
            ));
        }
        const host = context.locator(hostCanonical.selector);
        const hostResult = await uniqueLiveLocator(host, hostCanonical, true);
        if (hostResult) {return hostResult;}
        context = step.kind === 'frame' ? host.contentFrame() : host;
    }

    const locator = context.locator(canonical.selector);
    const targetResult = await uniqueLiveLocator(locator, canonical, false);
    if (targetResult) {return targetResult;}
    return {
        status: 'resolved',
        locator,
        evidence: [...canonical.evidence, locatorEvidence('locator.execution.resolved', [canonical.targetNodeId])],
    };
};

const uniqueLiveLocator = async (
    locator: Locator,
    canonical: CanonicalLocator,
    scopeHost: boolean,
): Promise<Exclude<ExecutableLocatorResolution, { status: 'resolved' }> | undefined> => {
    const count = await locator.count();
    const prefix = scopeHost ? 'scope-host' : 'target';
    if (count === 0) {
        return stale(
            scopeHost ? 'scope host no longer exists' : 'canonical locator no longer matches a node',
            `locator.execution.${prefix}-stale`,
            canonical.targetNodeId,
        );
    }
    if (count > 1) {
        return {
            status: 'ambiguous',
            message: scopeHost ? 'scope host locator matched multiple nodes' : 'canonical locator matched multiple nodes',
            count,
            evidence: [locatorEvidence(`locator.execution.${prefix}-ambiguous`, [canonical.targetNodeId])],
        };
    }
    if (canonical.fingerprint && await liveLocatorFingerprint(locator) !== canonical.fingerprint) {
        return stale(
            scopeHost ? 'scope host canonical identity changed' : 'canonical locator matched a different node identity',
            `locator.execution.${prefix}-identity-stale`,
            canonical.targetNodeId,
        );
    }
    return undefined;
};

const stale = (
    message: string,
    code: string,
    nodeId: string,
): Extract<ExecutableLocatorResolution, { status: 'stale' }> => ({
    status: 'stale',
    message,
    evidence: [locatorEvidence(code, [nodeId])],
});

const unresolved = (message: string, ...evidence: Evidence[]): ExecutableLocatorResolution => ({
    status: 'unresolved',
    message,
    evidence,
});

const locatorEvidence = (code: string, nodeIds: string[]): Evidence => ({
    code,
    strength: 'exact',
    source: 'platform',
    nodeIds,
});
