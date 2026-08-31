import crypto from 'node:crypto';

export const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value, 'utf8').digest('hex');