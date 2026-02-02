export type TargetDescriptor = {
    tag: string;
    id?: string;
    nameAttr?: string;
    typeAttr?: string;
    roleAttr?: string;
    ariaLabel?: string;
    text?: string;
    selector?: string;
    inputValue?: string;
};

export type RawEvent =
    | { type: 'click'; ts: number; url: string; target: TargetDescriptor }
    | { type: 'input'; ts: number; url: string; target: TargetDescriptor; value: string }
    | { type: 'change'; ts: number; url: string; target: TargetDescriptor; value: string; selectedText?: string }
    | { type: 'keydown'; ts: number; url: string; target: TargetDescriptor; key: { code: string; key: string; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean } }
    | { type: 'scroll'; ts: number; url: string; target: TargetDescriptor; scroll: { x: number; y: number } }
    | { type: 'navigate'; ts: number; url: string };
