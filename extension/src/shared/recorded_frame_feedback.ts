const issues = {
    missing: 'The recorded embedded page could not be found.',
    ambiguous: 'More than one embedded page matches the recording.',
    changed: 'The recorded embedded page has changed its source.',
    unsupported: 'The recording does not identify this embedded page safely. Record the action again.',
} as const;

export type RecordedFrameIssue = keyof typeof issues;

export const asRecordedFrameIssue = (value: unknown): RecordedFrameIssue | undefined =>
    typeof value === 'string' && Object.hasOwn(issues, value) ? value as RecordedFrameIssue : undefined;

export const recordedFrameFeedback = (issue: RecordedFrameIssue): string => issues[issue];
