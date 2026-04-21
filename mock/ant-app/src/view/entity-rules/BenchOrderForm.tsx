import { Card, Space, message } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BusinessForm } from '../../component/entity-rules/BusinessForm';
import { DebugPanel } from '../../component/entity-rules/DebugPanel';
import { ScorePanel } from '../../component/entity-rules/ScorePanel';
import { TaskBanner } from '../../component/entity-rules/TaskBanner';
import { getOrderFormCase } from '../../service/entity-rules/case-service';
import { scoreOrderFormCase } from '../../service/entity-rules/score-service';
import { setLastScore } from '../../store/entity-rules';

export const BenchOrderForm = () => {
    const { caseId = '' } = useParams();
    const caseData = useMemo(() => getOrderFormCase(caseId), [caseId]);
    const [formValues, setFormValues] = useState(caseData.initialData);
    const [submitted, setSubmitted] = useState(false);
    const score = scoreOrderFormCase(caseData, {
        orderNo: formValues.orderNo,
        buyer: formValues.buyer,
        amount: Number(formValues.amount || 0),
        dept: formValues.dept,
        submitted,
    });
    useEffect(() => {
        setLastScore(score);
    }, [score]);
    useEffect(() => {
        setFormValues(caseData.initialData);
        setSubmitted(false);
    }, [caseData]);

    return (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <TaskBanner title={caseData.title} description={caseData.description} />
            <Card title="订单维护表单">
                <BusinessForm
                    mode="form"
                    values={formValues}
                    onChange={(patch) => setFormValues((current) => ({ ...current, ...patch }))}
                    onSubmit={() => {
                        setSubmitted(true);
                        message.success('表单已提交');
                    }}
                    onSaveDraft={() => message.info('草稿已保存')}
                    onReset={() => {
                        setFormValues(caseData.initialData);
                        setSubmitted(false);
                        message.info('已重置表单');
                    }}
                    onCancel={() => {
                        setFormValues(caseData.initialData);
                        setSubmitted(false);
                        message.warning('已取消编辑');
                    }}
                />
            </Card>
            <ScorePanel result={score} />
            <DebugPanel data={score} />
        </Space>
    );
};
