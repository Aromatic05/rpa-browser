import type {InteractionId} from '../interaction/contracts';

/** Opaque transport token for a pending interaction. It never exposes the raw
 *  interaction id or revision to the product surface; the controller decodes it
 *  back into (interactionId, expectedRevision) at the command boundary. */
export const encodeInteractionToken = (interactionId: InteractionId, revision: number): string =>
    Buffer.from(`${interactionId}:${revision}`).toString('base64url');

export const decodeInteractionToken = (
    token: string,
): {interactionId: InteractionId; revision: number} | null => {
    let decoded: string;
    try {
        decoded = Buffer.from(token, 'base64url').toString('utf8');
    } catch {
        return null;
    }
    const separator = decoded.lastIndexOf(':');
    if (separator <= 0) {return null;}
    const interactionId = decoded.slice(0, separator);
    const revision = Number(decoded.slice(separator + 1));
    if (!Number.isInteger(revision) || revision < 0) {return null;}
    if (!interactionId) {return null;}
    return {interactionId, revision};
};