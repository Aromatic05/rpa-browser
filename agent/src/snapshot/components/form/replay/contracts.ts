import type { RawPageCapture } from '../../../observation/model/raw_capture';
import type { FormBoundaryKind } from '../model/contracts';

export type FormFixtureExactTruth = {
    formCount: number;
    fieldCount: number;
    compositeFieldCount: number;
    residualFieldCount: number;
    actionCount: number;
    ownedActionCount: number;
    residualActionCount: number;
    groupCount: number;
    requiredFieldCount: number;
    dialogHostCount: number;
    boundaryKinds: FormBoundaryKind[];
    structuralRootCaptureIds: string[];
    residualFieldAnchorCaptureIds: string[];
};

export type FormFixtureTruth = {
    expected?: FormFixtureExactTruth;
    minimumFormCount?: number;
    minimumFieldCount?: number;
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
        kind: 'browser-capture' | 'generated-corpus';
        framework: 'native' | 'element-plus' | 'ant-design' | 'datatables';
        frameworkVersion: string;
        capturedAt: string;
        origin: string;
    };
    truth: FormFixtureTruth;
    capture: RawPageCapture;
};
