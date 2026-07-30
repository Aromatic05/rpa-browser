import type {PickCandidate, PickPurpose} from '../types.js';

const hasPersistentTarget = (candidate: PickCandidate): boolean =>
    Boolean(candidate.proposedTargets?.some((target) => Object.keys(target).length > 0));

export const isConfirmableEntityCandidate = (candidate: PickCandidate): boolean =>
    (candidate.level === 'region' || candidate.level === 'group')
    && Boolean(candidate.entityRef)
    && hasPersistentTarget(candidate);

export const candidatesForPurpose = (
    chain: PickCandidate[],
    purpose: PickPurpose,
): PickCandidate[] => purpose === 'entity'
    ? chain.filter(isConfirmableEntityCandidate)
    : chain;

export const defaultCandidateIndex = (
    chain: PickCandidate[],
    purpose: PickPurpose,
): number => {
    if (chain.length === 0) {return -1;}
    return purpose === 'entity' ? chain.length - 1 : 0;
};

export const selectOuter = (
    chain: PickCandidate[],
    currentIndex: number,
): number => {
    if (chain.length === 0) {return -1;}
    if (currentIndex < 0) {return 0;}
    if (currentIndex >= chain.length - 1) {return currentIndex;}
    return currentIndex + 1;
};

export const selectInner = (
    chain: PickCandidate[],
    currentIndex: number,
): number => {
    if (chain.length === 0) {return -1;}
    if (currentIndex <= 0) {return currentIndex;}
    if (currentIndex >= chain.length) {return chain.length - 1;}
    return currentIndex - 1;
};

export const chooseCandidate = (
    chain: PickCandidate[],
    index: number,
): PickCandidate | null => {
    if (index < 0 || index >= chain.length) {return null;}
    return chain[index] ?? null;
};

export const DEFAULT_CANDIDATE_INDEX = 0;
