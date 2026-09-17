import type { NormalizedZiweiStar, ZiweiChartV1, ZiweiHoroscopeItem } from "../core/charts/types.js";
import { resolveZiweiYearlyOverlay, ziweiHoroscopeTransformations, ziweiPalaceRelations } from "./chart-display.js";
import { ziweiDecadalBoundaryText, ziweiDecadalYearBoundary } from "./ziwei-decadal-boundary.js";

export const ZIWEI_PALACE_READING_NOTE = "本命主辅星与大限、流年附加星曜分层列示；空列表只说明该字段范围内未列星曜，不表示整宫无星。四化按本命星曜所在固定宫位归组，不表示新增星曜，也不补算飞化、自化或杂曜。";
export const ZIWEI_OVERLAY_UNAVAILABLE = "所选年度合并资料不可用：代表日期、年份或十二宫资料缺失、不唯一或未对齐；仅保留本命，不补拼年度星曜。";
export const ZIWEI_NATAL_UNAVAILABLE = "本命十二宫索引不完整或未对齐，逐宫展示不可用；原始记录保留在 JSON。";

export interface ZiweiReadingField { label: string; value: string }
export interface ZiweiReadingLayer {
  key: "natal" | "decadal" | "yearly";
  title: string;
  fields: ZiweiReadingField[];
}
interface TransformationProjection {
  items: Array<{ transformation: string; starName: string; palaceIndex: number | null }>;
  complete: boolean;
  note: string | null;
}

function starList(stars: NormalizedZiweiStar[] | null | undefined, empty: string): string {
  if (!Array.isArray(stars)) return "未提供（本字段缺失）";
  return stars.length === 0 ? empty : stars.map((star) => (
    `${star.name}（庙旺：${star.brightness === undefined ? "未提供" : star.brightness ?? "未标注"}）`
  )).join("；");
}

function natalTransformations(chart: ZiweiChartV1): TransformationProjection {
  const stored = Array.isArray(chart.transformations) ? chart.transformations : [];
  const completeStars = chart.palaces.every((palace) => Array.isArray(palace.majorStars) && Array.isArray(palace.minorStars));
  const stars = chart.palaces.flatMap((palace) => [...(palace.majorStars ?? []), ...(palace.minorStars ?? [])].map((star) => ({ palace, star })));
  const fieldsComplete = completeStars && stars.every(({ star }) => star.transformation === null || ["禄", "权", "科", "忌"].includes(star.transformation));
  const recorded = stars.filter(({ star }) => star.transformation !== null);
  const consistent = fieldsComplete && stored.length === 4 && recorded.length === 4
    && new Set(stored.map(({ transformation }) => transformation)).size === 4
    && stored.every((item) => {
      const matches = stars.filter(({ star }) => star.name === item.starName);
      return matches.length === 1 && matches[0].palace.index === item.palaceIndex
        && matches[0].palace.name === item.palaceName && matches[0].star.transformation === item.transformation;
    });
  return {
    items: stored.map((item) => ({ transformation: item.transformation, starName: item.starName, palaceIndex: consistent ? item.palaceIndex : null })),
    complete: consistent,
    note: consistent ? null : !fieldsComplete || !Array.isArray(chart.transformations)
      ? "生年四化资料未完整提供；不将缺失当作无四化。"
      : "生年四化汇总与本命星曜字段不一致；不自动归宫，原始记录保留在 JSON。"
  };
}

function overlayTransformations(chart: ZiweiChartV1, item: ZiweiHoroscopeItem): TransformationProjection {
  const items = ziweiHoroscopeTransformations(chart, item).map((row) => ({
    transformation: row.transformation, starName: row.starName ?? "未提供", palaceIndex: row.natalPalace?.index ?? null
  }));
  return { items, complete: items.every(({ palaceIndex }) => palaceIndex !== null), note: null };
}

function transformationField(projection: TransformationProjection, index: number, label: string): ZiweiReadingField {
  const items = projection.items.filter(({ palaceIndex }) => palaceIndex === index);
  return {
    label,
    value: items.length > 0 ? items.map(({ transformation, starName }) => `${transformation}：${starName}`).join("；")
      : projection.complete ? "本宫未列该层四化"
        : "归宫资料不完整，见未定位四化说明"
  };
}

/** The sole per-palace reading projection for the page, AI/TXT and print. Raw chart fields stay unchanged. */
export function presentZiweiPalaces(chart: ZiweiChartV1, selectedYear?: number | null) {
  const selected = selectedYear !== undefined && selectedYear !== null;
  const aligned = chart.palaces.length === 12 && chart.palaces.every((palace, index) => palace.index === index);
  const resolved = resolveZiweiYearlyOverlay(chart, selectedYear);
  const overlay = resolved?.targetDate === `${selectedYear}-07-01` ? resolved : null;
  const decadalLabel = overlay?.decadal.name === "童限" ? "童限" : "大限";
  const status = !aligned ? "unavailable" : !selected ? "natal" : overlay === null ? "unavailable" : "available";
  const birth = natalTransformations(chart);
  const decadal = overlay === null ? null : overlayTransformations(chart, overlay.decadal);
  const yearly = overlay === null ? null : overlayTransformations(chart, overlay.yearly);
  const relations = aligned ? ziweiPalaceRelations(chart, overlay).map((row) => ({
    ...row,
    oppositeBranch: chart.palaces[row.oppositeIndex].earthlyBranch,
    trineBranches: row.trineIndexes.map((index) => chart.palaces[index].earthlyBranch)
  })) : [];
  const unresolved: ZiweiReadingField[] = [];
  for (const [label, projection] of [["生年四化", birth], [`${decadalLabel}四化`, decadal], ["流年四化", yearly]] as const) {
    if (projection === null) continue;
    if (projection.note) unresolved.push({ label, value: projection.note });
    for (const item of projection.items.filter(({ palaceIndex }) => palaceIndex === null)) {
      unresolved.push({ label, value: `${item.transformation}：${item.starName}；未能在本文件所列主辅星中唯一确认本命落宫` });
    }
  }
  const palaceName = (index: number) => {
    const palace = chart.palaces[index];
    return `本命${palace.name.endsWith("宫") ? palace.name : `${palace.name}宫`} · ${palace.earthlyBranch}`;
  };
  const scope = !aligned ? [ZIWEI_NATAL_UNAVAILABLE] : !selected ? ["当前仅显示本命；未展开大限、流年代表盘。"] : overlay === null
    ? [`所选年度：${selectedYear}。`, ZIWEI_OVERLAY_UNAVAILABLE]
    : [
      `所选年度：${selectedYear}；年度代表盘日期：${overlay.targetDate}（7 月 1 日取样，不表示全年任意日期）。`,
      `代表盘农历：${overlay.lunarDate}；${overlay.decadal.name}：${overlay.decadal.heavenlyStem}${overlay.decadal.earthlyBranch}（命宫对应${palaceName(overlay.decadal.index)}）；流年：${overlay.yearly.heavenlyStem}${overlay.yearly.earthlyBranch}（命宫对应${palaceName(overlay.yearly.index)}）。`
    ];
  return {
    status, overlay, scope, unresolved, relations,
    boundary: selected ? ziweiDecadalBoundaryText(ziweiDecadalYearBoundary(chart, selectedYear)) : [],
    palaces: (aligned ? chart.palaces : []).map((palace, index) => {
      const layers: ZiweiReadingLayer[] = [{
        key: "natal", title: `本命 · ${palace.name}`,
        fields: [
          { label: "主星", value: starList(palace.majorStars, "无十四主星") },
          { label: "辅星", value: starList(palace.minorStars, "无本字段所列辅星") },
          transformationField(birth, palace.index, "生年四化")
        ]
      }];
      if (overlay !== null && decadal !== null && yearly !== null) {
        for (const [key, title, item, projection] of [
          ["decadal", decadalLabel, overlay.decadal, decadal], ["yearly", "流年", overlay.yearly, yearly]
        ] as const) {
          layers.push({
            key, title: `${title} · ${item.palaceNames[palace.index]}`,
            fields: [
              { label: "附加星曜", value: starList(item.starsByPalace[palace.index], "无本层附加星曜（本字段所列范围）") },
              transformationField(projection, palace.index, `${title}四化`)
            ]
          });
        }
      }
      return {
        index: palace.index, name: palace.name, ganZhi: `${palace.heavenlyStem}${palace.earthlyBranch}`,
        earthlyBranch: palace.earthlyBranch, isBodyPalace: palace.isBodyPalace, isOriginalPalace: palace.isOriginalPalace,
        relation: relations[index], layers,
        identity: `${palace.earthlyBranch}宫 · 对宫 ${relations[index].oppositeBranch} · 三合 ${relations[index].trineBranches.join("、")}`,
        details: [
          { label: "十二长生", value: palace.changsheng12 },
          { label: "本命大限范围", value: `${palace.decadal.heavenlyStem}${palace.decadal.earthlyBranch} · ${palace.decadal.startAge}–${palace.decadal.endAge} 虚岁` },
          { label: "对应虚岁", value: palace.ages.join("、") }
        ]
      };
    })
  };
}
