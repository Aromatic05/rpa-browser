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
