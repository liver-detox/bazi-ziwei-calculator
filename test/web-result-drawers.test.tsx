import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { AuditPanel, TimeEvidencePanel, closeNativeDialog, connectNativeDialogLifecycle, drawerDecisionState, CaseDrawer, ExportPanel, VerificationDrawer, type ExportPanelProps } from "../src/web/ResultDrawers.js";
import type { ExportActionResult } from "../src/web/export-download.js";
import type { TimeEvidenceV2 } from "../src/shared/provided-time-contracts.js";

function visibleText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join("");
  if (node !== null && typeof node === "object" && "props" in node) {
    return visibleText((node as ReactElement<Record<string, unknown>>).props.children as ReactNode);
  }
  return "";
}

function exportButtons(panel: ReactElement): Array<ReactElement<Record<string, unknown>>> {
  const buttons: Array<ReactElement<Record<string, unknown>>> = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== "object" || !("type" in node) || !("props" in node)) return;
    const element = node as ReactElement<Record<string, unknown>>;
    if (element.type === "button") buttons.push(element);
    walk(element.props.children as ReactNode);
  };
  walk(panel);
  return buttons;
}

describe("result drawers", () => {
  it("uses the component lifecycle to showModal and return focus exactly once for each native close event", () => {
    const dialog = Object.assign(new EventTarget(), { open: false, showModal: vi.fn(function (this: { open: boolean }) { this.open = true; }), close: vi.fn(function (this: EventTarget & { open: boolean }) { this.open = false; this.dispatchEvent(new Event("close")); }) });
    const firstTrigger = { focus: vi.fn() } as unknown as HTMLElement;
    const secondTrigger = { focus: vi.fn() } as unknown as HTMLElement;
    const firstClose = vi.fn();
    const cleanupFirst = connectNativeDialogLifecycle(dialog as unknown as HTMLDialogElement, { open: true, onClose: firstClose, returnFocus: firstTrigger });

    closeNativeDialog(dialog as unknown as HTMLDialogElement);
    cleanupFirst();
    const secondClose = vi.fn();
    const cleanupSecond = connectNativeDialogLifecycle(dialog as unknown as HTMLDialogElement, { open: true, onClose: secondClose, returnFocus: secondTrigger });
    closeNativeDialog(dialog as unknown as HTMLDialogElement);
    cleanupSecond();

    expect(dialog.showModal).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(firstTrigger.focus).toHaveBeenCalledOnce();
    expect(secondTrigger.focus).toHaveBeenCalledOnce();
  });

  it("resets the candidate and rationale to the new case/revision identity defaults", () => {
    expect(drawerDecisionState({ candidateIds: ["candidate-b"], manualDecision: { selectedCandidateId: null, rationale: null } })).toEqual({ candidateId: "candidate-b", rationale: "" });
    expect(drawerDecisionState({ candidateIds: ["candidate-c"], manualDecision: { selectedCandidateId: "candidate-c", rationale: "新的理由" } })).toEqual({ candidateId: "candidate-c", rationale: "新的理由" });
  });

  it("renders the current-case chooser with search, list, and a fixed new chart action", () => {
    const html = renderToStaticMarkup(
      <CaseDrawer
        cases={[{ caseId: "CS-1991-001", alias: "测试案例", latestRevisionId: "R001", workflowStatus: "review", auditLevel: "B", contentFingerprint: "sha256:test" }]}
        currentCaseId="CS-1991-001"
        onClose={vi.fn()}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(html).toContain("当前案例");
    expect(html).toContain("搜索案例");
    expect(html).toContain("测试案例");
    expect(html).toContain("新建排盘");
    expect(html).toContain("<dialog");
  });

  it("keeps three user tasks visible and technical identity in a closed advanced section", () => {
    const html = renderToStaticMarkup(
      <VerificationDrawer
        audit={<p>差异内容</p>}
        evidence={<p>时间内容</p>}
        exportPanel={<p>导出内容</p>}
        onClose={vi.fn()}
        technical={<p>内容指纹：sha256:technical-only</p>}
      />
    );

    ["时间依据", "差异与人工确认", "导出", "高级技术信息"].forEach((heading) => expect(html).toContain(heading));
    expect(html).toMatch(/<details class="advanced-technical"><summary>高级技术信息<\/summary><div>.*sha256:technical-only.*<\/div><\/details>/u);
    expect(html).not.toMatch(/<details[^>]*open/u);
    expect(html).not.toContain("Handoff");
    expect(html).not.toContain("队列");
    expect(html).not.toContain("预览");
  });

  it("keeps the full time evidence and all three human-decision paths inside verification", () => {
    const evidence: TimeEvidenceV2 = {
      schemaVersion: "2.0.0", caseId: "CS-1991-001", sourceRecordFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rulesetVersion: "CyberSaga-Provided-Time-v1",
      originalCalendar: { type: "solar", date: "1991-03-23", leapMonth: false }, originalLocalTime: "16:56", originalTimeBasis: "apparent_solar_provided", solarDate: "1991-03-23",
      calendarResolutions: [{ id: "calendar", basis: "solar", status: "valid", sourceDate: "1991-03-23", solarDate: "1991-03-23", note: "公历日期直接采用" }],
      candidates: [{ id: "candidate-a", basis: "apparent_solar_provided", preferred: true, localDateTime: "1991-03-23T16:56", earthlyBranch: { index: 8, name: "申", range: "15:00~17:00" }, ziSegment: null, dayBoundary: "current", calendarResolutionId: "calendar", calendarBasis: "solar", warnings: [] }], issues: []
    };
    const evidenceHtml = renderToStaticMarkup(<TimeEvidencePanel evidence={evidence} />);
    const auditHtml = renderToStaticMarkup(<AuditPanel audit={{ auditLevel: "B", workflowStatus: "review", candidateIds: ["candidate-a"], findings: [] }} busy={false} identity="CS-1991-001:R001" onDecision={async () => undefined} open />);

    ["输入口径", "公历日期直接采用", "当前没有时间口径警告"].forEach((text) => expect(evidenceHtml).toContain(text));
    ["保留全部", "选为工作主盘", "保存为已核验新修订"].forEach((text) => expect(auditHtml).toContain(text));
    expect(evidenceHtml).toContain("候选 1");
    expect(auditHtml).toContain("候选 1");
    expect(auditHtml).toContain("当前核验状态：待核验");
    expect(auditHtml).not.toContain("审计等级 B");
    expect(evidenceHtml).not.toContain("candidate-a");
    expect(auditHtml).not.toContain(">candidate-a<");
    expect(auditHtml).not.toContain("· candidate-a");
    expect(auditHtml).toContain('value="candidate-a"');
  });

  it("renders five grouped export actions when system sharing is available", () => {
    const html = renderToStaticMarkup(<ExportPanel
      busy={false}
      onCopy={vi.fn()}
      onDownloadJson={vi.fn()}
      onDownloadText={vi.fn()}
      onPrint={vi.fn()}
      onShare={vi.fn()}
      shareAvailable
      status=""
    />);

    ["复制 AI 文本", "系统分享", "下载 TXT", "打开打印", "下载完整 JSON"]
      .forEach((label) => expect(html).toContain(label));
    expect(html).toContain("导出内容包含当前输入的姓名或代号及出生资料，请确认后再分享。");
    expect(html).toContain("给大模型使用");
    expect(html).toContain("阅读与保存");
    expect(html).toContain("完整数据");
    expect(html).toContain("浏览器/系统提供时可在打印窗口存为 PDF");
    expect(html).toMatch(/<button class="button primary"[^>]*>系统分享<\/button>/u);
    expect(html).toMatch(/<button class="button secondary"[^>]*>复制 AI 文本<\/button>/u);
    expect(html.match(/<button/gu)).toHaveLength(5);
  });

  it.each<[
    string,
    keyof Pick<ExportPanelProps, "onCopy" | "onDownloadJson" | "onDownloadText" | "onPrint" | "onShare">
  ]>([
    ["复制 AI 文本", "onCopy"],
    ["系统分享", "onShare"],
    ["下载 TXT", "onDownloadText"],
    ["打开打印", "onPrint"],
    ["下载完整 JSON", "onDownloadJson"]
  ])("routes the %s button to only its matching handler once", (label, expectedHandler) => {
    const handlers = {
      onCopy: vi.fn(async () => {}),
      onDownloadJson: vi.fn(async () => {}),
      onDownloadText: vi.fn(async () => {}),
      onPrint: vi.fn(async () => {}),
      onShare: vi.fn(async () => {})
    };
    const button = exportButtons(ExportPanel({ busy: false, shareAvailable: true, status: "", ...handlers }))
      .find((element) => visibleText(element.props.children as ReactNode) === label);

    expect(button).toBeDefined();
    (button?.props.onClick as (() => void))();
    for (const [name, handler] of Object.entries(handlers)) {
      expect(handler).toHaveBeenCalledTimes(name === expectedHandler ? 1 : 0);
    }
  });

  it("shows a fixed sharing fallback without starting another action", () => {
    const html = renderToStaticMarkup(<ExportPanel
      busy={false}
      onCopy={vi.fn()}
      onDownloadJson={vi.fn()}
      onDownloadText={vi.fn()}
      onPrint={vi.fn()}
      onShare={vi.fn()}
      shareAvailable={false}
      status="share_unavailable"
    />);

    expect(html).not.toMatch(/<button[^>]*>系统分享<\/button>/u);
    ["复制 AI 文本", "下载 TXT", "打开打印", "下载完整 JSON"]
      .forEach((label) => expect(html).toContain(label));
    expect(html).toContain("当前浏览器不支持系统分享，请使用复制或下载 TXT。");
    expect(html.match(/<button/gu)).toHaveLength(4);
  });

  it("disables every visible export action while another action is busy", () => {
    const html = renderToStaticMarkup(<ExportPanel
      busy
      onCopy={vi.fn()}
      onDownloadJson={vi.fn()}
      onDownloadText={vi.fn()}
      onPrint={vi.fn()}
      onShare={vi.fn()}
      shareAvailable
      status=""
    />);

    expect(html.match(/<button[^>]*disabled=""/gu)).toHaveLength(5);
  });

  it("disables only text actions while the selected chart text is being prepared", () => {
    const panel = ExportPanel({
      busy: false,
      onCopy: vi.fn(async () => {}),
      onDownloadJson: vi.fn(async () => {}),
      onDownloadText: vi.fn(async () => {}),
      onPrint: vi.fn(async () => {}),
      onShare: vi.fn(async () => {}),
      shareAvailable: true,
      status: "",
      textPreparing: true,
      textReady: false
    } as ExportPanelProps & { textPreparing: boolean; textReady: boolean });
    const disabledByLabel = Object.fromEntries(exportButtons(panel).map((button) => [
      visibleText(button.props.children as ReactNode),
      button.props.disabled
    ]));

    expect(disabledByLabel).toEqual({
      "复制 AI 文本": true,
      "系统分享": true,
      "下载 TXT": true,
      "打开打印": true,
      "下载完整 JSON": false
    });
    expect(renderToStaticMarkup(panel)).toContain("正在准备文本导出……");
  });

  it("shows a text preparation error, disables four text actions, and keeps JSON usable", () => {
    const handlers = {
      onCopy: vi.fn(async () => {}),
      onDownloadJson: vi.fn(async () => {}),
      onDownloadText: vi.fn(async () => {}),
      onPrint: vi.fn(async () => {}),
      onShare: vi.fn(async () => {}),
      onRetryText: vi.fn()
    };
    const panel = ExportPanel({
      busy: false,
      shareAvailable: true,
      status: "",
      textError: "本地文本生成失败",
      textReady: false,
      ...handlers
    });
    const buttons = exportButtons(panel);
    const disabledByLabel = Object.fromEntries(buttons.map((button) => [
      visibleText(button.props.children as ReactNode),
      button.props.disabled ?? false
    ]));

    expect(disabledByLabel).toEqual({
      "重试准备 AI 文本": false,
      "复制 AI 文本": true,
      "系统分享": true,
      "下载 TXT": true,
      "打开打印": true,
      "下载完整 JSON": false
    });
    const html = renderToStaticMarkup(panel);
    expect(html).toContain("AI 文本准备失败：本地文本生成失败");
    expect(html).toContain('role="alert"');

    const jsonButton = buttons.find((button) => visibleText(button.props.children as ReactNode) === "下载完整 JSON");
    (jsonButton?.props.onClick as (() => void))();
    expect(handlers.onDownloadJson).toHaveBeenCalledOnce();
  });

  it("routes a text preparation retry only to the retry handler", () => {
    const handlers = {
      onCopy: vi.fn(async () => {}),
      onDownloadJson: vi.fn(async () => {}),
      onDownloadText: vi.fn(async () => {}),
      onPrint: vi.fn(async () => {}),
      onShare: vi.fn(async () => {}),
      onRetryText: vi.fn()
    };
    const retryButton = exportButtons(ExportPanel({
      busy: false,
      shareAvailable: true,
      status: "",
      textError: "本地文本生成失败",
      textReady: false,
      ...handlers
    })).find((button) => visibleText(button.props.children as ReactNode) === "重试准备 AI 文本");

    expect(retryButton).toBeDefined();
    (retryButton?.props.onClick as (() => void))();
    expect(handlers.onRetryText).toHaveBeenCalledOnce();
    expect(handlers.onCopy).not.toHaveBeenCalled();
    expect(handlers.onDownloadJson).not.toHaveBeenCalled();
    expect(handlers.onDownloadText).not.toHaveBeenCalled();
    expect(handlers.onPrint).not.toHaveBeenCalled();
    expect(handlers.onShare).not.toHaveBeenCalled();
  });

  it.each<[ExportActionResult, string]>([
    ["copied", "复制成功"],
    ["download_started", "浏览器已开始下载"],
    ["shared", "分享完成"],
    ["share_unavailable", "分享不可用"],
    ["share_cancelled", "取消分享"],
    ["print_started", "已请求系统打印"]
  ])("renders the fixed %s result message", (status, message) => {
    const html = renderToStaticMarkup(<ExportPanel
      busy={false}
      onCopy={vi.fn()}
      onDownloadJson={vi.fn()}
      onDownloadText={vi.fn()}
      onPrint={vi.fn()}
      onShare={vi.fn()}
      shareAvailable
      status={status}
    />);

    expect(html).toContain(message);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
