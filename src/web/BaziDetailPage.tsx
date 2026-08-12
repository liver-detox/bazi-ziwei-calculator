import type { BaziDaYunDetailV1 } from "../core/charts/bazi-detail-contract.js";
import type { BaziDaYun, BaziPillar } from "../core/charts/types.js";
import { GanZhiText, NaYinText } from "./five-elements.js";
import type { ResultPresentation } from "./results-model.js";

export interface BaziDetailPageProps {
  presentation: ResultPresentation;
  onRecoverDetail?: () => void;
}

const PILLAR_LABELS = ["年柱", "月柱", "日柱（日主）", "时柱"] as const;
const ROW_LABELS = ["主星", "天干", "地支", "藏干", "副星", "星运", "旬", "空亡", "纳音"] as const;

function recoveryCopy(capability: ResultPresentation["baziDetail"] & { availability: "unavailable" }) {
  switch (capability.capability.status) {
    case "retryable_failure":
      return { explanation: "八字详盘暂时没有生成", action: "重新生成" };
    case "reconfirm_required":
      return { explanation: "这份旧排盘暂不包含八字详盘", action: "重新确认最终排盘时间" };
    case "can_generate":
      return { explanation: "这份旧排盘暂不包含八字详盘", action: "生成八字详盘" };
    case "ready":
      return { explanation: "八字详盘暂时没有生成", action: "重新生成" };
  }
}

function pillarValues(chart: ResultPresentation["chart"]): BaziPillar[] {
  return [chart.bazi.pillars.year, chart.bazi.pillars.month, chart.bazi.pillars.day, chart.bazi.pillars.time];
}

function exactDaYunDetail(
  details: readonly BaziDaYunDetailV1[],
  index: number
): BaziDaYunDetailV1 {
  const matches = details.filter((detail) => detail.index === index);
  if (matches.length !== 1) throw new Error(`DAYUN_DETAIL_JOIN_${matches.length === 0 ? "MISSING" : "DUPLICATE"}:${index}`);
  return matches[0];
}

export function baziDetailDisplayedDaYun(periods: readonly BaziDaYun[]): BaziDaYun[] {
  const displayed: BaziDaYun[] = [];
  let formalCount = 0;
  for (const period of periods) {
    if (period.index === 0) {
      displayed.push(period);
    } else if (formalCount < 10) {
      displayed.push(period);
      formalCount += 1;
    }
  }
  return displayed;
}

function PillarCell({ pillar, row, isDay }: { pillar: BaziPillar; row: typeof ROW_LABELS[number]; isDay: boolean }) {
  switch (row) {
    case "主星":
      return <td className={isDay ? "day-master-cell" : undefined}>{isDay ? "日主" : pillar.stemTenGod}</td>;
    case "天干":
      return <td><GanZhiText className="bazi-primary-ganzhi" text={pillar.heavenlyStem} /></td>;
    case "地支":
      return <td><GanZhiText className="bazi-primary-ganzhi" text={pillar.earthlyBranch} /></td>;
    case "藏干":
      return <td><ul className="stacked-values">{pillar.hiddenStems.map((stem, index) => <li key={`${stem}-${index}`}><GanZhiText text={stem} /></li>)}</ul></td>;
    case "副星":
      return <td><ul className="stacked-values">{pillar.hiddenStemTenGods.map((tenGod, index) => <li key={`${tenGod}-${index}`}>{tenGod}</li>)}</ul></td>;
    case "星运":
      return <td>{pillar.growthStage}</td>;
    case "旬":
      return <td><GanZhiText text={pillar.xun} /></td>;
    case "空亡":
      return <td><GanZhiText text={pillar.voidBranches} /></td>;
    case "纳音":
      return <td><NaYinText text={pillar.naYin} /></td>;
  }
}

export function BaziDetailPage({ presentation, onRecoverDetail }: BaziDetailPageProps) {
  if (presentation.baziDetail.availability === "unavailable") {
    const copy = recoveryCopy(presentation.baziDetail);
    return (
      <section className="result-page result-empty-state" aria-labelledby="bazi-detail-title">
        <p className="eyebrow">八字详盘</p>
        <h2 id="bazi-detail-title">{copy.explanation}</h2>
        <p>基础双盘仍可查看；完成此操作后会生成可核对的完整八字详项。</p>
        <button className="button primary" type="button" onClick={onRecoverDetail}>{copy.action}</button>
      </section>
    );
  }

  const chart = presentation.chart.bazi;
  const detail = presentation.baziDetail.candidate;
  const pillars = pillarValues(presentation.chart);
  const auxiliary = [
    ["胎元", detail.auxiliaryPillars.taiYuan],
    ["胎息", detail.auxiliaryPillars.taiXi],
    ["八字命宫", detail.auxiliaryPillars.baziMingGong],
    ["八字身宫", detail.auxiliaryPillars.baziShenGong]
  ] as const;

  return (
    <section className="result-page bazi-detail-page" aria-labelledby="bazi-detail-title">
      <div className="result-page-heading">
        <div><p className="eyebrow">完整四柱</p><h2 id="bazi-detail-title">八字详盘</h2></div>
        <p>藏干与副星逐项对应；星运按日主观察各柱地支。</p>
      </div>

      <div className="bazi-table-scroller" role="region" aria-label="八字四柱详盘表，可横向滚动" tabIndex={0}>
        <table className="bazi-detail-table">
          <thead><tr><th aria-label="字段" /><th scope="col">年柱</th><th scope="col">月柱</th><th scope="col">日柱（日主）</th><th scope="col">时柱</th></tr></thead>
          <tbody>
            {ROW_LABELS.map((row) => (
              <tr key={row}>
                <th scope="row">{row}</th>
                {pillars.map((pillar, index) => <PillarCell isDay={index === 2} key={PILLAR_LABELS[index]} pillar={pillar} row={row} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="result-subsection" aria-labelledby="bazi-auxiliary-title">
        <div className="result-subsection-heading"><h3 id="bazi-auxiliary-title">辅助信息</h3><span>干支及纳音</span></div>
        <dl className="auxiliary-grid">
          {auxiliary.map(([label, item]) => <div key={label}><dt>{label}</dt><dd><GanZhiText text={item.ganZhi} /><NaYinText text={item.naYin} /></dd></div>)}
        </dl>
      </section>

      <section className="result-subsection" aria-labelledby="bazi-dayun-title">
        <div className="result-subsection-heading"><h3 id="bazi-dayun-title">起运前与十段大运</h3><span>{chart.luck.forward ? "顺排" : "逆排"} · 底层仍完整保存全部运限</span></div>
        <div className="bounded-strip" role="region" aria-label="全部已保存大运，可横向滚动" tabIndex={0}>
          {baziDetailDisplayedDaYun(chart.luck.daYun).map((period) => {
            const joined = exactDaYunDetail(detail.daYunDetails, period.index);
            return (
              <article data-dayun-index={period.index} key={period.index}>
                <span>第 {period.index} 段</span>
                <strong>{period.ganZhi === null ? "起运前" : <GanZhiText text={period.ganZhi} />}</strong>
                <p>虚岁 {period.startAge}–{period.endAge}</p>
                <p>{period.startYear}–{period.endYear}</p>
                {joined.relations === null ? <small>关系项为空</small> : <small>{joined.relations.stemTenGod} · 主气十神 {joined.relations.branchMainQiTenGod}</small>}
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}
