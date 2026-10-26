import type { ChartDocumentV1 } from "../core/workbench/chart-document.js";
import { CURRENT_SOURCE_ID } from "#source-identity";
import { presentZiweiPalaces, ZIWEI_PALACE_READING_NOTE } from "../shared/ziwei-palace-presentation.js";
import {
  BAZI_LUCK_DATE_NOTE, BAZI_LUCK_DATE_UNAVAILABLE, DUAL_YEAR_BOUNDARY_NOTE,
  baziDaYunDateIntervals, baziDaYunIntervalText, baziDaYunYearIntervals
} from "../shared/chart-display.js";
import { PROVIDED_TIME_PRESENTATION } from "../shared/provided-time-presentation.js";

export const CHART_DOCUMENT_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8" as const;

export interface ChartDocumentTextView {
  title: "八字与紫微斗数双轨排盘";
  filename: string;
  contentType: typeof CHART_DOCUMENT_TEXT_CONTENT_TYPE;
  plainText: string;
}

function inputNotes(document: ChartDocumentV1): string[] {
  const summaries = [...new Set([
    ...document.warnings,
    ...(document.evidence?.findings.filter(({ severity }) => severity !== "info").map(({ summary }) => summary) ?? [])
  ].map(inline))];
  return summaries.length === 0 ? [] : ["### 本次输入的具体说明", ...summaries.map((summary) => `- ${summary}`)];
}

function inline(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未提供";
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\r\n\t\u2028\u2029]+/gu, " ")
    .replace(/ {2,}/gu, " ")
    .trim();
}

function field(label: string, value: unknown): string {
  return `- ${label}：${inline(value)}`;
}

function list(values: readonly unknown[]): string {
  return values.map(inline).join("、") || "未提供";
}

function dayBoundaryText(boundary: "current" | "forward"): string {
  return boundary === "current" ? "当日口径" : "次日口径";
}

export function chartDocumentYears(document: ChartDocumentV1): number[] {
  return [...new Set([
    ...document.bazi.chart.annualFortunes.map(({ year }) => year),
    ...document.bazi.detail.candidate.annualDetails.map(({ year }) => year),
    ...(document.ziwei.yearlyFortunes ?? []).map(({ targetYear }) => targetYear)
  ])].sort((left, right) => left - right);
}

function textScope(document: ChartDocumentV1, years: readonly number[]): string[] {
  const available = chartDocumentYears(document);
  return [
    "## 本次文本范围",
    field("文本覆盖范围", years.length === 0
      ? "本命与全部已算大运；未选择目标年，不展开流年、流月及紫微年度叠加"
      : years.length === 1
        ? `本命与全部已算大运；仅展开目标年 ${years[0]} 的八字流年、十二节气流月及紫微年度叠加`
        : "本命与全部已算大运各列一次；按年展开八字流年、十二节气流月及紫微年度叠加"),
    field("本次展开流年", years.length === 0 ? "无，仅本命与大运" : list(years)),
    field("完整 JSON 已算目标年份", available.length === 0 ? "无（尚未计算目标年份）" : list(available)),
    `> ${DUAL_YEAR_BOUNDARY_NOTE}`
  ];
}

function ganZhiRelations(
  lines: string[],
  relations: {
    stemTenGod: string;
    branchMainQiTenGod: string;
    hiddenStems: string[];
    hiddenStemTenGods: string[];
    growthStage: string;
    naYin: string;
  }
): void {
  lines.push(
    field("天干十神", relations.stemTenGod),
    field("地支主气十神", relations.branchMainQiTenGod),
    field("藏干", list(relations.hiddenStems)),
    field("藏干副星", list(relations.hiddenStemTenGods)),
    field("十二长生", relations.growthStage),
    field("纳音", relations.naYin)
  );
}

function pillarText(
  lines: string[],
  pillar: ChartDocumentV1["bazi"]["chart"]["pillars"]["year"]
): void {
  lines.push(
    field("干支", pillar.ganZhi),
    field("天干", pillar.heavenlyStem),
    field("地支", pillar.earthlyBranch),
    field("藏干", list(pillar.hiddenStems)),
    field("天干十神", pillar.stemTenGod),
    field("藏干副星", list(pillar.hiddenStemTenGods)),
    field("纳音", pillar.naYin),
    field("旬", pillar.xun),
    field("空亡", pillar.voidBranches),
    field("十二长生", pillar.growthStage)
  );
}

function appendBaziNatal(lines: string[], document: ChartDocumentV1): void {
  const { chart, detail } = document.bazi;
  lines.push(
    "## 八字",
    "### 计算口径与历法",
    field("基础盘规则版本", chart.rulesetVersion),
    field("基础盘引擎", `${chart.engine.name}@${chart.engine.version}`),
    field("柱法", chart.configuration.pillarSect === 1 ? "法 1（晚子时按次日日柱）" : "法 2（晚子时按当日日柱）"),
    field("起运法", "法 1（按顺逆取相邻节，以天数和时辰差折算起运间隔）"),
    field("年界", "立春"),
    field("月界", "十二节分月（节气月）"),
    field("日界", dayBoundaryText(chart.configuration.sourceDayBoundary)),
    field("原始本地时间", chart.input.sourceLocalDateTime),
    field("计算本地时间", chart.input.calculationLocalDateTime),
    field("时间口径", PROVIDED_TIME_PRESENTATION[document.birthInput.providedTime.basis].label),
    field("时支索引", chart.input.earthlyBranchIndex),
    field("公历日期", chart.calendar.solarDate),
    field("公历日期时间", chart.calendar.solarDateTime),
    field("农历年", chart.calendar.lunarYear),
    field("农历月", chart.calendar.lunarMonth),
    field("农历日", chart.calendar.lunarDay),
    field("农历闰月", chart.calendar.isLeapMonth),
    field("农历文本", chart.calendar.lunarText),
    field("详盘规则版本", detail.rulesetVersion),
    field("详盘引擎", `${detail.engine.name}@${detail.engine.version}`),
    field("流年分界", "立春"),
    field("流月分界", "十二节分月（节气月）"),
    field("流月区间", "含开始，不含结束（左闭右开）"),
    field("节气时间口径", "lunar-typescript 引擎节气表原值，未作地点或时区换算"),
    field("计算精度", "秒（引擎时间输出精度，不代表出生资料精度）"),
    field("页面主显示精度", "显示到分钟，截去秒，不四舍五入；本交接保留关键时间的秒值"),
    field("最大目标流年数", detail.configuration.maxTargetYears),
    field("最大大运数", detail.configuration.maxDaYunPeriods),
    field("每年流月数", detail.configuration.liuYuePerYear),
    "### 年柱"
  );
  pillarText(lines, chart.pillars.year);
  lines.push("### 月柱");
  pillarText(lines, chart.pillars.month);
  lines.push("### 日柱（日主）");
  pillarText(lines, chart.pillars.day);
  lines.push("### 时柱");
  pillarText(lines, chart.pillars.time);

  lines.push("### 辅助柱");
  const auxiliaryPillars = [
    ["胎元", detail.candidate.auxiliaryPillars.taiYuan],
    ["胎息", detail.candidate.auxiliaryPillars.taiXi],
    ["八字命宫", detail.candidate.auxiliaryPillars.baziMingGong],
    ["八字身宫", detail.candidate.auxiliaryPillars.baziShenGong]
  ] as const;
  for (const [label, pillar] of auxiliaryPillars) {
    lines.push(`#### ${label}`, field("干支", pillar.ganZhi), field("纳音", pillar.naYin));
  }

  lines.push(
    "### 起运与大运",
    field("性别代码", chart.luck.genderCode),
    field("顺行", chart.luck.forward),
    field("起运公历时间", chart.luck.startSolarDateTime),
    field("起运间隔", `出生后 ${chart.luck.startAfter.years} 年 ${chart.luck.startAfter.months} 月 ${chart.luck.startAfter.days} 天 ${chart.luck.startAfter.hours} 小时起运`),
    `> ${BAZI_LUCK_DATE_NOTE}`
  );
  const dateIntervals = baziDaYunDateIntervals(chart);
  for (const fortune of chart.luck.daYun) {
    lines.push(
      `#### 大运 ${inline(fortune.index)}`,
      field("索引", fortune.index),
      field("年表起始虚岁", fortune.endYear < fortune.startYear ? "不适用（年表为空）" : fortune.startAge),
      field("年表结束虚岁", fortune.endYear < fortune.startYear ? "不适用（年表为空）" : fortune.endAge),
      field("年表年份", fortune.endYear < fortune.startYear ? "空（出生当年起运，第 0 段无年度记录）" : `${fortune.startYear}–${fortune.endYear}`),
      field("按日期推算区间", dateIntervals === null ? BAZI_LUCK_DATE_UNAVAILABLE : baziDaYunIntervalText(dateIntervals.find(({ daYunIndex }) => daYunIndex === fortune.index)!)),
      field("干支", fortune.index === 0 ? "起运前，不适用" : fortune.ganZhi),
      field("旬", fortune.xun),
      field("空亡", fortune.voidBranches)
    );
    const detailItem = detail.candidate.daYunDetails.find((item) => item.index === fortune.index);
    if (detailItem?.relations === null || fortune.index === 0) {
      lines.push(field("关系", "起运前不列大运干支关系"));
    } else if (detailItem !== undefined) {
      ganZhiRelations(lines, detailItem.relations);
    } else {
      lines.push(field("关系", "未提供"));
    }
  }

}

function appendBaziYear(lines: string[], document: ChartDocumentV1, targetYear: number): void {
  const { chart, detail } = document.bazi;
  for (const annual of chart.annualFortunes.filter(({ year }) => year === targetYear)) {
    const annualDetail = detail.candidate.annualDetails.find((item) => item.year === annual.year);
    lines.push(
      `#### 流年 ${inline(annual.year)}`,
      field("年份", annual.year),
      field("虚岁", annual.age),
      field("干支", annual.ganZhi),
      field("旬", annual.xun),
      field("空亡", annual.voidBranches),
      field("大运年表索引", annual.daYunIndex),
      field("所选公历年内的大运分段", `${annual.year} 年；出生前不适用，与立春起的八字流年区间不同`)
    );
    const yearIntervals = baziDaYunYearIntervals(chart, annual.year);
    if (yearIntervals === null) lines.push(field("按日期推算的大运", BAZI_LUCK_DATE_UNAVAILABLE));
    for (const interval of yearIntervals ?? []) {
      lines.push(field("按日期推算的大运", baziDaYunIntervalText(interval)));
    }
    if (annualDetail === undefined) {
      lines.push(field("流年关系", "未提供"));
      continue;
    }
    ganZhiRelations(lines, annualDetail.relations);
    lines.push(
      "##### 小运",
      field("年份", annualDetail.xiaoYun.year),
      field("虚岁", annualDetail.xiaoYun.virtualAge),
      field("干支", annualDetail.xiaoYun.ganZhi),
      field("旬", annualDetail.xiaoYun.xun),
      field("空亡", annualDetail.xiaoYun.voidBranches)
    );
    ganZhiRelations(lines, annualDetail.xiaoYun.relations);
    for (const month of annualDetail.liuYue) {
      lines.push(
        `##### ${inline(month.monthName)}`,
        field("序号", month.ordinal),
        field("节气开始", `${month.interval.start.name} ${month.interval.start.engineDateTime}`),
        field("节气结束", `${month.interval.end.name} ${month.interval.end.engineDateTime}`),
        field("区间语义", "含开始，不含结束（左闭右开）"),
        field("干支", month.ganZhi),
        field("旬", month.xun),
        field("空亡", month.voidBranches)
      );
      ganZhiRelations(lines, month.relations);
    }
  }
}

function appendZiweiNatal(lines: string[], document: ChartDocumentV1): void {
  const { ziwei } = document;
  lines.push(
    "## 紫微斗数",
    "### 计算口径与基本资料",
    field("规则版本", ziwei.rulesetVersion),
    field("引擎", `${ziwei.engine.name}@${ziwei.engine.version}`),
    field("算法", "iztro 默认排星算法"),
    field("本命年界", "农历正月初一（普通农历年界）"),
    field("运限年界", "农历正月初一（普通农历年界）"),
    field("年龄划分", "按农历年计虚岁，出生为 1 岁，不以生日切换"),
    field("日界", `${dayBoundaryText(ziwei.configuration.dayDivide)}（引擎使用下列已选定的输入日期）`),
    field("四化算法", ziwei.configuration.mutagens),
    field("亮度算法", ziwei.configuration.brightness),
    field("星盘类型", "天盘"),
    field("闰月处理", "启用 iztro 的闰月处理规则"),
    field("语言", "简体中文"),
    field("来源时辰索引", ziwei.configuration.sourceTimeIndex),
    field("计算时辰索引", ziwei.configuration.timeIndex),
    field("原始本地时间", ziwei.input.sourceLocalDateTime),
    field("计算本地时间", ziwei.input.calculationLocalDateTime),
    field("时间口径", PROVIDED_TIME_PRESENTATION[document.birthInput.providedTime.basis].label),
    field("来源子时分段", ziwei.input.sourceZiSegment === null ? "非子时" : { early: "早子时", late: "晚子时" }[ziwei.input.sourceZiSegment]),
    field("来源日界", dayBoundaryText(ziwei.input.sourceDayBoundary)),
    field("引擎输入日期", ziwei.input.engineInputDate),
    field("性别", ziwei.gender),
    field("公历日期", ziwei.solarDate),
    field("农历日期", ziwei.lunarDate),
    field("中文日期", ziwei.chineseDate),
    field("时辰", ziwei.time),
    field("时辰范围", ziwei.timeRange),
    field("命宫地支", ziwei.soulPalaceBranch),
    field("身宫地支", ziwei.bodyPalaceBranch),
    field("命主", ziwei.soul),
    field("身主", ziwei.body),
    field("五行局", ziwei.fiveElementsClass)
  );
}

function appendZiweiPalaces(lines: string[], document: ChartDocumentV1, targetYear: number | undefined, includeNatal: boolean): void {
  const reading = presentZiweiPalaces(document.ziwei, targetYear);
  lines.push("### 逐宫合并阅读范围", ...reading.scope.map((line) => `- ${inline(line)}`), `> ${ZIWEI_PALACE_READING_NOTE}`);
  if (reading.boundary.length > 0) {
    lines.push("### 所选年份紫微交限说明", ...reading.boundary.map((line) => `- ${inline(line)}`));
  }
  lines.push(
    "### 宫位关系表",
    "> 地支固定于本命十二宫；对宫及两处三合宫均以地支回指本表。大限、流年列取上方所选代表盘；未选择或资料不完整时不补算。",
    "| 地支 | 本命宫 | 所选大限宫 | 所选流年宫 | 对宫 | 三合宫 |",
    "| --- | --- | --- | --- | --- | --- |"
  );
  for (const row of reading.relations) {
    lines.push(`| ${[row.earthlyBranch, row.natal, row.decadal ?? "未展开", row.yearly ?? "未展开", row.oppositeBranch, row.trineBranches.join("、")].map(inline).join(" | ")} |`);
  }
  lines.push("### 十二宫逐宫合并");
  for (const palace of reading.palaces) {
    lines.push(
      `### ${inline(palace.name)} · ${inline(palace.ganZhi)}`,
      field("身宫", palace.isBodyPalace), field("来因宫", palace.isOriginalPalace),
      field("宫位关系", palace.identity)
    );
    for (const layer of palace.layers.filter((item) => includeNatal || item.key !== "natal")) {
      lines.push(`#### ${inline(layer.title)}`, ...layer.fields.map((item) => field(item.label, item.value)));
    }
    if (includeNatal) lines.push(...palace.details.map((item) => field(item.label, item.value)));
  }
  if (reading.unresolved.length > 0) {
    lines.push("### 未定位四化说明", ...reading.unresolved.map((item) => field(item.label, item.value)));
  }

}

export function chartDocumentTextFilename(jsonFilename: string): string {
  if (jsonFilename !== "排盘.json" && !/^bazi-ziwei-chart-\d{8}-\d{4}\.json$/u.test(jsonFilename)) {
    throw new Error("ChartDocument JSON 文件名无效");
  }
  return jsonFilename.replace(/\.json$/u, ".txt");
}

/** Render saved fields only; selecting years never runs a chart calculation. */
export function presentChartDocumentText(
  document: ChartDocumentV1,
  jsonFilename = "排盘.json",
  requestedYears?: readonly number[]
): ChartDocumentTextView {
  const years = [...new Set(requestedYears ?? (document.targetYear === undefined ? [] : [document.targetYear]))]
    .sort((left, right) => left - right);
  const lines: string[] = [
    "# 八字与紫微斗数双轨排盘",
    "## 输入资料",
    field("姓名或别名", document.subject.nameOrAlias),
    field("性别", document.subject.gender),
    field("历法类型", document.birthInput.calendar.type === "solar" ? "公历" : "农历"),
    field("日期", document.birthInput.calendar.date),
    field("闰月", document.birthInput.calendar.leapMonth),
    field("提供时间", document.birthInput.providedTime.localTime),
    field("时间口径", PROVIDED_TIME_PRESENTATION[document.birthInput.providedTime.basis].label),
    field("时间处理", PROVIDED_TIME_PRESENTATION[document.birthInput.providedTime.basis].statement),
    field("时间精度", { minute: "提供到分钟（用户声明）", approximate: "约略时间", branch: "仅知时辰区间" }[document.birthInput.providedTime.precision]),
    field("晚子时换日规则", { candidates: "保留当日与次日候选", current_day: "按当日", next_day: "按次日" }[document.birthInput.policy.lateZi]),
    field("本文件候选", document.selection.candidateId),
    field("存在其他候选", document.selection.hadAlternatives),
    ...(document.selection.rationale === null ? [] : [field("选择说明", document.selection.rationale)]),
    ...inputNotes(document),
    ...textScope(document, years),
    "## 文档信息",
    field("计算器版本", document.calculatorVersion),
    ...(document.exportSourceId === undefined ? [] : [field("JSON 导出源码标识", document.exportSourceId)]),
    field("本次文本呈现源码标识", CURRENT_SOURCE_ID),
    field("导出时间", document.exportedAt)
  ];
  appendBaziNatal(lines, document);
  // A single year keeps the familiar three-layer palace layout. In a multi-year
  // document, natal stars appear once before the yearly overlays.
  if (years.length === 1) {
    lines.push("### 目标流年与流月（仅在存在时）");
    appendBaziYear(lines, document, years[0]);
  }
  appendZiweiNatal(lines, document);
  appendZiweiPalaces(lines, document, years.length === 1 ? years[0] : undefined, true);
  for (const year of years) {
    if (years.length > 1) lines.push(`## ${year} 年度`);
    const missing = [
      ...(document.bazi.chart.annualFortunes.some((item) => item.year === year) ? [] : ["八字流年"]),
      ...(document.bazi.detail.candidate.annualDetails.some((item) => item.year === year) ? [] : ["八字流月与小运"]),
      ...((document.ziwei.yearlyFortunes ?? []).some((item) => item.targetYear === year) ? [] : ["紫微年度盘"])
    ];
    if (missing.length > 0) lines.push(field("资料缺口", `${year} 年未保存${missing.join("、")}；可用原始输入补算。`));
    if (years.length > 1) {
      appendBaziYear(lines, document, year);
      lines.push("### 紫微年度同宫分层（本命星曜见前文同一地支宫）");
      appendZiweiPalaces(lines, document, year, false);
    }
  }
  return {
    title: "八字与紫微斗数双轨排盘",
    filename: chartDocumentTextFilename(jsonFilename),
    contentType: CHART_DOCUMENT_TEXT_CONTENT_TYPE,
    plainText: lines.join("\n") + "\n"
  };
}
