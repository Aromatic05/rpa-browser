import type { OrderRecord } from '../../../types/entity-rules';

const buyers = ['王明', '李静', '张涛', '赵敏', '陈楠', '刘晨', '孙凯', '周越'];
const statuses = ['待审批', '已通过', '已驳回'] as const;

export const fixtureOrderRows: OrderRecord[] = Array.from({ length: 40 }, (_, index) => {
    const serial = String(index + 1).padStart(3, '0');
    return {
        orderNo: `ORD-2026-${serial}`,
        buyer: buyers[index % buyers.length],
        amount: 1200 + index * 180,
        status: statuses[index % statuses.length],
    };
});
