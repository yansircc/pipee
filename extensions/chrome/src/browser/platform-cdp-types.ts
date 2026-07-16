export type CdpRuntimeValueObject = {
  readonly kind?: string | undefined;
  readonly source?: string | undefined;
  readonly description?: string | undefined;
  readonly value?: unknown;
  readonly name?: string | undefined;
  readonly message?: string | undefined;
  readonly stack?: string | undefined;
  readonly [key: string]: unknown;
};

export type CdpRuntimeValue =
  | string
  | number
  | boolean
  | null
  | Array<unknown>
  | CdpRuntimeValueObject;

export type CdpRemoteObject = {
  readonly type?: string | undefined;
  readonly subtype?: string | undefined;
  readonly className?: string | undefined;
  readonly value?: CdpRuntimeValue | undefined;
  readonly description?: string | undefined;
  readonly objectId?: string | undefined;
};

export type CdpExceptionDetails = {
  readonly text?: string | undefined;
  readonly exception?: CdpRemoteObject | undefined;
};

export type CdpRuntimeEvaluateResult = {
  readonly result?: CdpRemoteObject | undefined;
  readonly exceptionDetails?: CdpExceptionDetails | undefined;
};

export type CdpPageLifecycleEvent = {
  readonly frameId: string;
  readonly loaderId: string;
  readonly name: string;
};

export type CdpPageNavigateResult = {
  readonly frameId: string;
  readonly loaderId?: string | undefined;
  readonly errorText?: string | undefined;
  readonly isDownload?: boolean | undefined;
};

export type CdpAxValue = {
  readonly type: string;
  readonly value?: string | number | boolean | undefined;
};

export type CdpAxNode = {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly backendDOMNodeId?: number | undefined;
  readonly role?: CdpAxValue | undefined;
  readonly name?: CdpAxValue | undefined;
  readonly properties?: ReadonlyArray<{
    readonly name: string;
    readonly value: CdpAxValue;
  }>;
};

type EmptyResult = Readonly<Record<string, never>>;

export type CdpCommandResultMap = {
  readonly "Accessibility.getFullAXTree": { readonly nodes: ReadonlyArray<CdpAxNode> };
  readonly "DOM.enable": EmptyResult;
  readonly "DOM.resolveNode": { readonly object: CdpRemoteObject };
  readonly "DOM.requestNode": { readonly nodeId: number };
  readonly "DOM.setFileInputFiles": EmptyResult;
  readonly "Input.dispatchKeyEvent": EmptyResult;
  readonly "Input.dispatchMouseEvent": EmptyResult;
  readonly "Input.dispatchTouchEvent": EmptyResult;
  readonly "Page.addScriptToEvaluateOnNewDocument": { readonly identifier: string };
  readonly "Page.captureScreenshot": { readonly data: string };
  readonly "Page.enable": EmptyResult;
  readonly "Page.getLayoutMetrics": {
    readonly contentSize: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly cssContentSize?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly visualViewport: { readonly clientWidth: number; readonly clientHeight: number };
    readonly cssVisualViewport?: { readonly clientWidth: number; readonly clientHeight: number };
  };
  readonly "Page.navigate": CdpPageNavigateResult;
  readonly "Page.removeScriptToEvaluateOnNewDocument": EmptyResult;
  readonly "Page.setLifecycleEventsEnabled": EmptyResult;
  readonly "Runtime.callFunctionOn": CdpRuntimeEvaluateResult;
  readonly "Runtime.evaluate": CdpRuntimeEvaluateResult;
  readonly "Runtime.releaseObject": EmptyResult;
};

export type CdpMethod = keyof CdpCommandResultMap;
export type CdpCommandParams = Readonly<Record<string, unknown>>;
export type CdpCommandResult<Method extends CdpMethod> = CdpCommandResultMap[Method];

export type ScriptExecutionError = string | { readonly message?: string | undefined };

export type ScriptExecutionResult<Result> = {
  readonly documentId: string;
  readonly frameId: number;
  readonly result?: Result | undefined;
  readonly error?: ScriptExecutionError | undefined;
};
