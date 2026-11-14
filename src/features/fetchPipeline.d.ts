export type FetchPipelineSlotId =
  | 'chatSaveObserver'
  | 'presetSaveToggle'
  | `presetSaveToggle:${string}`
  | 'presetAutoBackup'
  | 'reduceLoadedFloors'
  | 'themeCacheSync'
  | 'extensionOps'
  | 'updateDiagnostics'
  | 'generateRetry'
  | 'perfTrace'
  | 'saveRequestGzip'
  | 'fastChatBackups'
  | 'fastChatSearch';

export type FetchPipelineNext = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type FetchPipelineHandler = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  nextFetch: FetchPipelineNext,
  thisArg: unknown,
) => Promise<Response>;

export const FETCH_PIPELINE_KEY: '__baiBaiToolkitFetchPipeline';
export const FETCH_PIPELINE_SLOT_ORDER: readonly string[];

export function registerFetchPipelineSlot(
  slotId: FetchPipelineSlotId,
  handler: FetchPipelineHandler,
): boolean;
export function unregisterFetchPipelineSlot(slotId: FetchPipelineSlotId): boolean;
export function hasFetchPipelineSlot(slotId: FetchPipelineSlotId): boolean;
export function getActiveFetchPipelineSlots(): string[];
export function callUnderlyingFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  thisArg?: unknown,
): Promise<Response>;
export function resetFetchPipeline(): boolean;
export function isFetchWrapperInChain(root: unknown, target: unknown): boolean;
export function spliceFetchWrapperOut(wrappedFetch: unknown, rawOriginalFetch: unknown): boolean;
