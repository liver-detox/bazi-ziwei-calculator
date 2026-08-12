import { BaziDetailPage } from "./BaziDetailPage.js";
import { FortunePage } from "./FortunePage.js";
import { GanZhiText } from "./five-elements.js";
import {
  RESULT_PAGES,
  presentResults,
  selectResultCandidate,
  shouldShowCandidateChooser,
  type ResultSelection,
  type ResultSnapshotInput,
  type TargetYearPage
} from "./results-model.js";
import { ZiweiDetailPage } from "./ZiweiDetailPage.js";

export interface ResultsShellProps {
  snapshot: ResultSnapshotInput;
  selection: ResultSelection;
  caseName: string;
  onSelectionChange: (selection: ResultSelection) => void;
  onOpenCaseDialog: () => void;
  onModifyInput: () => void;
  onOpenVerification: () => void;
  onRecoverBaziDetail?: () => void;
  onAddTargetYear?: (year: number, page: TargetYearPage) => void;
  onRemoveTargetYear?: (year: number, page: TargetYearPage) => void;
  isNarrow: boolean;
}

function CompactOverview({
  snapshot,
  selection,
  onSelectionChange
}: Pick<ResultsShellProps, "snapshot" | "selection" | "onSelectionChange">) {
  const presentation = presentResults(snapshot, selection);
  const bazi = presentation.chart.bazi;
  const ziwei = presentation.chart.ziwei;
  const pillars = [bazi.pillars.year, bazi.pillars.month, bazi.pillars.day, bazi.pillars.time];
  const pillarLabels = ["年柱", "月柱", "日柱（日主）", "时柱"];
  const years = [...bazi.annualFortunes].sort((left, right) => left.year - right.year);
  const currentDaYunPosition = bazi.luck.daYun.findIndex(({ index }) => index === selection.viewingDaYunIndex);
  const summaryStart = Math.min(
    Math.max(currentDaYunPosition - 1, 0),
    Math.max(bazi.luck.daYun.length - 3, 0)
  );
  const daYunSummary = bazi.luck.daYun.filter((_period, index) => index >= summaryStart && index < summaryStart + 3);

  const openPage = (activePage: ResultSelection["activePage"]) => onSelectionChange({ ...selection, activePage });

  return (
    <section className="overview-page" aria-labelledby="overview-title">
      <div className="result-page-heading">
        <div><p className="eyebrow">同一候选 · 双轨结果</p><h2 id="overview-title">双盘总览</h2></div>
        <p>{years.length === 0 ? "本次未选择流年" : `目标流年 ${years.map(({ year }) => year).join("、")}`}</p>
      </div>
      <div className="overview-grid">
        <article className="overview-track overview-bazi">
          <div className="overview-track-heading"><div><span className="track-mark">八字</span><h3>{bazi.fourPillars.join(" · ")}</h3></div><button type="button" onClick={() => openPage("bazi")}>进入八字详盘</button></div>
          <div className="overview-pillars">
            {pillars.map((pillar, index) => (
              <div className={index === 2 ? "day-master" : undefined} key={pillarLabels[index]}>
                <span>{pillarLabels[index]}</span>
                <GanZhiText className="overview-ganzhi" text={pillar.ganZhi} />
                <strong>{index === 2 ? "日主" : pillar.stemTenGod}</strong>
                <small>藏干摘要 {pillar.hiddenStems.map((stem, stemIndex) => `${stem}${pillar.hiddenStemTenGods[stemIndex]}`).join("、")}</small>
              </div>
            ))}
          </div>
          <div className="overview-summary-row">
            <strong>大运摘要</strong>
            <span>{bazi.luck.forward ? "顺排" : "逆排"} · 共 {bazi.luck.daYun.length} 段</span>
            <div className="overview-dayun-list">{daYunSummary.map((period) => (
              <span
                aria-current={period.index === selection.viewingDaYunIndex ? "true" : undefined}
                className={period.index === selection.viewingDaYunIndex ? "selected" : undefined}
                data-overview-dayun-index={period.index}
                key={period.index}
              >
                {period.index === selection.viewingDaYunIndex ? "正在查看 · " : ""}
                {period.ganZhi === null ? "起运前" : <GanZhiText text={period.ganZhi} />} · 虚岁 {period.startAge}–{period.endAge}
              </span>
            ))}</div>
          </div>
          <div className="overview-links"><button type="button" onClick={() => openPage("fortune")}>查看大运流年</button></div>
        </article>

        <article className="overview-track overview-ziwei">
          <div className="overview-track-heading"><div><span className="track-mark">紫微</span><h3>十二宫概览</h3></div><button type="button" onClick={() => openPage("ziwei")}>进入紫微详盘</button></div>
          <dl className="overview-ziwei-meta">
            <div><dt>命宫</dt><dd>{ziwei.soulPalaceBranch}</dd></div>
            <div><dt>身宫</dt><dd>{ziwei.bodyPalaceBranch}</dd></div>
            <div><dt>五行局</dt><dd>{ziwei.fiveElementsClass}</dd></div>
            <div><dt>命主</dt><dd>{ziwei.soul}</dd></div>
            <div><dt>身主</dt><dd>{ziwei.body}</dd></div>
          </dl>
          <div className="overview-palaces">
            {ziwei.palaces.map((palace) => (
              <div key={`${palace.index}-${palace.name}`}>
                <strong>{palace.name}</strong>
                <GanZhiText text={`${palace.heavenlyStem}${palace.earthlyBranch}`} />
                <small>{palace.majorStars.length === 0 ? "无主星" : palace.majorStars.map(({ name }) => name).join("、")}</small>
              </div>
            ))}
          </div>
          <div className="overview-transformations"><strong>四化</strong>{ziwei.transformations.map((item) => <span key={`${item.starName}-${item.transformation}`}>{item.transformation}：{item.starName} · {item.palaceName}</span>)}</div>
        </article>
      </div>
    </section>
  );
}

export function ResultsShell({
  snapshot,
  selection,
  caseName,
  onSelectionChange,
  onOpenCaseDialog,
  onModifyInput,
  onOpenVerification,
  onRecoverBaziDetail,
  onAddTargetYear,
  onRemoveTargetYear,
  isNarrow
}: ResultsShellProps) {
  const presentation = presentResults(snapshot, selection);
  const activePage = selection.activePage;

  return (
    <main className="results-shell">
      <header className="results-header">
        <div className="results-case-context">
          <p className="eyebrow">当前案例</p>
          <button aria-haspopup="dialog" className="results-case-trigger" data-result-case-trigger type="button" onClick={onOpenCaseDialog}>{caseName}</button>
        </div>
        <div className="result-primary-actions">
          <button className="button result-primary-action secondary" type="button" onClick={onModifyInput}>修改输入</button>
          <button className="button result-primary-action primary" type="button" onClick={onOpenVerification}>核验与导出</button>
        </div>
      </header>

      <nav className="results-navigation" aria-label="结果页面">
        {RESULT_PAGES.map((page) => (
          <button
            aria-current={activePage === page.id ? "page" : undefined}
            className={activePage === page.id ? "active" : undefined}
            key={page.id}
            type="button"
            onClick={() => onSelectionChange({ ...selection, activePage: page.id })}
          >{page.label}</button>
        ))}
      </nav>

      {shouldShowCandidateChooser(snapshot) && (
        <div className="result-candidate-switcher" role="group" aria-label="切换排盘候选">
          {snapshot.charts.candidates.map((candidate, index) => (
            <button
              aria-current={candidate.candidateId === selection.candidateId ? "true" : undefined}
              className={candidate.candidateId === selection.candidateId ? "selected" : undefined}
              key={candidate.candidateId}
              type="button"
              onClick={() => onSelectionChange(selectResultCandidate(selection, snapshot, candidate.candidateId))}
            >候选 {index + 1}{candidate.candidateId === selection.candidateId ? " · 正在查看" : ""}</button>
          ))}
        </div>
      )}

      {activePage === "overview" && <CompactOverview onSelectionChange={onSelectionChange} selection={selection} snapshot={snapshot} />}
      {activePage === "bazi" && <BaziDetailPage onRecoverDetail={onRecoverBaziDetail} presentation={presentation} />}
      {activePage === "fortune" && <FortunePage isNarrow={isNarrow} onAddTargetYear={onAddTargetYear} onRemoveTargetYear={onRemoveTargetYear} onSelectionChange={onSelectionChange} selection={selection} snapshot={snapshot} />}
      {activePage === "ziwei" && <ZiweiDetailPage isNarrow={isNarrow} onAddTargetYear={onAddTargetYear} onRemoveTargetYear={onRemoveTargetYear} onSelectionChange={onSelectionChange} selection={selection} snapshot={snapshot} />}
    </main>
  );
}
