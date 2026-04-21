import { Card, Space, message } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BusinessForm } from '../../component/entity-rules/BusinessForm';
import { BusinessTable } from '../../component/entity-rules/BusinessTable';
import { DebugPanel } from '../../component/entity-rules/DebugPanel';
import { ScorePanel } from '../../component/entity-rules/ScorePanel';
import { TaskBanner } from '../../component/entity-rules/TaskBanner';
import { getOrderListCase } from '../../service/entity-rules/case-service';
import { scoreOrderListCase } from '../../service/entity-rules/score-service';
import { setLastScore } from '../../store/entity-rules';

export const BenchOrderList = () => {
    const { caseId = '' } = useParams();
    const caseData = useMemo(() => getOrderListCase(caseId), [caseId]);
    const [formValues, setFormValues] = useState(caseData.initialData.filters);
    const [rows, setRows] = useState(caseData.initialData.rows);
    const [submitted, setSubmitted] = useState(false);
    const score = scoreOrderListCase(caseData, { ...formValues, submitted });
    useEffect(() => {
        setFormValues(caseData.initialData.filters);
        setRows(caseData.initialData.rows);
        setSubmitted(false);
    }, [caseData]);
    useEffect(() => {
        setLastScore(score);
    }, [score]);

    return (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <TaskBanner title={caseData.title} description={caseData.description} />
            <Card title="操作区域">
                <BusinessForm
                    mode="list"
                    values={formValues}
                    onChange={(patch) => setFormValues((current) => ({ ...current, ...patch }))}
                    onSubmit={() => {
                        setSubmitted(true);
                        message.success('已提交筛选条件');
                    }}
                    onReset={() => {
                        setFormValues(caseData.initialData.filters);
                        setSubmitted(false);
                        message.info('已重置筛选条件');
                    }}
                />
            </Card>
            <Card title="订单列表" role="table" aria-label="订单主表格">
                <BusinessTable
                    rows={rows}
                    onAction={(action, row) => {
                        if (action === 'delete') {
                            setRows((current) => current.filter((item) => item.orderNo !== row.orderNo));
                            message.warning(`已删除 ${row.orderNo}`);
                            return;
                        }
                        message.info(`${action === 'view' ? '查看' : '编辑'} ${row.orderNo}`);
                    }}
                />
            </Card>
            <ScorePanel result={score} />
            <DebugPanel data={score} />
        </Space>
    );
};
