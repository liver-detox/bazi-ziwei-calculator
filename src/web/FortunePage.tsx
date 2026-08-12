import type { BaziGanZhiRelationsV1 } from "../core/charts/bazi-detail-contract.js";
import { GanZhiText } from "./five-elements.js";
import {
  presentResults,
  selectDaYun,
  selectLiuYue,
  type ResultSelection,
  type ResultSnapshotInput,
  type TargetYearPage
} from "./results-model.js";
import { TargetYearControl } from "./TargetYearControl.js";

export { FortuneYearSearch } from "./TargetYearControl.js";

export interface FortunePageProps {
  snapshot: ResultSnapshotInput;
  selection: ResultSelection;
  onSelectionChange: (selection: ResultSelection) => void;
  onAddTargetYear?: (year: number, page: TargetYearPage) => void;
  onRemoveTargetYear?: (year: number, page: TargetYearPage) => void;
  isNarrow: boolean;
}

function minuteDisplay(engineDateTime: string): string {
  const secondsSeparator = engineDateTime.lastIndexOf(":");
  return secondsSeparator < 0 ? engineDateTime : engineDateTime.substring(0, secondsSeparator);
}

function Relations({ relations }: { relations: BaziGanZhiRelationsV1 }) {
  return (
    <dl className="relation-grid">
      <div><dt>天干十神</dt><dd>{relations.stemTenGod}</dd></div>
      <div><dt>主气十神</dt><dd>{relations.branchMainQiTenGod}</dd></div>
      <div><dt>藏干及副星</dt><dd>{relations.hiddenStems.map((stem, index) => <span className="relation-pair" key={`${stem}-${index}`}><GanZhiText text={stem} /> {relations.hiddenStemTenGods[index]}</span>)}</dd></div>
      <div><dt>十二长生</dt><dd>{relations.growthStage}</dd></div>
      <div><dt>纳音</dt><dd>{relations.naYin}</dd></div>
    </dl>
  );
}

function EngineBoundary({ label, value }: { label: string; value: string }) {
  return (
    <div className="engine-boundary">
      <span>{label}</span>
      <details><summary>{minuteDisplay(value)}</summary><span>{value}</span></details>
    </div>
  );
}

export function FortunePage({
  snapshot,
  selection,
  onSelectionChange,
  onAddTargetYear,
  onRemoveTargetYear,
  isNarrow
}: FortunePageProps) {
  const presentation = presentResults(snapshot, selection);
  const chart = presentation.chart.bazi;
  const selectedMonth = presentation.annual?.detail?.liuYue.find(({ ordinal }) => ordinal === selection.selectedLiuYueOrdinal) ?? null;

  return (
    <section className="result-page fortune-page" aria-labelledby="fortune-title">
      <div className="result-page-heading">
        <div><p className="eyebrow">已保存运限</p><h2 id="fortune-title">大运流年</h2></div>
        <p>选择状态只用于查看，不按系统年份推断。</p>
      </div>

      <section className="result-subsection" aria-labelledby="fortune-dayun-title">
        <div className="result-subsection-heading"><h3 id="fortune-dayun-title">全部大运</h3><span>{chart.luck.forward ? "顺排" : "逆排"}</span></div>
        <div className="bounded-strip fortune-dayun-strip" role="region" aria-label="大运切换，可横向滚动" tabIndex={0}>
          {chart.luck.daYun.map((period) => (
            <button
              className={period.index === selection.viewingDaYunIndex ? "selected" : undefined}
              data-dayun-index={period.index}
              aria-current={period.index === selection.viewingDaYunIndex ? "true" : undefined}
              key={period.index}
              type="button"
              onClick={() => onSelectionChange(selectDaYun(selection, snapshot, period.index))}
            >
              <span>{period.index === selection.viewingDaYunIndex ? "正在查看" : `第 ${period.index} 段`}</span>
              <strong>{period.ganZhi === null ? "起运前" : <GanZhiText text={period.ganZhi} />}</strong>
              <small>虚岁 {period.startAge}–{period.endAge}</small>
              <small>{period.startYear}–{period.endYear}</small>
              <small>{period.xun === null ? "旬空未生成" : `${period.xun}旬 · 空亡 ${period.voidBranches}`}</small>
            </button>
          ))}
        </div>
      </section>

      <TargetYearControl isNarrow={isNarrow} onAddTargetYear={onAddTargetYear} onRemoveTargetYear={onRemoveTargetYear} onSelectionChange={onSelectionChange} page="fortune" selection={selection} snapshot={snapshot} />

      {presentation.annual === null ? (
        <p className="result-inline-empty">该大运尚未添加目标流年</p>
      ) : (
        <>
          <article className="annual-detail">
            <div className="result-subsection-heading">
              <div><span>已选流年</span><h3>{presentation.annual.base.year} 年 · 虚岁 {presentation.annual.base.age}</h3></div>
            </div>
            <div className="fortune-ganzhi-line"><GanZhiText text={presentation.annual.base.ganZhi} /><span>所属大运第 {presentation.annual.base.daYunIndex} 段</span><span>{presentation.annual.base.xun}旬 · 空亡 {presentation.annual.base.voidBranches}</span></div>
            {presentation.annual.detail && <Relations relations={presentation.annual.detail.relations} />}
          </article>

          {presentation.annual.detail && (
            <article className="xiaoyun-detail">
              <div className="result-subsection-heading"><h3>小运</h3><span>{presentation.annual.detail.xiaoYun.year} 年 · 虚岁 {presentation.annual.detail.xiaoYun.virtualAge}</span></div>
              <div className="fortune-ganzhi-line"><GanZhiText text={presentation.annual.detail.xiaoYun.ganZhi} /><span>{presentation.annual.detail.xiaoYun.xun}旬 · 空亡 {presentation.annual.detail.xiaoYun.voidBranches}</span></div>
              <Relations relations={presentation.annual.detail.xiaoYun.relations} />
            </article>
          )}

          {presentation.annual.detail && (
            <section className="liuyue-section" aria-labelledby="liuyue-title">
              <div className="result-subsection-heading"><h3 id="liuyue-title">十二流月</h3><span>按节气分月</span></div>
              <div className="liuyue-strip" aria-label="十二流月" role="region" tabIndex={0}>
                {presentation.annual.liuYueChoices.map((month) => (
                  <button
                    data-liuyue-ordinal={month.ordinal}
                    aria-current={month.ariaCurrent}
                    className={month.ariaCurrent ? "selected" : undefined}
                    key={month.ordinal}
                    type="button"
                    onClick={() => onSelectionChange(selectLiuYue(selection, month.ordinal))}
                  >
                    <span>{month.ordinal}</span><strong>{month.text}</strong><GanZhiText text={month.detail.ganZhi} />
                    {month.ariaCurrent && <small>已选流月</small>}
                  </button>
                ))}
              </div>
              {selectedMonth && (
                <article className="liuyue-detail">
                  <h3>{selectedMonth.monthName}详项</h3>
                  <p className="selection-state-text">已选流月 · 第 {selectedMonth.ordinal} 月</p>
                  <div className="fortune-ganzhi-line"><GanZhiText text={selectedMonth.ganZhi} /><span>{selectedMonth.xun}旬 · 空亡 {selectedMonth.voidBranches}</span></div>
                  <p className="engine-time-label">排盘引擎节气表时间</p>
                  <div className="boundary-grid">
                    <EngineBoundary label={`${selectedMonth.interval.start.name}起`} value={selectedMonth.interval.start.engineDateTime} />
                    <EngineBoundary label={`${selectedMonth.interval.end.name}止（不含）`} value={selectedMonth.interval.end.engineDateTime} />
                  </div>
                  <Relations relations={selectedMonth.relations} />
                </article>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
