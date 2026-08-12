export interface ResultSnapshotState<Snapshot, Selection> {
  snapshot: Snapshot;
  selection: Selection;
  retainedSnapshotRisk: boolean;
}

export function commitResultSnapshot<Snapshot, Selection>(
  snapshot: Snapshot,
  createSelection: (snapshot: Snapshot) => Selection
): ResultSnapshotState<Snapshot, Selection> {
  return { snapshot, selection: createSelection(snapshot), retainedSnapshotRisk: false };
}

export function restoreRetainedSnapshot<Snapshot, Selection>(
  snapshot: Snapshot,
  createSelection: (snapshot: Snapshot) => Selection
): ResultSnapshotState<Snapshot, Selection> {
  return { snapshot, selection: createSelection(snapshot), retainedSnapshotRisk: true };
}

export function drawerIdentity(caseId: string, revisionId: string): string {
  return `${caseId}:${revisionId}`;
}

export function sortedTargetYears(years: readonly number[]): number[] {
  return [...new Set(years)].sort((left, right) => left - right);
}

export function requiresFreshProvidedTimeForm(
  schemaVersion: "1.0.0" | "2.0.0",
  baziDetailStatus: string
): boolean {
  return schemaVersion === "1.0.0" || baziDetailStatus === "reconfirm_required";
}

export interface ResultsAppActionState<Snapshot, Selection> {
  snapshot: Snapshot | undefined;
  selection: Selection | undefined;
  retainedSnapshotRisk: boolean;
  showForm: boolean;
  revisionCaseId: string | undefined;
}

export function createResultsAppActions<Snapshot, Selection>(options: {
  identityFor: (snapshot: Snapshot) => string;
  selectionFor: (snapshot: Snapshot) => Selection;
}) {
  const showOverview = (state: ResultsAppActionState<Snapshot, Selection>, snapshot: Snapshot, retainedSnapshotRisk: boolean): ResultsAppActionState<Snapshot, Selection> => ({
    ...state,
    snapshot,
    selection: options.selectionFor(snapshot),
    retainedSnapshotRisk,
    showForm: false,
    revisionCaseId: undefined
  });
  return {
    beginCreate(state: ResultsAppActionState<Snapshot, Selection>): ResultsAppActionState<Snapshot, Selection> {
      return { ...state, showForm: true, revisionCaseId: undefined };
    },
    selectOrReload(state: ResultsAppActionState<Snapshot, Selection>, snapshot: Snapshot): ResultsAppActionState<Snapshot, Selection> {
      const sameIdentity = state.snapshot !== undefined && options.identityFor(state.snapshot) === options.identityFor(snapshot);
      return showOverview(state, snapshot, sameIdentity ? state.retainedSnapshotRisk : false);
    },
    commitSuccess(state: ResultsAppActionState<Snapshot, Selection>, snapshot: Snapshot): ResultsAppActionState<Snapshot, Selection> {
      return showOverview(state, snapshot, false);
    },
    restoreExistingFailure(state: ResultsAppActionState<Snapshot, Selection>, lastSuccessful: Snapshot): ResultsAppActionState<Snapshot, Selection> {
      return showOverview(state, lastSuccessful, true);
    },
    keepNewCaseFailure(state: ResultsAppActionState<Snapshot, Selection>): ResultsAppActionState<Snapshot, Selection> {
      return { ...state, showForm: true, revisionCaseId: undefined };
    },
    targetYearRequest(storedTargetYears: readonly number[]): { targetYears: number[] } {
      return { targetYears: [...storedTargetYears] };
    },
    recoverBaziDetail(
      request: { schemaVersion: "1.0.0" | "2.0.0"; baziDetailStatus: string; storedTargetYears: readonly number[] },
      handlers: { openFreshProvidedTimeForm: () => void; updateStoredTargetYears: (targetYears: readonly number[]) => void }
    ): void {
      if (requiresFreshProvidedTimeForm(request.schemaVersion, request.baziDetailStatus)) {
        handlers.openFreshProvidedTimeForm();
        return;
      }
      handlers.updateStoredTargetYears([...request.storedTargetYears]);
    },
    targetYearSuccess(state: ResultsAppActionState<Snapshot, Selection>, snapshot: Snapshot, fortuneSelection: Selection): ResultsAppActionState<Snapshot, Selection> {
      return { ...state, snapshot, selection: fortuneSelection, retainedSnapshotRisk: false, showForm: false, revisionCaseId: undefined };
    },
    targetYearFailure(state: ResultsAppActionState<Snapshot, Selection>, lastSuccessful: Snapshot): ResultsAppActionState<Snapshot, Selection> {
      return { ...state, snapshot: lastSuccessful, retainedSnapshotRisk: true, showForm: false, revisionCaseId: undefined };
    }
  };
}
