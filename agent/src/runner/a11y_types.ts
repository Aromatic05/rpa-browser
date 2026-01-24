export type A11yScanOptions = {
    include?: string[];
    exclude?: string[];
    tags?: string[];
    includedImpacts?: Array<'minor' | 'moderate' | 'serious' | 'critical'>;
    resultDetail?: 'summary' | 'full';
};

export type A11yViolationNode = {
    target: string[];
    html?: string;
    failureSummary?: string;
};

export type A11yViolation = {
    id: string;
    impact?: string | null;
    description: string;
    help: string;
    helpUrl: string;
    nodes: A11yViolationNode[];
};

export type A11yScanResult = {
    ok: boolean;
    url: string;
    ts: number;
    violations: A11yViolation[];
    counts: { total: number; byImpact: Record<string, number> };
    evidence?: { screenshotPath?: string };
    raw?: unknown;
};
