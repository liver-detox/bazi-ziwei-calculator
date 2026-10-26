#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { buildBaziDetailV1, calculateCandidateCharts } from "../core/charts/index.js";
import { CURRENT_SOURCE_ID } from "../core/source-identity.js";
import { normalizeProvidedTime } from "../core/time/normalize-provided-time.js";
import { publicBirthRecordMaterial } from "../core/time/source-record-fingerprint.js";
import {
  CALCULATOR_VERSION, ChartDocumentV1Schema, type ChartDocumentV1
} from "../core/workbench/chart-document.js";
import { BirthRecordV2Schema, PublicBirthRecordV2Schema } from "../shared/provided-time-contracts.js";
import { chartDocumentYears, presentChartDocumentText } from "../web/chart-document-text.js";

const TargetYearsSchema = z.array(z.number().int().min(1900).max(2099))
  .transform((years) => [...new Set(years)].sort((left, right) => left - right))
  .pipe(z.array(z.number()).max(50, "一次最多计算 50 个不同年份，请分批选择"));
const CalculationRequestSchema = z.object({
  birthRecord: BirthRecordV2Schema,
  targetYears: TargetYearsSchema.default([])
});

export function parseYears(value: string): number[] {
  if (value.trim() === "") return [];
  const years = value.split(/[,，]/u).flatMap((part) => {
    const token = part.trim();
    if (/^\d{4}$/u.test(token)) return [Number(token)];
    const range = /^(\d{4})[:：](\d{4})$/u.exec(token);
    if (range === null) throw new Error(`年份格式无效：${token}；使用 2026 或 2026:2030，以逗号分隔`);
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start > end || start < 1900 || end > 2099) {
      throw new Error(`年份范围无效：${token}；应在 1900–2099 内按先后顺序填写`);
    }
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });
  return TargetYearsSchema.parse(years);
}

export function calculateDocuments(raw: unknown, options: {
  targetYears?: readonly number[];
  calculatorVersion?: string;
  now?: Date;
} = {}): ChartDocumentV1[] {
  const request = CalculationRequestSchema.parse(
    raw !== null && typeof raw === "object" && "birthRecord" in raw ? raw : { birthRecord: raw }
  );
  const targetYears = TargetYearsSchema.parse(options.targetYears ?? request.targetYears);
  const record = PublicBirthRecordV2Schema.parse(publicBirthRecordMaterial(request.birthRecord));
  const evidence = normalizeProvidedTime(record);
  const charts = calculateCandidateCharts(record, evidence, { targetYears });
  const detail = buildBaziDetailV1({ publicBirthRecord: record, timeEvidence: evidence, baseChartSet: charts });
  const exportedAt = (options.now ?? new Date()).toISOString();
  return charts.candidates.map((candidate) => {
    const time = evidence.candidates.find((item) => item.id === candidate.candidateId)!;
    const candidateDetail = detail.candidates.find((item) => item.candidateId === candidate.candidateId)!;
    const warnings = [...new Set([
      ...time.warnings,
      ...evidence.issues.filter((issue) => issue.candidateIds.includes(candidate.candidateId)).map((issue) => issue.message),
      ...(record.providedTime.precision === "minute" ? [] : [
        `出生时间精度为${record.providedTime.precision === "branch" ? "时辰区间" : "约略时间"}；本盘按输入的 ${record.providedTime.localTime} 计算，未展开整个时间区间。`
      ]),
      ...(charts.candidates.length > 1 ? ["本文件是并列候选之一，尚未确认取舍。"] : [])
    ])];
    return ChartDocumentV1Schema.parse({
      schemaVersion: 1,
      calculatorVersion: options.calculatorVersion ?? CALCULATOR_VERSION,
      exportSourceId: CURRENT_SOURCE_ID,
      exportedAt,
      subject: { nameOrAlias: request.birthRecord.privateName ?? record.alias, gender: record.gender },
      birthInput: { calendar: record.calendar, providedTime: record.providedTime, policy: record.policy },
      selection: { candidateId: candidate.candidateId, hadAlternatives: charts.candidates.length > 1, rationale: null },
      bazi: {
        chart: candidate.bazi,
        detail: {
          rulesetVersion: detail.rulesetVersion,
          engine: detail.engine,
          configuration: detail.configuration,
          candidate: candidateDetail
        }
      },
      ziwei: candidate.ziwei,
      ...(targetYears.length === 1 ? { targetYear: targetYears[0] } : {}),
      warnings
    });
  });
}

export function candidateDirectory(document: ChartDocumentV1): string {
  let calendar = "solar";
  if (document.birthInput.calendar.type === "lunar") {
    const basis = /:calendar:(?:\d-)?(lunar_regular|lunar_leap)$/u.exec(document.selection.candidateId)?.[1];
    calendar = basis === "lunar_leap" ? "lunar-leap" : basis === "lunar_regular" ? "lunar-regular"
      : document.birthInput.calendar.leapMonth === true ? "lunar-leap"
      : document.birthInput.calendar.leapMonth === false ? "lunar-regular" : "lunar-unknown";
  }
  return `${calendar}-${document.bazi.chart.configuration.sourceDayBoundary === "forward" ? "next-day" : "current-day"}`;
}

function caseDirectory(document: ChartDocumentV1): string {
  const caseId = /^(CS-\d{4}-\d{3}):/u.exec(document.selection.candidateId)?.[1];
  if (caseId === undefined) throw new Error("无法从候选中识别案例编号，未保存文件");
  return caseId;
}

function parseDocument(raw: unknown): ChartDocumentV1 {
  const document = ChartDocumentV1Schema.parse(raw);
  const id = document.selection.candidateId;
  if (document.bazi.chart.candidateId !== id || document.bazi.detail.candidate.candidateId !== id || document.ziwei.candidateId !== id) {
    throw new Error("文件中的八字、详盘与紫微候选 ID 不一致");
  }
  return document;
}

function assertSavedYears(documents: readonly ChartDocumentV1[], years: readonly number[]): void {
  for (const document of documents) {
    for (const year of years) {
      const missing = [
        ...(document.bazi.chart.annualFortunes.some((item) => item.year === year) ? [] : ["八字流年"]),
        ...(document.bazi.detail.candidate.annualDetails.some((item) => item.year === year) ? [] : ["八字流月与小运"]),
        ...(document.ziwei.yearlyFortunes.some((item) => item.targetYear === year) ? [] : ["紫微年度盘"])
      ];
      if (missing.length > 0) throw new Error(`${candidateDirectory(document)} 未保存 ${year} 年的${missing.join("、")}；请用 --input 和 --years 计算该年。`);
    }
  }
}

function documentJson(documents: readonly ChartDocumentV1[]): string {
  return JSON.stringify(documents.length === 1 ? documents[0] : documents, null, 2) + "\n";
}

const CANDIDATE_DIRECTORIES = new Set(
  ["solar", "lunar-regular", "lunar-leap", "lunar-unknown"].flatMap((calendar) =>
    ["current-day", "next-day"].map((day) => `${calendar}-${day}`))
);

async function replaceFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content, "utf8");
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function writeDocuments(
  outputDirectory: string, documents: readonly ChartDocumentV1[], years?: readonly number[], completeCandidateSet = false
): Promise<void> {
  const prepared = documents.map((document) => ({
    caseId: caseDirectory(document),
    candidate: candidateDirectory(document),
    json: documentJson([document]),
    text: presentChartDocumentText(document, "排盘.json", years ?? chartDocumentYears(document)).plainText
  }));
  const paths = new Set(prepared.map((item) => `${item.caseId}/${item.candidate}`));
  if (paths.size !== prepared.length) throw new Error("输入包含同一案例的重复候选，请逐份读取不同修订");
  for (const item of prepared) {
    const directory = join(outputDirectory, item.caseId, item.candidate);
    await mkdir(directory, { recursive: true });
    await replaceFile(join(directory, "排盘.json"), item.json);
    await replaceFile(join(directory, "排盘.txt"), item.text);
  }
  // A saved document may contain only one of several still-valid candidates.
  if (!completeCandidateSet) return;
  // Retire generated files only after recalculating the complete candidate set.
  for (const caseId of new Set(prepared.map((item) => item.caseId))) {
    const casePath = join(outputDirectory, caseId);
    for (const entry of await readdir(casePath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !CANDIDATE_DIRECTORIES.has(entry.name) || paths.has(`${caseId}/${entry.name}`)) continue;
      const directory = join(casePath, entry.name);
      await rm(join(directory, "排盘.json"), { force: true });
      await rm(join(directory, "排盘.txt"), { force: true });
      if ((await readdir(directory)).length === 0) await rmdir(directory);
    }
  }
}

const USAGE = `八字与紫微双轨排盘
  npm run calculate -- --input 输入.json [--years 2026,2028:2030] [--out 输出目录] [--format txt|json]
  npm run calculate -- --document 排盘.json [--years 2026] [--out 输出目录] [--format txt|json]

输入为 BirthRecordV2，或 { "birthRecord": BirthRecordV2, "targetYears": [] }。
默认只计算本命与大运；--years 优先于输入中的 targetYears，每次最多 50 个不同年份。
默认输出 TXT；--out 保存到 案例编号/候选/排盘.json 与 排盘.txt，同一案例同一候选再次保存会覆盖。
--document 只读取已有 ChartDocument V1，不重新排盘；未指定 --years 时展开全部已存年份。
`;

interface CliOptions { input?: string; document?: string; out?: string; years?: number[]; format: "txt" | "json"; help: boolean; }

function parseArguments(argv: readonly string[]): CliOptions {
  const options: CliOptions = { format: "txt", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    if (!["--input", "--document", "--out", "--years", "--format"].includes(argument)) throw new Error(`未知选项：${argument}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} 缺少值`);
    if (argument === "--years") options.years = parseYears(value);
    else if (argument === "--format") {
      if (value !== "txt" && value !== "json") throw new Error("--format 使用 txt 或 json");
      options.format = value;
    } else if (argument === "--input") options.input = value;
    else if (argument === "--document") options.document = value;
    else options.out = value;
  }
  if (!options.help && Number(options.input !== undefined) + Number(options.document !== undefined) !== 1) throw new Error("请提供 --input 或 --document，二者选一");
  return options;
}

export async function runCalculateCli(argv: readonly string[], runtime: {
  stdout: { write(content: string): unknown }; stderr: { write(content: string): unknown };
} = process): Promise<number> {
  try {
    const options = parseArguments(argv);
    if (options.help) { runtime.stdout.write(USAGE); return 0; }
    const raw: unknown = JSON.parse(await readFile(options.input ?? options.document!, "utf8"));
    let documents: ChartDocumentV1[];
    if (options.document !== undefined) {
      const values: unknown[] = Array.isArray(raw) ? raw : [raw];
      if (values.length === 0) throw new Error("排盘文件没有候选");
      documents = values.map(parseDocument);
      if (options.years !== undefined) assertSavedYears(documents, options.years);
    } else documents = calculateDocuments(raw, { targetYears: options.years });
    const text = options.format === "json" ? documentJson(documents) : documents.map((document) =>
      presentChartDocumentText(document, "排盘.json", options.years ?? chartDocumentYears(document)).plainText
    ).join("\n---\n\n");
    if (options.out !== undefined) await writeDocuments(resolve(options.out), documents, options.years, options.input !== undefined);
    runtime.stdout.write(text);
    return 0;
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n")
      : error instanceof Error ? error.message : String(error);
    runtime.stderr.write(`排盘失败：${message}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCalculateCli(process.argv.slice(2));
}
