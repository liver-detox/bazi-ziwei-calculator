import { astro } from "iztro";

const EARTHLY_BRANCH_HOURS = [
  { index: 0, branch: "子", label: "子时", range: "23:00~01:00" },
  { index: 1, branch: "丑", label: "丑时", range: "01:00~03:00" },
  { index: 2, branch: "寅", label: "寅时", range: "03:00~05:00" },
  { index: 3, branch: "卯", label: "卯时", range: "05:00~07:00" },
  { index: 4, branch: "辰", label: "辰时", range: "07:00~09:00" },
  { index: 5, branch: "巳", label: "巳时", range: "09:00~11:00" },
  { index: 6, branch: "午", label: "午时", range: "11:00~13:00" },
  { index: 7, branch: "未", label: "未时", range: "13:00~15:00" },
  { index: 8, branch: "申", label: "申时", range: "15:00~17:00" },
  { index: 9, branch: "酉", label: "酉时", range: "17:00~19:00" },
  { index: 10, branch: "戌", label: "戌时", range: "19:00~21:00" },
  { index: 11, branch: "亥", label: "亥时", range: "21:00~23:00" }
] as const;

type LegacyCalendar = "solar" | "lunar";
type LegacyOutputFormat = "markdown" | "json";
type LegacyGender = "男" | "女";
type LegacyAstrolabe = ReturnType<typeof astro.bySolar>;

interface TrueSolarAdjustment {
  clockDate: string;
  clockTime: string;
  solarDate: string;
  solarTime: string;
  longitude: number;
  standardMeridian: number;
  dstOffsetMinutes: number;
  longitudeCorrectionMinutes: number;
  equationOfTimeMinutes: number;
  totalCorrectionMinutes: number;
}

interface LegacyChartArgs {
  calendar: LegacyCalendar;
  date: string | undefined;
  time: string | undefined;
  timeIndex: number | undefined;
  gender: string | undefined;
  name: string | undefined;
  leapMonth: boolean;
  fixLeap: boolean;
  trueSolar: boolean;
  longitude: number | undefined;
  standardMeridian: number;
  dstOffsetMinutes: number;
  language: string | undefined;
  format: LegacyOutputFormat | string;
  out: string | undefined;
  help?: boolean;
  clockDate?: string;
  clockTime?: string;
  originalDate?: string;
  trueSolarAdjustment?: TrueSolarAdjustment;
}

export interface LegacyZiweiChartOutput {
  kind: "chart" | "help";
  content: string;
  outPath: string;
}

export interface LegacyZiweiChartOptions {
  now?: Date;
}

function parseArgs(argv: readonly string[]): LegacyChartArgs {
  const args: LegacyChartArgs = {
    calendar: "solar",
    date: "",
    time: "",
    timeIndex: undefined,
    gender: "",
    name: "",
    leapMonth: false,
    fixLeap: true,
    trueSolar: false,
    longitude: undefined,
    standardMeridian: 120,
    dstOffsetMinutes: 0,
    language: "zh-CN",
    format: "markdown",
    out: ""
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const next = argv[i + 1];
    switch (item) {
      case "--solar":
        args.calendar = "solar";
        args.date = next;
        i += 1;
        break;
      case "--lunar":
        args.calendar = "lunar";
        args.date = next;
        i += 1;
        break;
      case "--time":
        args.time = next;
        i += 1;
        break;
      case "--time-index":
        args.timeIndex = Number(next);
        i += 1;
        break;
      case "--gender":
        args.gender = next;
        i += 1;
        break;
      case "--name":
        args.name = next;
        i += 1;
        break;
      case "--leap-month":
        args.leapMonth = true;
        break;
      case "--no-fix-leap":
        args.fixLeap = false;
        break;
      case "--true-solar":
        args.trueSolar = true;
        break;
      case "--longitude":
        args.longitude = Number(next);
        i += 1;
        break;
      case "--standard-meridian":
        args.standardMeridian = Number(next);
        i += 1;
        break;
      case "--dst-offset-minutes":
        args.dstOffsetMinutes = Number(next);
        i += 1;
        break;
      case "--language":
        args.language = next;
        i += 1;
        break;
      case "--format":
        args.format = next ?? "";
        i += 1;
        break;
      case "--out":
        args.out = next;
        i += 1;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`未知参数：${item}`);
    }
  }

  return args;
}

export function legacyZiweiChartUsage(): string {
  return `本地紫微排盘工具

用法：
  npm run chart -- --solar 2000-01-15 --time 12:00 --gender 女 --name DEMO-NORMAL

参数：
  --solar YYYY-MM-DD       使用公历生日
  --lunar YYYY-MM-DD       使用农历生日
  --time HH:mm             自动换算为十二时辰
  --time-index 0-11        直接指定时辰序号：0子、1丑、2寅 ... 11亥
  --gender 男|女           性别
  --name NAME              命主代号，可选
  --leap-month             农历闰月，仅 --lunar 时有效
  --no-fix-leap            关闭闰月修正
  --true-solar             使用真太阳时排盘，仅 --solar + --time 支持
  --longitude NUMBER       出生地经度，例如 120
  --standard-meridian NUM  标准时区中央经线，东八区默认 120
  --dst-offset-minutes N   夏令时修正分钟数；若钟表已拨快1小时，填 60
  --language zh-CN|zh-TW   输出语言，默认 zh-CN
  --format markdown|json   输出格式，默认 markdown
  --out FILE               写入文件，不给则直接打印
`;
}

function parseClockTime(timeText: string | undefined) {
  if (!timeText) return undefined;

  const match = /^(\d{1,2}):(\d{2})$/.exec(timeText);
  if (!match) {
    throw new Error("--time 必须使用 HH:mm 格式，例如 16:56");
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("--time 超出有效范围");
  }

  return { hour, minute, totalMinutes: hour * 60 + minute };
}

function parseTimeToIndex(timeText: string | undefined): number | undefined {
  const parsed = parseClockTime(timeText);
  if (!parsed) return undefined;
  const { hour } = parsed;

  if (hour === 23 || hour === 0) return 0;
  return Math.floor((hour + 1) / 2);
}

function formatTime(totalMinutes: number): string {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function addDays(dateText: string, days: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function dayOfYear(dateText: string): number {
  const [year, month, day] = dateText.split("-").map(Number);
  const current = Date.UTC(year, month - 1, day);
  const start = Date.UTC(year, 0, 1);
  return Math.floor((current - start) / 86400000) + 1;
}

function equationOfTimeMinutes(dateText: string, totalMinutes: number): number {
  const doy = dayOfYear(dateText);
  const hour = totalMinutes / 60;
  const gamma = (2 * Math.PI / 365) * (doy - 1 + (hour - 12) / 24);
  return 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );
}

function applyTrueSolarTime(args: LegacyChartArgs): void {
  if (!args.trueSolar) return;
  if (args.calendar !== "solar") {
    throw new Error("--true-solar 目前仅支持 --solar 日期");
  }
  if (!args.time) {
    throw new Error("--true-solar 需要同时提供 --time HH:mm");
  }
  if (!Number.isFinite(args.longitude)) {
    throw new Error("--true-solar 需要提供 --longitude");
  }
  if (!Number.isFinite(args.standardMeridian)) {
    throw new Error("--standard-meridian 必须是数字");
  }
  if (!Number.isFinite(args.dstOffsetMinutes)) {
    throw new Error("--dst-offset-minutes 必须是数字");
  }
  if (!args.date || args.longitude === undefined) {
    throw new Error("真太阳时输入不完整");
  }

  const parsed = parseClockTime(args.time);
  if (!parsed) {
    throw new Error("--true-solar 需要同时提供 --time HH:mm");
  }
  const baseMinutes = parsed.totalMinutes - args.dstOffsetMinutes;
  const longitudeCorrection = 4 * (args.longitude - args.standardMeridian);
  const equationOfTime = equationOfTimeMinutes(args.date, baseMinutes);
  const adjustedMinutes = baseMinutes + longitudeCorrection + equationOfTime;
  const dayDelta = Math.floor(adjustedMinutes / 1440);

  args.clockDate = args.date;
  args.clockTime = args.time;
  args.originalDate = args.date;
  args.date = addDays(args.date, dayDelta);
  args.time = formatTime(adjustedMinutes);
  args.timeIndex = parseTimeToIndex(args.time);
  args.trueSolarAdjustment = {
    clockDate: args.clockDate,
    clockTime: args.clockTime,
    solarDate: args.date,
    solarTime: args.time,
    longitude: args.longitude,
    standardMeridian: args.standardMeridian,
    dstOffsetMinutes: args.dstOffsetMinutes,
    longitudeCorrectionMinutes: Number(longitudeCorrection.toFixed(4)),
    equationOfTimeMinutes: Number(equationOfTime.toFixed(4)),
    totalCorrectionMinutes: Number((adjustedMinutes - parsed.totalMinutes).toFixed(4))
  };
}

function validateArgs(args: LegacyChartArgs): void {
  if (args.help) return;
  if (!args.date) throw new Error("请提供 --solar 或 --lunar 日期");
  if (!args.gender) throw new Error("请提供 --gender 男|女");
  if (!["男", "女"].includes(args.gender)) throw new Error("--gender 目前只接受 男 或 女");
  if (!["solar", "lunar"].includes(args.calendar)) throw new Error("calendar 参数异常");
  if (!["markdown", "json"].includes(args.format)) throw new Error("--format 只支持 markdown 或 json");

  applyTrueSolarTime(args);

  if (args.timeIndex === undefined) {
    args.timeIndex = parseTimeToIndex(args.time);
  }

  if (!Number.isInteger(args.timeIndex) || (args.timeIndex as number) < 0 || (args.timeIndex as number) > 11) {
    throw new Error("请提供 --time HH:mm 或 --time-index 0-11");
  }
}

function makeAstrolabe(args: LegacyChartArgs): LegacyAstrolabe {
  if (args.calendar === "solar") {
    return astro.bySolar(
      args.date as string,
      args.timeIndex as number,
      args.gender as LegacyGender,
      args.fixLeap,
      args.language as string
    );
  }

  return astro.byLunar(
    args.date as string,
    args.timeIndex as number,
    args.gender as LegacyGender,
    args.leapMonth,
    args.fixLeap,
    args.language as string
  );
}

type LegacyStar = LegacyAstrolabe["palaces"][number]["majorStars"][number];

function starNames(stars: readonly LegacyStar[] = []): string {
  return stars
    .map((star) => {
      const tags = [star.brightness, star.mutagen ? `化${star.mutagen}` : ""].filter(Boolean);
      return tags.length ? `${star.name}(${tags.join(",")})` : star.name;
    })
    .join("、") || "-";
}

function normalizeAstrolabe(astrolabe: LegacyAstrolabe, args: LegacyChartArgs, now: Date) {
  const palaces = astrolabe.palaces.map((palace, order) => ({
    order: palace.index ?? order,
    name: palace.name,
    isBodyPalace: palace.isBodyPalace,
    isOriginalPalace: palace.isOriginalPalace,
    heavenlyStem: palace.heavenlyStem,
    earthlyBranch: palace.earthlyBranch,
    majorStars: palace.majorStars,
    minorStars: palace.minorStars,
    adjectiveStars: palace.adjectiveStars,
    changsheng12: palace.changsheng12,
    boshi12: palace.boshi12,
    jiangqian12: palace.jiangqian12,
    suiqian12: palace.suiqian12,
    decadal: palace.decadal,
    ages: palace.ages
  }));

  return {
    schemaVersion: "1.0.0",
    meta: {
      name: args.name || "",
      inputCalendar: args.calendar,
      inputDate: args.originalDate || args.date,
      calculationDate: args.date,
      inputTime: args.time || "",
      inputTimeIndex: args.timeIndex,
      inputTimeBranch: EARTHLY_BRANCH_HOURS[args.timeIndex as number],
      gender: args.gender,
      leapMonth: args.leapMonth,
      fixLeap: args.fixLeap,
      trueSolar: args.trueSolar,
      trueSolarAdjustment: args.trueSolarAdjustment || null,
      language: args.language,
      generatedAt: now.toISOString(),
      engine: "iztro",
      engineVersion: "2.5.8"
    },
    chart: {
      solarDate: astrolabe.solarDate,
      lunarDate: astrolabe.lunarDate,
      chineseDate: astrolabe.chineseDate,
      time: astrolabe.time,
      timeRange: astrolabe.timeRange,
      sign: astrolabe.sign,
      zodiac: astrolabe.zodiac,
      earthlyBranchOfSoulPalace: astrolabe.earthlyBranchOfSoulPalace,
      earthlyBranchOfBodyPalace: astrolabe.earthlyBranchOfBodyPalace,
      soul: astrolabe.soul,
      body: astrolabe.body,
      fiveElementsClass: astrolabe.fiveElementsClass,
      palaces
    }
  };
}

type LegacyChartData = ReturnType<typeof normalizeAstrolabe>;

function toMarkdown(data: LegacyChartData): string {
  const { meta, chart } = data;
  const title = meta.name ? `${meta.name} 紫微斗数排盘` : "紫微斗数排盘";

  const palaceRows = chart.palaces.map((palace) => {
    const flags = [
      palace.isBodyPalace ? "身宫" : "",
      palace.isOriginalPalace ? "来因宫" : ""
    ].filter(Boolean).join(" / ") || "-";
    return [
      palace.name,
      `${palace.heavenlyStem}${palace.earthlyBranch}`,
      flags,
      starNames(palace.majorStars),
      starNames(palace.minorStars),
      starNames(palace.adjectiveStars),
      palace.decadal?.range
        ? `${palace.decadal.range.join("-")}（${palace.decadal.heavenlyStem}${palace.decadal.earthlyBranch}）`
        : "-"
    ].join(" | ");
  });

  return `# ${title}

> 本盘由本地工具生成，底层引擎为 iztro ${meta.engineVersion}。命理排盘存在流派差异，请以统一流派口径做后续研究。

## 基本信息

| 项目 | 内容 |
| --- | --- |
| 输入历法 | ${meta.inputCalendar === "solar" ? "公历" : "农历"} |
| 输入日期 | ${meta.inputDate} |
| 输入时间 | ${meta.inputTime || `${meta.inputTimeBranch.label}（time-index ${meta.inputTimeIndex}）`} |
${meta.trueSolarAdjustment ? `| 钟表时间 | ${meta.trueSolarAdjustment.clockDate} ${meta.trueSolarAdjustment.clockTime} |\n| 真太阳时 | ${meta.trueSolarAdjustment.solarDate} ${meta.trueSolarAdjustment.solarTime} |\n| 经度校正 | ${meta.trueSolarAdjustment.longitudeCorrectionMinutes} 分钟 |\n| 均时差 | ${meta.trueSolarAdjustment.equationOfTimeMinutes} 分钟 |\n| 总校正 | ${meta.trueSolarAdjustment.totalCorrectionMinutes} 分钟 |` : ""}
| 换算时辰 | ${chart.time}（${chart.timeRange}） |
| 性别 | ${meta.gender} |
| 公历 | ${chart.solarDate} |
| 农历 | ${chart.lunarDate} |
| 四柱 | ${chart.chineseDate} |
| 生肖/星座 | ${chart.zodiac} / ${chart.sign} |
| 命宫地支 | ${chart.earthlyBranchOfSoulPalace} |
| 身宫地支 | ${chart.earthlyBranchOfBodyPalace} |
| 命主/身主 | ${chart.soul} / ${chart.body} |
| 五行局 | ${chart.fiveElementsClass} |

## 十二宫

| 宫位 | 宫干支 | 标记 | 主星 | 辅星 | 杂曜 | 大限 |
| --- | --- | --- | --- | --- | --- | --- |
${palaceRows.map((row) => `| ${row} |`).join("\n")}

## 研究提示

- 若出生时间接近时辰交界，建议以真太阳时校正后重排，并保留双盘对照。
- 若要接入 Cyber Saga 报告，优先使用本文件的 JSON 输出作为结构化输入，避免从截图中手工抄录。
- 本工具只负责排盘数据，不直接给出医疗、法律、投资等高风险结论。
`;
}

export function createLegacyZiweiChartOutput(
  argv: readonly string[],
  options: LegacyZiweiChartOptions = {}
): LegacyZiweiChartOutput {
  const args = parseArgs(argv);
  if (args.help) {
    return { kind: "help", content: legacyZiweiChartUsage(), outPath: "" };
  }

  validateArgs(args);
  const astrolabe = makeAstrolabe(args);
  const data = normalizeAstrolabe(astrolabe, args, options.now ?? new Date());
  const content = args.format === "json" ? JSON.stringify(data, null, 2) : toMarkdown(data);
  return { kind: "chart", content, outPath: args.out || "" };
}
