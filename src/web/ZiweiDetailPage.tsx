import { presentZiweiPalaces, ZIWEI_PALACE_READING_NOTE } from "../shared/ziwei-palace-presentation.js";
import { GanZhiText } from "./five-elements.js";
import {
  presentResults,
  selectZiweiMode,
  type ResultSelection,
  type ResultSnapshotInput,
  type TargetYearPage
} from "./results-model.js";
import { TargetYearControl } from "./TargetYearControl.js";
import { getPalaceGridPosition } from "./workbench-model.js";

export interface ZiweiDetailPageProps {
  snapshot: ResultSnapshotInput;
  selection: ResultSelection;
  onSelectionChange: (selection: ResultSelection) => void;
  onAddTargetYear?: (year: number, page: TargetYearPage) => void;
  onAddTargetYearRange?: (years: readonly number[], page: TargetYearPage) => void;
  onRemoveTargetYear?: (year: number, page: TargetYearPage) => void;
  isNarrow?: boolean;
}

export function ZiweiDetailPage({ snapshot, selection, onSelectionChange, onAddTargetYear, onAddTargetYearRange, onRemoveTargetYear, isNarrow = false }: ZiweiDetailPageProps) {
  const presentation = presentResults(snapshot, selection);
  const chart = presentation.chart.ziwei;
  const fortunes = [...(chart.yearlyFortunes ?? [])].sort((left, right) => left.targetYear - right.targetYear);
  const reading = presentZiweiPalaces(chart, selection.ziweiMode === "natal" ? undefined : selection.selectedTargetYear);
  const overlay = reading.overlay;

  return (
    <section className="result-page ziwei-detail-page" aria-labelledby="ziwei-detail-title">
      <div className="result-page-heading">
        <div><p className="eyebrow">十二宫全盘</p><h2 id="ziwei-detail-title">紫微详盘</h2></div>
        <p>本命空间位置固定；所选年份只叠加已保存的运限资料。</p>
      </div>

      <TargetYearControl isNarrow={isNarrow} onAddTargetYear={onAddTargetYear} onAddTargetYearRange={onAddTargetYearRange} onRemoveTargetYear={onRemoveTargetYear} onSelectionChange={onSelectionChange} page="ziwei" selection={selection} snapshot={snapshot} />

      {fortunes.length > 0 && (
        <nav className="ziwei-mode-tabs" aria-label="紫微盘模式">
          <button aria-current={selection.ziweiMode === "natal" ? "page" : undefined} className={selection.ziweiMode === "natal" ? "selected" : undefined} type="button" onClick={() => onSelectionChange(selectZiweiMode(selection, "natal"))}>本命</button>
          {selection.selectedTargetYear !== null && (
            <button
              aria-current={selection.ziweiMode === "yearly" ? "page" : undefined}
              className={selection.ziweiMode === "yearly" ? "selected" : undefined}
              type="button"
              onClick={() => onSelectionChange(selectZiweiMode(selection, "yearly"))}
            >流年盘 · {selection.selectedTargetYear}</button>
          )}
        </nav>
      )}

      <section className="ziwei-reading-scope" aria-label="逐宫合并阅读范围">
        {reading.scope.map((line) => <p key={line}>{line}</p>)}
        <p className="muted">{ZIWEI_PALACE_READING_NOTE}</p>
      </section>
      {reading.status === "unavailable" && <p className="result-empty-state" role="status">{reading.palaces.length > 0 ? "所选流年紫微详盘暂不可用；下方保留本命资料。" : "紫微逐宫展示暂不可用。"}</p>}
      {reading.boundary.length > 0 && <section className="engine-time-label" aria-label="所选年份紫微交限说明">{reading.boundary.map((line) => <p key={line}>{line}</p>)}</section>}

      <div className="ziwei-detail-board">
        {reading.palaces.map((palace) => {
          const position = getPalaceGridPosition(palace.index);
          return (
            <article
              className={`ziwei-detail-palace ${palace.name === "命宫" ? "soul-palace" : ""}`}
              data-palace-index={palace.index}
              data-palace-position={`${position.row}:${position.column}`}
              key={`${palace.index}-${palace.name}`}
              style={{ gridRow: position.row, gridColumn: position.column }}
            >
              <header>
                <div><strong>{palace.name}</strong><GanZhiText text={palace.ganZhi} /></div>
                <div className="palace-markers">
                  {palace.name === "命宫" && <span>命宫</span>}
                  {palace.isBodyPalace && <span>身宫</span>}
                  {palace.isOriginalPalace && <span>原宫</span>}
                </div>
              </header>
              <p className="palace-identity">{palace.identity}</p>
              {palace.layers.map((layer) => (
                <section className={`palace-reading-layer palace-reading-${layer.key}`} data-reading-layer={layer.key} key={layer.key}>
                  <h4>{layer.title}</h4>
                  <dl>{layer.fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
                </section>
              ))}
              <dl className="palace-cycle-details">
                {palace.details.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
              </dl>
            </article>
          );
        })}

        <section className="ziwei-detail-center" aria-label="紫微本命中心资料">
          <span>规范出生时间 {chart.input.calculationLocalDateTime.replace("T", " ")}</span>
          <span>公历 {chart.solarDate}</span>
          <span>农历 {chart.lunarDate}</span>
          <strong>{chart.fiveElementsClass}</strong>
          <p>五行局 · {chart.fiveElementsClass}</p>
          <p>命主 {chart.soul} · 身主 {chart.body}</p>
          <p>命宫 {chart.soulPalaceBranch} · 身宫 {chart.bodyPalaceBranch}</p>
          <small>当前候选口径 {presentation.chart.basis}</small>
          {overlay && <><span>所选流年 {overlay.targetYear}</span><span>{overlay.solarDate} · {overlay.lunarDate}</span></>}
        </section>
      </div>

      {reading.unresolved.length > 0 && <section className="ziwei-unresolved" aria-label="未定位四化说明">
        <h3>未定位四化说明</h3>
        {reading.unresolved.map((field, index) => <p key={index}>{field.label}：{field.value}</p>)}
      </section>}
    </section>
  );
}
