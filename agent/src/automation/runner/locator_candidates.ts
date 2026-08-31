export type LocatorCandidateKind = 'testid' | 'role' | 'label' | 'placeholder' | 'text' | 'css';

export type LocatorCandidate = {
    kind: LocatorCandidateKind;
    selector?: string;
    testId?: string;
    role?: string;
    name?: string;
    text?: string;
    exact?: boolean;
    note?: string;
};

export type ScopeHint = 'aside' | 'header' | 'main';
