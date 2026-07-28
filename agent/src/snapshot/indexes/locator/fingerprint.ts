import type { Locator } from 'playwright';
import type { ObservationNodeId, PageObservation } from '../../observation/model/contracts';

const ATTRIBUTE_NAMES = [
    'id', 'data-testid', 'name', 'type', 'role', 'href', 'value', 'aria-label', 'title', 'placeholder',
] as const;

export const observationLocatorFingerprint = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
): string => JSON.stringify({
    tag: observation.nodes[nodeId]?.tag ?? '',
    attributes: ATTRIBUTE_NAMES.map((name) => observation.attributes[nodeId]?.[name] ?? ''),
    text: normalizeText(observation.text[nodeId]),
});

export const liveLocatorFingerprint = async (locator: Locator): Promise<string> => locator.evaluate((node, names) => {
    if (!(node instanceof Element)) {return '';}
    const text = Array.from(node.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    return JSON.stringify({
        tag: node.tagName.toLowerCase(),
        attributes: names.map((name) => node.getAttribute(name) ?? ''),
        text,
    });
}, [...ATTRIBUTE_NAMES]);

const normalizeText = (value: string | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
