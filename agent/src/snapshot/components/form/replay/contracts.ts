import type { RawPageCapture } from '../../../observation/model/raw_capture';
import type { FormBoundaryKind } from '../model/contracts';

export type FormFixtureTruth = {
    minimumFormCount: number;
    minimumFieldCount: number;
    minimumCompositeFieldCount?: number;
    minimumResidualFieldCount?: number;
    expectedBoundaryKinds?: FormBoundaryKind[];
    requireDialogHost?: boolean;
};

export type FormFixture = {
    fixtureVersion: 1;
    id: string;
    category: string;
    source: {
        kind: 'browser-capture';
        framework: 'native' | 'element-plus' | 'ant-design' | 'datatables';
        frameworkVersion: string;
        capturedAt: string;
        origin: string;
    };
    truth: FormFixtureTruth;
    capture: RawPageCapture;
};
