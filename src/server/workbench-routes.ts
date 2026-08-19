import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";

import { LegacyImportError } from "../core/import/legacy-import.js";
import { CaseStoreError } from "../core/storage/case-store.js";
import { EvidenceArchiveError } from "../core/storage/evidence-archive.js";
import { ChartDocumentError } from "../core/workbench/chart-document.js";
import { CaseWorkbench, WorkbenchError } from "../core/workbench/case-workbench.js";

export interface WorkbenchRoutesOptions {
  dataRoot: string;
  now?: () => Date;
}

function storeStatus(error: CaseStoreError): number {
  if (["REVISION_EXISTS", "EXPORT_EXISTS"].includes(error.code)) return 409;
  if (["INVALID_CASE_ID", "INVALID_REVISION_ID", "INVALID_WORKFLOW_STATUS", "INVALID_SOURCE_PATH"].includes(error.code)) return 400;
  return 422;
}

function externalStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const status = Number((error as { statusCode: unknown }).statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

export async function registerWorkbenchRoutes(
  app: FastifyInstance,
  options: WorkbenchRoutesOptions
): Promise<CaseWorkbench> {
  const workbench = new CaseWorkbench(options.dataRoot, { now: options.now });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "INVALID_INPUT",
        message: "输入没有通过数据契约校验",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    if (error instanceof WorkbenchError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof ChartDocumentError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof CaseStoreError) {
      return reply.code(storeStatus(error)).send({ error: error.code, message: error.message });
    }
    if (error instanceof EvidenceArchiveError) {
      return reply.code(422).send({ error: error.code, message: error.message });
    }
    if (error instanceof LegacyImportError) {
      const status = error.code === "LEGACY_SOURCE_CHANGED" ? 409 : 422;
      return reply.code(status).send({ error: error.code, message: error.message });
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return reply.code(404).send({ error: "NOT_FOUND", message: "指定的本地案例、修订或来源文件不存在" });
    }
    const status = externalStatus(error);
    const message = error instanceof Error ? error.message : "请求失败";
    if (status !== undefined) {
      return reply.code(status).send({ error: "REQUEST_FAILED", message });
    }
    if (error instanceof RangeError || (error instanceof Error && /^\w+(?:_\w+)*:/u.test(error.message))) {
      return reply.code(422).send({ error: "CALCULATION_REJECTED", message });
    }
    return reply.code(500).send({ error: "LOCAL_SERVER_ERROR", message: "本地服务未能完成本次操作" });
  });

  app.get("/api/cases", async () => workbench.listCases());

  app.get("/api/cases/:caseId/revisions/:revisionId", async (request) => {
    const params = z.object({ caseId: z.string(), revisionId: z.string() }).parse(request.params);
    return workbench.readRevision(params.caseId, params.revisionId);
  });

  app.post("/api/cases", async (request, reply) => {
    const result = await workbench.createCase(request.body);
    return reply.code(201).send(result);
  });

  app.post("/api/cases/:caseId/revisions", async (request, reply) => {
    const params = z.object({ caseId: z.string() }).parse(request.params);
    const result = await workbench.createRevision(params.caseId, request.body);
    return reply.code(201).send(result);
  });

  app.post("/api/cases/:caseId/revisions/:revisionId/decision", async (request, reply) => {
    const params = z.object({ caseId: z.string(), revisionId: z.string() }).parse(request.params);
    const result = await workbench.recordDecision(params.caseId, params.revisionId, request.body);
    return reply.code(201).send(result);
  });

  app.post("/api/cases/:caseId/revisions/:revisionId/target-years", async (request, reply) => {
    const params = z.object({ caseId: z.string(), revisionId: z.string() }).parse(request.params);
    const result = await workbench.updateTargetYears(params.caseId, params.revisionId, request.body);
    return reply.code(201).send(result);
  });

  app.post("/api/cases/:caseId/revisions/:revisionId/chart-document", async (request, reply) => {
    const params = z.object({ caseId: z.string(), revisionId: z.string() }).parse(request.params);
    const download = await workbench.downloadChartDocument(params.caseId, params.revisionId, request.body);
    return reply
      .header("content-type", download.contentType)
      .header("content-disposition", `attachment; filename="${download.filename}"`)
      .header("cache-control", "no-store")
      .send(download.document);
  });

  app.post("/api/imports/inspect", async (request) => {
    const body = z.object({ sourcePath: z.string().min(1) }).strict().parse(request.body);
    return workbench.inspectLegacySource(body.sourcePath);
  });

  app.post("/api/imports", async (request, reply) => {
    const result = await workbench.importSelectedLegacy(request.body);
    return reply.code(201).send(result);
  });

  return workbench;
}
