import { useState } from "react";

import {
  presentResults,
  selectTargetYear,
  selectZiweiMode,
  type ResultSelection,
  type ResultSnapshotInput,
  type TargetYearPage
} from "./results-model.js";

export interface TargetYearControlProps {
  snapshot: ResultSnapshotInput;
  selection: ResultSelection;
  page: TargetYearPage;
  isNarrow: boolean;
  onSelectionChange: (selection: ResultSelection) => void;
  onAddTargetYear?: (year: number, page: TargetYearPage) => void;
  onRemoveTargetYear?: (year: number, page: TargetYearPage) => void;
}

export interface FortuneYearSearchProps {
  years: readonly number[];
  query: string;
  onQueryChange: (query: string) => void;
  onSelectYear: (year: number) => void;
}

export function FortuneYearSearch({ years, query, onQueryChange, onSelectYear }: FortuneYearSearchProps) {
  const matchingYears = years.filter((year) => String(year).includes(query.trim()));

  return (
    <div className="year-search-selector">
      <label>搜索已添加流年
        <input
          aria-label="搜索已添加流年"
          inputMode="numeric"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>
      <label>匹配的已添加流年
        <select aria-label="匹配的已添加流年" value="" onChange={(event) => {
          const year = Number(event.target.value);
          if (matchingYears.includes(year)) onSelectYear(year);
        }}>
          <option value="">选择匹配年份</option>
          {matchingYears.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
      </label>
    </div>
  );
}

function pageSelection(
  selection: ResultSelection,
  snapshot: ResultSnapshotInput,
  year: number,
  page: TargetYearPage
): ResultSelection {
  const selected = selectTargetYear(selection, snapshot, year);
  return page === "ziwei"
    ? selectZiweiMode({ ...selected, activePage: "ziwei" }, "yearly")
    : { ...selected, activePage: "fortune" };
}

function SearchableYearSelector({
  years,
  selection,
  snapshot,
  page,
  onSelectionChange
}: Pick<TargetYearControlProps, "selection" | "snapshot" | "page" | "onSelectionChange"> & { years: readonly number[] }) {
  const [query, setQuery] = useState(() => selection.selectedTargetYear === null ? "" : String(selection.selectedTargetYear));

  return (
    <FortuneYearSearch
      onQueryChange={setQuery}
      onSelectYear={(year) => {
        setQuery(String(year));
        onSelectionChange(pageSelection(selection, snapshot, year, page));
      }}
      query={query}
      years={years}
    />
  );
}

export function TargetYearControl({
  snapshot,
  selection,
  page,
  isNarrow,
  onSelectionChange,
  onAddTargetYear,
  onRemoveTargetYear
}: TargetYearControlProps) {
  const presentation = presentResults(snapshot, selection);
  const years = [...presentation.chart.bazi.annualFortunes]
    .sort((left, right) => left.year - right.year || left.daYunIndex - right.daYunIndex)
    .map(({ year }) => year);
  const existingYears = new Set(years);
  const capability = presentation.baziDetail.availability === "available"
    ? snapshot.resultCapabilities.baziDetail
    : presentation.baziDetail.capability;
  const supported = capability.status === "reconfirm_required"
    ? []
    : capability.supportedTargetYears.filter((year) => !existingYears.has(year));
  const titleId = `target-year-title-${page}`;

  return (
    <section className="result-subsection target-year-controls target-year-control" aria-labelledby={titleId}>
      <div className="result-subsection-heading"><h3 id={titleId}>目标流年</h3><span>两页使用同一组已保存年份</span></div>
      <label className="add-year-control">添加流年
        <select aria-label="添加流年" value="" onChange={(event) => {
          const year = Number(event.target.value);
          if (supported.includes(year)) onAddTargetYear?.(year, page);
        }}>
          <option value="">选择当前排盘可计算年份</option>
          {supported.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
      </label>

      {years.length > 0 && (years.length <= 8 && !isNarrow ? (
        <div className="year-tabs" aria-label="目标流年切换">
          {years.map((year) => (
            <button
              className={year === selection.selectedTargetYear ? "selected" : undefined}
              aria-current={year === selection.selectedTargetYear ? "true" : undefined}
              key={year}
              type="button"
              onClick={() => onSelectionChange(pageSelection(selection, snapshot, year, page))}
            >
              {year}{year === selection.selectedTargetYear ? " · 已选流年" : ""}
            </button>
          ))}
        </div>
      ) : (
        <SearchableYearSelector key={selection.selectedTargetYear ?? "none"} onSelectionChange={onSelectionChange} page={page} selection={selection} snapshot={snapshot} years={years} />
      ))}

      {selection.selectedTargetYear !== null && onRemoveTargetYear && (
        <button className="button ghost remove-target-year" type="button" onClick={() => onRemoveTargetYear(selection.selectedTargetYear!, page)}>移除此流年</button>
      )}

    </section>
  );
}
