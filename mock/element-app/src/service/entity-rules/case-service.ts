import { userFormCases } from '../../data/entity-rules/cases/user-form';
import { userListCases } from '../../data/entity-rules/cases/user-list';

export const getUserListCase = (caseId: string) => userListCases.find((item) => item.id === caseId) || userListCases[0];
export const getUserFormCase = (caseId: string) => userFormCases.find((item) => item.id === caseId) || userFormCases[0];
export const getUserListCaseOptions = () => userListCases.map((item) => ({ id: item.id, title: item.title }));
export const getUserFormCaseOptions = () => userFormCases.map((item) => ({ id: item.id, title: item.title }));
