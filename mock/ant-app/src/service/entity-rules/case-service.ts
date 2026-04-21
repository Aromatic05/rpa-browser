import { orderFormCases } from '../../data/entity-rules/cases/order-form';
import { orderListCases } from '../../data/entity-rules/cases/order-list';

export const getOrderListCase = (caseId: string) => orderListCases.find((item) => item.id === caseId) || orderListCases[0];
export const getOrderFormCase = (caseId: string) => orderFormCases.find((item) => item.id === caseId) || orderFormCases[0];
export const getOrderListCaseOptions = () => orderListCases.map((item) => ({ id: item.id, title: item.title }));
export const getOrderFormCaseOptions = () => orderFormCases.map((item) => ({ id: item.id, title: item.title }));
