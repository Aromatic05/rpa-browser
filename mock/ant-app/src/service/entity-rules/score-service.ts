import type { OrderFormCase, OrderListCase } from '../../types/entity-rules';

export type CaseEvaluateResult = {
    ok: boolean;
    reasons: string[];
};

export const evaluateOrderListCase = (
    caseData: OrderListCase,
    input: { orderNo: string; buyer: string; status: string },
): CaseEvaluateResult => {
    const reasons: string[] = [];

    if (input.orderNo !== caseData.expected.filters.orderNo) {
        reasons.push('订单编号不匹配');
    }
    if (input.buyer !== caseData.expected.filters.buyer) {
        reasons.push('采购人不匹配');
    }
    if (input.status !== caseData.expected.filters.status) {
        reasons.push('状态不匹配');
    }

    const matchedCount = caseData.initialData.rows.filter((row) => {
        if (input.orderNo && !row.orderNo.includes(input.orderNo)) return false;
        if (input.buyer && !row.buyer.includes(input.buyer)) return false;
        if (input.status !== '全部' && row.status !== input.status) return false;
        return true;
    }).length;
    if (matchedCount !== caseData.expected.resultCount) {
        reasons.push(`结果条数不匹配（预期 ${caseData.expected.resultCount}，实际 ${matchedCount}）`);
    }

    return { ok: reasons.length === 0, reasons };
};

export const evaluateOrderFormCase = (
    caseData: OrderFormCase,
    input: { orderNo: string; buyer: string; amount: number; dept: string },
): CaseEvaluateResult => {
    const reasons: string[] = [];

    if (input.orderNo !== caseData.expected.orderNo) {
        reasons.push('订单编号不匹配');
    }
    if (input.buyer !== caseData.expected.buyer) {
        reasons.push('采购人不匹配');
    }
    if (input.amount !== caseData.expected.amount) {
        reasons.push('金额不匹配');
    }
    if (input.dept !== caseData.expected.dept) {
        reasons.push('部门不匹配');
    }

    return { ok: reasons.length === 0, reasons };
};

export const toAccuracy = (correct: number, total: number) => {
    if (total <= 0) return 0;
    return Math.round((correct / total) * 100);
};
