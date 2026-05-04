import crypto from 'node:crypto';

export type ControlSession = {
    id: string;
    createdAt: number;
};

export const createControlSession = (): ControlSession => ({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
});
