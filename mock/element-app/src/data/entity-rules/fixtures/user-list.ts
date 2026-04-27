import type { UserRecord } from '../../../types/entity-rules';

const names = ['alice', 'bob', 'charlie', 'diana', 'edward', 'frank', 'grace', 'helen'];
const statuses = ['启用', '停用'] as const;

export const fixtureUserRows: UserRecord[] = Array.from({ length: 40 }, (_, index) => {
    const serial = String(index + 1).padStart(3, '0');
    return {
        userNo: `USR-${serial}`,
        userName: names[index % names.length],
        phone: `1390000${String(1000 + index).slice(-4)}`,
        status: statuses[index % statuses.length],
    };
});
