import { ApiError, type ApiChartDocument } from "./api.js";
import type { ChartDocumentTextView, presentChartDocumentText } from "./chart-document-text.js";
import type { ExportActionResult } from "./export-download.js";

export interface ExportActionLifecycle {
  setBusy(value: boolean): void;
  setError(value: string): void;
  setStatus(value: "" | ExportActionResult): void;
}

export interface ResolveChartDocumentTextInput {
  request: () => Promise<ApiChartDocument>;
  present?: typeof presentChartDocumentText;
}

export interface RunExportActionInput {
  action: () => Promise<ExportActionResult>;
  lifecycle: ExportActionLifecycle;
  fallbackError: string;
}

export interface RunPreparedExportActionInput extends Omit<RunExportActionInput, "action"> {
  view: ChartDocumentTextView;
  action: (view: ChartDocumentTextView) => ExportActionResult | Promise<ExportActionResult>;
}

export type ChartDocumentTextPreparationUpdate =
  | { status: "preparing"; key: string }
  | { status: "ready"; key: string; view: ChartDocumentTextView }
  | { status: "failed"; key: string; error: string };

export interface StartChartDocumentTextPreparationInput extends ResolveChartDocumentTextInput {
  key: string;
  fallbackError?: string;
  onUpdate(update: ChartDocumentTextPreparationUpdate): void;
}

export interface ChartDocumentTextPreparation {
  cancel(): void;
}

const chartDocumentTextPreparationFallbackError = "暂时无法准备 AI 文本，请确认本地程序仍在运行后重试。";

export async function resolveChartDocumentText(
  input: ResolveChartDocumentTextInput
): Promise<ChartDocumentTextView> {
  const result = await input.request();
  const present = input.present
    ?? (await import("./chart-document-text.js")).presentChartDocumentText;
  return present(result.document, result.filename);
}

export function startChartDocumentTextPreparation(
  input: StartChartDocumentTextPreparationInput
): ChartDocumentTextPreparation {
  let active = true;
  input.onUpdate({ status: "preparing", key: input.key });
  void resolveChartDocumentText(input).then((view) => {
    if (active) input.onUpdate({ status: "ready", key: input.key, view });
  }).catch((reason: unknown) => {
    if (!active) return;
    input.onUpdate({
      status: "failed",
      key: input.key,
      error: reason instanceof ApiError
        ? reason.message
        : input.fallbackError ?? chartDocumentTextPreparationFallbackError
    });
  });
  return { cancel: () => { active = false; } };
}

export async function runExportAction(input: RunExportActionInput): Promise<void> {
  input.lifecycle.setBusy(true);
  input.lifecycle.setError("");
  input.lifecycle.setStatus("");
  try {
    input.lifecycle.setStatus(await input.action());
  } catch (reason) {
    input.lifecycle.setError(reason instanceof Error ? reason.message : input.fallbackError);
  } finally {
    input.lifecycle.setBusy(false);
  }
}

export function runPreparedExportAction(input: RunPreparedExportActionInput): Promise<void> {
  return runExportAction({
    action: () => Promise.resolve(input.action(input.view)),
    lifecycle: input.lifecycle,
    fallbackError: input.fallbackError
  });
}
