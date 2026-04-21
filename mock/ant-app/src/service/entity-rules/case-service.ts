import { orderFormCases } from '../../data/entity-rules/cases/order-form';
import { orderListCases } from '../../data/entity-rules/cases/order-list';
import type { OrderFormCase, OrderListCase } from '../../types/entity-rules';

const pickBenchCases = <T extends { id: string }>(cases: T[], startId: string, size = 10): T[] => {
    if (cases.length === 0) return [];
    const startIndex = Math.max(0, cases.findIndex((item) => item.id === startId));
    const picked: T[] = [];
    for (let i = 0; i < Math.min(size, cases.length); i += 1) {
        picked.push(cases[(startIndex + i) % cases.length]);
    }
    return picked;
};

export const getOrderListCase = (caseId: string) => orderListCases.find((item) => item.id === caseId) || orderListCases[0];
export const getOrderFormCase = (caseId: string) => orderFormCases.find((item) => item.id === caseId) || orderFormCases[0];

export const getOrderListBenchCases = (startCaseId: string, size = 10): OrderListCase[] =>
    pickBenchCases(orderListCases, startCaseId, size);

export const getOrderFormBenchCases = (startCaseId: string, size = 10): OrderFormCase[] =>
    pickBenchCases(orderFormCases, startCaseId, size);

export const getOrderListCaseOptions = () => orderListCases.map((item) => ({ id: item.id, title: item.title }));
export const getOrderFormCaseOptions = () => orderFormCases.map((item) => ({ id: item.id, title: item.title }));
