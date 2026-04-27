import { Pagination } from 'antd';

export const PaginationBar = ({
    page,
    pageSize,
    total,
    onChange,
}: {
    page: number;
    pageSize: number;
    total: number;
    onChange?: (page: number, pageSize: number) => void;
}) => (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Pagination current={page} pageSize={pageSize} total={total} showSizeChanger={false} onChange={onChange} />
    </div>
);
