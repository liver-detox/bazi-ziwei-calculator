import type { NormalizedZiweiStar, ZiweiHoroscopeItem, ZiweiYearlyFortune } from "../core/charts/types.js";
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
  onRemoveTargetYear?: (year: number, page: TargetYearPage) => void;
  isNarrow?: boolean;
}

const TRANSFORMATION_LABELS = ["禄", "权", "科", "忌"] as const;

function StarList({ label, stars }: { label: string; stars: readonly NormalizedZiweiStar[] }) {
  return (
    <div className="ziwei-star-group">
      <h4>{label}</h4>
      {stars.length === 0 ? <p>无</p> : <ul>{stars.map((star, index) => (
        <li key={`${star.name}-${star.scope}-${index}`}>
          <strong>{star.name}</strong>
          <span>类型 {star.type}</span>
          <span>{star.brightness === null ? "亮度未标注" : `亮度 ${star.brightness}`}</span>
          <span>{star.transformation === null ? "四化无" : `四化 ${star.transformation}`}</span>
        </li>
      ))}</ul>}
    </div>
  );
}

function OverlayTransformations({ item, label }: { item: ZiweiHoroscopeItem; label: string }) {
  return (
    <div className="overlay-transformations">
      <h4>{label}四化</h4>
      {TRANSFORMATION_LABELS.map((transformation, index) => <span key={transformation}>{transformation}：{item.transformations[index]}</span>)}
    </div>
  );
}

type YearlyOverlayResolution =
  | { status: "natal" }
  | { status: "available"; fortune: ZiweiYearlyFortune }
  | { status: "unavailable" };

function hasTwelveAlignedOverlaySlots(item: ZiweiHoroscopeItem): boolean {
  const palaceSlotIndexes = Array.from({ length: 12 }, (_, index) => index);
  return item.palaceNames.length === 12
    && item.starsByPalace.length === 12
    && item.transformations.length === 4
    && palaceSlotIndexes.every((index) => {
      const name = item.palaceNames[index];
      return typeof name === "string" && name.trim() !== "" && Array.isArray(item.starsByPalace[index]);
    });
}

function resolveYearlyOverlay(
  fortunes: readonly ZiweiYearlyFortune[],
  selectedYear: number | null,
  mode: ResultSelection["ziweiMode"],
  palaceIndexes: readonly number[]
): YearlyOverlayResolution {
  if (mode === "natal") return { status: "natal" };
  if (selectedYear === null) return { status: "unavailable" };
  const matches = fortunes.filter(({ targetYear }) => targetYear === selectedYear);
  if (matches.length !== 1) return { status: "unavailable" };
  const alignedBasePalaces = palaceIndexes.length === 12 && palaceIndexes.every((index, position) => index === position);
  const fortune = matches[0];
  if (!alignedBasePalaces || !hasTwelveAlignedOverlaySlots(fortune.decadal) || !hasTwelveAlignedOverlaySlots(fortune.yearly)) {
    return { status: "unavailable" };
  }
  return { status: "available", fortune };
}

export function ZiweiDetailPage({ snapshot, selection, onSelectionChange, onAddTargetYear, onRemoveTargetYear, isNarrow = false }: ZiweiDetailPageProps) {
  const presentation = presentResults(snapshot, selection);
  const chart = presentation.chart.ziwei;
  const fortunes = [...chart.yearlyFortunes].sort((left, right) => left.targetYear - right.targetYear);
  const overlayResolution = resolveYearlyOverlay(
    fortunes,
    selection.selectedTargetYear,
    selection.ziweiMode,
    chart.palaces.map(({ index }) => index)
  );
  const overlay = overlayResolution.status === "available" ? overlayResolution.fortune : null;

  if (overlayResolution.status === "unavailable") {
    return (
      <section className="result-page ziwei-detail-page" aria-labelledby="ziwei-detail-title">
        <div className="result-page-heading">
          <div><p className="eyebrow">十二宫全盘</p><h2 id="ziwei-detail-title">紫微详盘</h2></div>
          <p>本命空间位置固定；所选年份只叠加已保存的运限资料。</p>
        </div>
        <TargetYearControl isNarrow={isNarrow} onAddTargetYear={onAddTargetYear} onRemoveTargetYear={onRemoveTargetYear} onSelectionChange={onSelectionChange} page="ziwei" selection={selection} snapshot={snapshot} />
        <div className="result-empty-state" role="status">
          <h3>所选流年紫微详盘暂不可用</h3>
          <p>这份结果没有完整、唯一且逐宫对齐的所选流年资料。</p>
          <button className="button secondary" type="button" onClick={() => onSelectionChange(selectZiweiMode(selection, "natal"))}>返回本命</button>
        </div>
      </section>
    );
  }

  return (
    <section className="result-page ziwei-detail-page" aria-labelledby="ziwei-detail-title">
      <div className="result-page-heading">
        <div><p className="eyebrow">十二宫全盘</p><h2 id="ziwei-detail-title">紫微详盘</h2></div>
        <p>本命空间位置固定；所选年份只叠加已保存的运限资料。</p>
      </div>

      <TargetYearControl isNarrow={isNarrow} onAddTargetYear={onAddTargetYear} onRemoveTargetYear={onRemoveTargetYear} onSelectionChange={onSelectionChange} page="ziwei" selection={selection} snapshot={snapshot} />

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

      <div className="ziwei-detail-board">
        {chart.palaces.map((palace) => {
          const position = getPalaceGridPosition(palace.index);
          const decadalStars = overlay?.decadal.starsByPalace[palace.index] ?? [];
          const yearlyStars = overlay?.yearly.starsByPalace[palace.index] ?? [];
          return (
            <article
              className={`ziwei-detail-palace ${palace.name === "命宫" ? "soul-palace" : ""}`}
              data-palace-index={palace.index}
              data-palace-position={`${position.row}:${position.column}`}
              key={`${palace.index}-${palace.name}`}
              style={{ gridRow: position.row, gridColumn: position.column }}
            >
              <header>
                <div><strong>{palace.name}</strong><GanZhiText text={`${palace.heavenlyStem}${palace.earthlyBranch}`} /></div>
                <div className="palace-markers">
                  {palace.name === "命宫" && <span>命宫</span>}
                  {palace.isBodyPalace && <span>身宫</span>}
                  {palace.isOriginalPalace && <span>原宫</span>}
                </div>
              </header>
              <StarList label="主星" stars={palace.majorStars} />
              <StarList label="辅星" stars={palace.minorStars} />
              {overlay && (
                <div className="palace-overlays">
                  <section><h4>大限 · {overlay.decadal.palaceNames[palace.index]}</h4><StarList label="大限星曜" stars={decadalStars} /></section>
                  <section><h4>流年 · {overlay.yearly.palaceNames[palace.index]}</h4><StarList label="流年星曜" stars={yearlyStars} /></section>
                </div>
              )}
              <dl className="palace-cycle-details">
                <div><dt>十二长生</dt><dd>{palace.changsheng12}</dd></div>
                <div><dt>大限虚岁</dt><dd>{palace.decadal.startAge}–{palace.decadal.endAge}</dd></div>
                <div><dt>对应虚岁</dt><dd>{palace.ages.join("、")}</dd></div>
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

      <section className="ziwei-transformations" aria-labelledby="natal-transformations-title">
        <h3 id="natal-transformations-title">本命四化</h3>
        <div>{chart.transformations.map((item) => <span key={`${item.palaceIndex}-${item.starName}-${item.transformation}`}><strong>{item.transformation}</strong>：{item.starName} · {item.palaceName}</span>)}</div>
      </section>
      {overlay && <section className="ziwei-overlay-summary"><OverlayTransformations item={overlay.decadal} label="大限" /><OverlayTransformations item={overlay.yearly} label="流年" /></section>}
    </section>
  );
}
