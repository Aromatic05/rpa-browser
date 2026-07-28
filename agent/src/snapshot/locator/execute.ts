import type { FrameLocator, Locator, Page } from 'playwright';
import type { Evidence, PageObservation } from '../observation/contracts';
import type { ExecutableLocatorResolution, LocatorIndex } from './contracts';

type LocatorContext = Page | FrameLocator | Locator;

export const resolveExecutableLocator = async (
    page: Page,
    observation: PageObservation,
    index: LocatorIndex,
    locatorId: string,
): Promise<ExecutableLocatorResolution> => {
    const canonical = index.locators[locatorId];
    if (!canonical) {
        return unresolved('locator is not present in the canonical index', locatorEvidence('locator.execution.missing', []));
    }
    if (canonical.identity.pageEpoch !== observation.identity.pageEpoch
        || canonical.identity.captureRevision !== observation.identity.captureRevision) {
        return {
            status: 'stale',
            message: 'locator belongs to a different observation revision',
            evidence: [locatorEvidence('locator.execution.identity-stale', [canonical.targetNodeId])],
        };
    }
    if (canonical.status === 'ambiguous') {
        return {
            status: 'ambiguous',
            message: 'canonical locator is ambiguous',
            evidence: [...canonical.evidence],
        };
    }
    if (canonical.status !== 'resolved' || !canonical.selector) {
        return unresolved('canonical locator is unresolved', ...canonical.evidence);
    }

    let context: LocatorContext = page;
    for (const step of canonical.scopePath) {
        const hostLocatorId = index.byNodeId[step.hostNodeId]?.[0];
        const hostCanonical = hostLocatorId ? index.locators[hostLocatorId] : undefined;
        if (!hostCanonical || hostCanonical.status !== 'resolved' || !hostCanonical.selector) {
            return unresolved('scope host has no executable locator', locatorEvidence(
                'locator.execution.scope-host-unresolved',
                [canonical.targetNodeId, step.hostNodeId],
            ));
        }
        const host = context.locator(hostCanonical.selector);
        const hostCount = await host.count();
        if (hostCount === 0) {
            return {
                status: 'stale',
                message: 'scope host no longer exists',
                evidence: [locatorEvidence('locator.execution.scope-host-stale', [step.hostNodeId])],
            };
        }
        if (hostCount > 1) {
            return {
                status: 'ambiguous',
                message: 'scope host locator matched multiple nodes',
                count: hostCount,
                evidence: [locatorEvidence('locator.execution.scope-host-ambiguous', [step.hostNodeId])],
            };
        }
        context = step.kind === 'frame' ? host.contentFrame() : host;
    }

    const locator = context.locator(canonical.selector);
    const count = await locator.count();
    if (count === 0) {
        return {
            status: 'stale',
            message: 'canonical locator no longer matches a node',
            evidence: [locatorEvidence('locator.execution.target-stale', [canonical.targetNodeId])],
        };
    }
    if (count > 1) {
        return {
            status: 'ambiguous',
            message: 'canonical locator matched multiple nodes',
            count,
            evidence: [locatorEvidence('locator.execution.target-ambiguous', [canonical.targetNodeId])],
        };
    }
    return {
        status: 'resolved',
        locator,
        evidence: [...canonical.evidence, locatorEvidence('locator.execution.resolved', [canonical.targetNodeId])],
    };
};

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
