import type { ChartDocumentV1 } from "../core/workbench/chart-document.js";

export const CHART_DOCUMENT_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8" as const;

export interface ChartDocumentTextView {
  title: "八字与紫微斗数双轨排盘";
  filename: string;
  contentType: typeof CHART_DOCUMENT_TEXT_CONTENT_TYPE;
  plainText: string;
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

function starText(star: {
  name: string;
  type: string;
  scope: string;
  brightness: string | null;
  transformation: string | null;
}): string {
  return [
    star.name,
    `类型 ${star.type}`,
    `范围 ${star.scope}`,
    `亮度 ${star.brightness ?? "未标注"}`,
    `四化 ${star.transformation ?? "无"}`
  ].map(inline).join("；");
}

function list(values: readonly unknown[]): string {
  return values.map(inline).join("、") || "未提供";
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

function horoscopeText(
  lines: string[],
  label: string,
  horoscope: ChartDocumentV1["ziwei"]["yearlyFortunes"][number]["decadal"]
): void {
  lines.push(`#### ${inline(label)}`);
  lines.push(
    field("索引", horoscope.index),
    field("名称", horoscope.name),
    field("干支", `${horoscope.heavenlyStem}${horoscope.earthlyBranch}`),
    field("宫位", list(horoscope.palaceNames)),
    field("四化", list(horoscope.transformations))
  );
  horoscope.starsByPalace.forEach((stars, index) => {
    lines.push(field(`${horoscope.palaceNames[index]}星曜`, stars.map(starText).join("；") || "未提供"));
  });
}

export function chartDocumentTextFilename(jsonFilename: string): string {
  if (!/^bazi-ziwei-chart-\d{8}-\d{4}\.json$/u.test(jsonFilename)) {
    throw new Error("ChartDocument JSON 文件名无效");
  }
  return jsonFilename.replace(/\.json$/u, ".txt");
}

export function presentChartDocumentText(
  document: ChartDocumentV1,
  jsonFilename: string
): ChartDocumentTextView {
  const lines: string[] = [
    "# 八字与紫微斗数双轨排盘",
    "> 这是排盘数据，不含命理解读；不得猜测缺失字段。",
    "## 文档信息",
    field("Schema 版本", document.schemaVersion),
    field("计算器版本", document.calculatorVersion),
    field("导出时间（交付元数据）", document.exportedAt),
    field("目标流年", document.targetYear),
    "## 输入资料",
    field("姓名或别名", document.subject.nameOrAlias),
    field("性别", document.subject.gender),
    field("历法类型", document.birthInput.calendar.type),
    field("日期", document.birthInput.calendar.date),
    field("闰月", document.birthInput.calendar.leapMonth),
    field("提供时间", document.birthInput.providedTime.localTime),
    field("时间口径", document.birthInput.providedTime.basis),
    field("时间精度", document.birthInput.providedTime.precision),
    field("时间来源类型", document.birthInput.providedTime.sourceType),
    field("子初换日规则", document.birthInput.policy.lateZi),
    "## 候选选择与警告",
    field("候选 ID", document.selection.candidateId),
    field("存在其他候选", document.selection.hadAlternatives),
    field("选择理由", document.selection.rationale)
  ];

  if (document.warnings.length === 0) {
    lines.push(field("警告", "未提供"));
  } else {
    document.warnings.forEach((warning, index) => lines.push(field(`警告 ${index + 1}`, warning)));
  }

  const { chart, detail } = document.bazi;
  lines.push(
    "## 八字",
    "### 计算口径与历法",
    field("基础盘规则版本", chart.rulesetVersion),
    field("基础盘引擎", `${chart.engine.name}@${chart.engine.version}`),
    field("柱法", chart.configuration.pillarSect),
    field("起运法", chart.configuration.luckSect),
    field("年界", chart.configuration.yearBoundary),
    field("月界", chart.configuration.monthBoundary),
    field("日界", chart.configuration.sourceDayBoundary),
    field("原始本地时间", chart.input.sourceLocalDateTime),
    field("计算本地时间", chart.input.calculationLocalDateTime),
    field("时间口径", chart.input.timeBasis),
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
    field("流年分界", detail.configuration.annualBoundary),
    field("流月分界", detail.configuration.monthBoundary),
    field("流月区间", detail.configuration.monthInterval),
    field("节气时间口径", detail.configuration.solarTermTimeBasis),
    field("计算精度", detail.configuration.calculationPrecision),
    field("主显示精度", detail.configuration.primaryDisplayPrecision),
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
    field("起运后年", chart.luck.startAfter.years),
    field("起运后月", chart.luck.startAfter.months),
    field("起运后日", chart.luck.startAfter.days),
    field("起运后时", chart.luck.startAfter.hours)
  );
  for (const fortune of chart.luck.daYun) {
    lines.push(
      `#### 大运 ${inline(fortune.index)}`,
      field("索引", fortune.index),
      field("起始虚岁", fortune.startAge),
      field("结束虚岁", fortune.endAge),
      field("起始年份", fortune.startYear),
      field("结束年份", fortune.endYear),
      field("干支", fortune.ganZhi),
      field("旬", fortune.xun),
      field("空亡", fortune.voidBranches)
    );
    const detailItem = detail.candidate.daYunDetails.find((item) => item.index === fortune.index);
    if (detailItem?.relations === null || fortune.index === 0) {
      lines.push(field("关系", "关系项未提供"));
    } else if (detailItem !== undefined) {
      ganZhiRelations(lines, detailItem.relations);
    } else {
      lines.push(field("关系", "未提供"));
    }
  }

  lines.push("### 目标流年与流月（仅在存在时）");
  if (document.targetYear === undefined) {
    lines.push(field("目标流年", "未提供"));
  } else {
    for (const annual of chart.annualFortunes.filter(({ year }) => year === document.targetYear)) {
      const annualDetail = detail.candidate.annualDetails.find((item) => item.year === annual.year);
      lines.push(
        `#### 流年 ${inline(annual.year)}`,
        field("年份", annual.year),
        field("虚岁", annual.age),
        field("干支", annual.ganZhi),
        field("旬", annual.xun),
        field("空亡", annual.voidBranches),
        field("大运索引", annual.daYunIndex)
      );
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
          field("区间语义", month.interval.semantics),
          field("干支", month.ganZhi),
          field("旬", month.xun),
          field("空亡", month.voidBranches)
        );
        ganZhiRelations(lines, month.relations);
      }
    }
  }

  const { ziwei } = document;
  lines.push(
    "## 紫微斗数",
    "### 计算口径与基本资料",
    field("规则版本", ziwei.rulesetVersion),
    field("引擎", `${ziwei.engine.name}@${ziwei.engine.version}`),
    field("算法", ziwei.configuration.algorithm),
    field("年限划分", ziwei.configuration.yearDivide),
    field("运限划分", ziwei.configuration.horoscopeDivide),
    field("年龄划分", ziwei.configuration.ageDivide),
    field("日界", ziwei.configuration.dayDivide),
    field("四化算法", ziwei.configuration.mutagens),
    field("亮度算法", ziwei.configuration.brightness),
    field("星盘类型", ziwei.configuration.astroType),
    field("闰月处理", ziwei.configuration.fixLeap),
    field("语言", ziwei.configuration.language),
    field("来源时辰索引", ziwei.configuration.sourceTimeIndex),
    field("计算时辰索引", ziwei.configuration.timeIndex),
    field("原始本地时间", ziwei.input.sourceLocalDateTime),
    field("计算本地时间", ziwei.input.calculationLocalDateTime),
    field("时间口径", ziwei.input.timeBasis),
    field("来源子时分段", ziwei.input.sourceZiSegment),
    field("来源日界", ziwei.input.sourceDayBoundary),
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
    field("五行局", ziwei.fiveElementsClass),
    "### 十二宫"
  );
  for (const palace of ziwei.palaces) {
    lines.push(
      `### ${inline(palace.name)}`,
      field("索引", palace.index),
      field("宫干", palace.heavenlyStem),
      field("宫支", palace.earthlyBranch),
      field("身宫", palace.isBodyPalace),
      field("来因宫", palace.isOriginalPalace),
      field("主星", palace.majorStars.map(starText).join("；") || "未提供"),
      field("辅星", palace.minorStars.map(starText).join("；") || "未提供"),
      field("十二长生", palace.changsheng12),
      field("大限起始虚岁", palace.decadal.startAge),
      field("大限结束虚岁", palace.decadal.endAge),
      field("大限天干", palace.decadal.heavenlyStem),
      field("大限地支", palace.decadal.earthlyBranch),
      field("年龄", list(palace.ages))
    );
  }

  lines.push("### 本命四化");
  for (const transformation of ziwei.transformations) {
    lines.push(
      field("宫位索引", transformation.palaceIndex),
      field("宫位", transformation.palaceName),
      field("星曜", transformation.starName),
      field("四化", transformation.transformation)
    );
  }

  lines.push("### 目标流年叠加（仅在存在时）");
  if (document.targetYear === undefined) {
    lines.push(field("目标流年", "未提供"));
  } else {
    for (const yearly of ziwei.yearlyFortunes.filter(({ targetYear }) => targetYear === document.targetYear)) {
      lines.push(
        `#### 流年 ${inline(yearly.targetYear)}`,
        field("目标日期", yearly.targetDate),
        field("公历", yearly.solarDate),
        field("农历", yearly.lunarDate)
      );
      horoscopeText(lines, "大限", yearly.decadal);
      horoscopeText(lines, "流年", yearly.yearly);
    }
  }

  lines.push("## 说明", "- 本文本仅投影 ChartDocument V1 的既有字段。", "");
  return {
    title: "八字与紫微斗数双轨排盘",
    filename: chartDocumentTextFilename(jsonFilename),
    contentType: CHART_DOCUMENT_TEXT_CONTENT_TYPE,
    plainText: lines.join("\n")
  };
}
