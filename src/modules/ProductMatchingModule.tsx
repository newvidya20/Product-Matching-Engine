import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  Play,
  Sparkles,
  Sliders,
} from 'lucide-react';
import { useAppState } from '../context/AppStateContext';
import {
  EmptyStatePanel,
  PageHeader,
  SegmentedControl,
} from '../components/ui/Primitives';
import {
  formatBaselineOutcome,
  formatDateTime,
  formatEligibilityStatus,
  formatEntityType,
  formatFundingPurpose,
  formatMoney,
} from '../utils/formatters';

type ResultFilter = 'all' | 'pending' | 'placeholders';

export function ProductMatchingModule() {
  const {
    state,
    navigateTo,
    setSelectedAssessmentId,
    evaluateAssessment,
    generateAiExplanation,
    openCategoryInAdmin,
  } = useAppState();

  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<
    Record<string, boolean>
  >({});
  const [isReviewExpanded, setIsReviewExpanded] = useState(false);
  const reviewPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isReviewExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (reviewPanelRef.current && !reviewPanelRef.current.contains(target)) {
        setIsReviewExpanded(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isReviewExpanded]);

  const selectedAssessment =
    state.assessments.find((a) => a.id === state.selectedAssessmentId) ??
    state.assessments[0] ??
    null;

  const evaluation = selectedAssessment?.latestEvaluation ?? null;
  const isAdmin = !state.currentUser || state.currentUser.role === 'admin';

  const toggleExpand = (catId: string) => {
    setExpandedCategoryIds((prev) => ({ ...prev, [catId]: !prev[catId] }));
  };

  const renderFailureLabel = (value: string) => {
    const parts = value.split(/(Failed)/gi);
    if (parts.length === 1) {
      return <span className="text-stone-900">{value}</span>;
    }

    return (
      <>
        {parts.map((part, index) =>
          part.toLowerCase() === 'failed' ? (
            <span key={`${part}-${index}`} className="text-red-600">
              {part}
            </span>
          ) : (
            <span key={`${part}-${index}`} className="text-stone-900">
              {part}
            </span>
          )
        )}
      </>
    );
  };

  const handleRunEvaluation = async () => {
    if (!selectedAssessment) return;
    await evaluateAssessment(selectedAssessment.id, 'official_catalog');
  };

  if (state.assessments.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Product Matching Engine"
          description="Create a borrower assessment to compare demand against the approved product portfolio."
        />
        <EmptyStatePanel
          icon={<Cpu className="w-6 h-6" />}
          title="No Borrower Assessments Available"
          description="Create a borrower assessment first. Matching searches the project’s local PDFs and does not determine lending eligibility."
          actionLabel="Create Borrower Assessment"
          onAction={() => navigateTo('new-assessment')}
        />
      </div>
    );
  }

  const filteredResults = (evaluation?.categoryResults ?? []).filter((cat) => {
    if (resultFilter === 'pending') return cat.suitabilityScore > 0;
    if (resultFilter === 'placeholders') return cat.isPlaceholder;
    return true;
  });

  const top3 = evaluation?.top3SubProducts ?? [];
  const alternatives = evaluation?.alternativeSubProducts ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Product Matching Engine"
        description="Compare borrower demand with the approved product catalogue and surface the strongest fit with policy-aware rationale."
        metadataItems={[
          'Multi-stage product fit analysis',
          `${state.documents.length} product references`,
          'Verified eligibility logic',
        ]}
      />

      {/* Engine Control Bar */}
      <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
          <div className="lg:col-span-5 space-y-1.5">
            <label className="block text-xs font-medium text-stone-700">
              Select Borrower Assessment
            </label>
            <select
              value={selectedAssessment?.id || ''}
              onChange={(e) => setSelectedAssessmentId(e.target.value)}
              className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
            >
              {state.assessments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.referenceCode} — {item.applicantLabel} (
                  {formatMoney(item.requestedAmount, item.currency)})
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-4 space-y-1.5">
            <label className="block text-xs font-medium text-stone-700">
              Product catalogue
            </label>
            <div className="px-3.5 py-2 text-sm bg-stone-50 border border-stone-200 rounded-lg text-stone-700">
              {state.categories.length} categories · {state.documents.length} product references
            </div>
          </div>

          <div className="lg:col-span-3 flex justify-end">
            <button
              type="button"
              disabled={state.isMutating || !selectedAssessment}
              onClick={() => void handleRunEvaluation()}
              className="w-full lg:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              <span>
                {state.isMutating ? 'Evaluating...' : 'Run 2-Stage Matching'}
              </span>
            </button>
          </div>
        </div>

        {/* Selected Borrower Tabular Snapshot */}
        {selectedAssessment && (
          <div className="pt-4 border-t border-stone-200 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-xs">
            <div>
              <div className="text-stone-500">Purpose & Entity</div>
              <div className="font-medium text-stone-900 mt-0.5 truncate">
                {formatFundingPurpose(selectedAssessment.fundingPurpose)}
              </div>
              <div className="text-[11px] text-stone-500">
                {formatEntityType(selectedAssessment.entityType)}
              </div>
            </div>
            <div>
              <div className="text-stone-500">Requested Facility</div>
              <div className="font-mono tabular-nums font-semibold text-stone-900 mt-0.5">
                {formatMoney(
                  selectedAssessment.requestedAmount,
                  selectedAssessment.currency
                )}
              </div>
              <div className="text-[11px] font-mono tabular-nums text-stone-500">
                Tenure: {selectedAssessment.requestedTenureMonths}m
              </div>
            </div>
            <div>
              <div className="text-stone-500">Turnover & Vintage</div>
              <div className="font-mono tabular-nums font-medium text-stone-900 mt-0.5">
                {selectedAssessment.annualTurnoverOrIncome > 0
                  ? formatMoney(
                      selectedAssessment.annualTurnoverOrIncome,
                      selectedAssessment.currency
                    )
                  : 'Not Provided'}
              </div>
              <div className="text-[11px] font-mono tabular-nums text-stone-500">
                Vintage:{' '}
                {selectedAssessment.businessVintageYears != null
                  ? `${selectedAssessment.businessVintageYears} yrs`
                  : 'Missing'}
              </div>
            </div>
            <div>
              <div className="text-stone-500">Credit Score</div>
              <div className="font-mono tabular-nums font-medium text-stone-900 mt-0.5">
                {selectedAssessment.creditScore != null
                  ? selectedAssessment.creditScore
                  : 'Not Provided'}
              </div>
              <div className="text-[11px] text-stone-500">
                GST: {selectedAssessment.gstTaxCompliant || 'not_provided'}
              </div>
            </div>
            <div>
              <div className="text-stone-500">Collateral</div>
              <div className="font-medium text-stone-900 mt-0.5">
                {selectedAssessment.collateralAvailable
                  ? selectedAssessment.collateralType || 'Available'
                  : 'Unsecured'}
              </div>
              {selectedAssessment.collateralValue != null && (
                <div className="text-[11px] font-mono tabular-nums text-stone-500">
                  {formatMoney(
                    selectedAssessment.collateralValue,
                    selectedAssessment.currency
                  )}
                </div>
              )}
            </div>
            <div>
              <div className="text-stone-500">Classification</div>
              <div className="font-medium text-stone-900 mt-0.5">
                {selectedAssessment.isFictionalDemo ? (
                  <span className="text-amber-700">Fictional Demo</span>
                ) : (
                  'Employee Entry'
                )}
              </div>
              <div className="text-[11px] text-stone-500 truncate">
                {selectedAssessment.industrySector || 'Sector unspecified'}
              </div>
            </div>
          </div>
        )}
      </div>

      {evaluation && (
        <section className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-stone-900 font-display">
                Optional AI Advisory Explanation
              </h2>
              <p className="max-w-3xl text-xs text-stone-600 leading-relaxed">
                On request, Gemini receives this borrower’s intake, the deterministic
                match results, and short excerpts from the cited local PDFs to draft
                an explanation. It cannot change the matching or eligibility result.
              </p>
            </div>
            <button
              type="button"
              disabled={
                state.isGeneratingAi ||
                !state.settings.enableAiExplanationService ||
                !selectedAssessment
              }
              onClick={() => {
                if (selectedAssessment) {
                  void generateAiExplanation(selectedAssessment.id);
                }
              }}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-stone-800 hover:bg-stone-900 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>
                {state.isGeneratingAi
                  ? 'Generating...'
                  : evaluation.aiExplanation
                  ? 'Refresh AI Explanation'
                  : 'Generate AI Explanation'}
              </span>
            </button>
          </div>
          {!state.settings.enableAiExplanationService && (
            <p className="text-xs text-amber-800">
              AI explanations are disabled in Settings.
            </p>
          )}
          {evaluation.aiExplanation && (
            <div className="pt-4 border-t border-stone-200 space-y-3">
              <div>
                <h3 className="text-xs font-semibold text-stone-800">
                  Borrower Summary
                </h3>
                <p className="mt-1 text-xs text-stone-600 leading-relaxed">
                  {evaluation.aiExplanation.borrowerRequirementSummary}
                </p>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-stone-800">
                  Match Explanation
                </h3>
                <p className="mt-1 text-xs text-stone-600 leading-relaxed">
                  {evaluation.aiExplanation.deterministicOutcomeNarrative}
                </p>
              </div>
              {evaluation.aiExplanation.employeeFollowUpChecklist.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-stone-800">
                    Suggested Follow-up
                  </h3>
                  <ul className="mt-1 list-disc pl-5 text-xs text-stone-600 space-y-1">
                    {evaluation.aiExplanation.employeeFollowUpChecklist.map(
                      (item, index) => (
                        <li key={`${index}-${item}`}>{item}</li>
                      )
                    )}
                  </ul>
                </div>
              )}
              <p className="text-[11px] text-stone-500">
                {evaluation.aiExplanation.governanceBoundaryNote}
              </p>
            </div>
          )}
        </section>
      )}

      {!evaluation ? (
        <EmptyStatePanel
          icon={<Cpu className="w-6 h-6" />}
          title="Two-Stage Matching Not Yet Executed for This Case"
          description="Click 'Run Local Reference Match' to find product PDFs whose text overlaps with the borrower's stated purpose and sector."
          actionLabel="Run 2-Stage Matching"
          onAction={() => void handleRunEvaluation()}
        />
      ) : (
        <div className="space-y-6">
          {/* TOP 3 SUITABLE SUB-PRODUCTS SPOTLIGHT */}
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-stone-900 font-display">
                  LoanBazaar → Product → Sub-Product → Eligibility Status → Key Reasons
                </h2>
                <p className="text-xs text-stone-500">
                  Each result shows the product path, the current eligibility status, and the main reasons the product matches the borrower profile.
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-stone-500">
                Evaluated {formatDateTime(evaluation.evaluatedAt)}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                {
                  label: 'Eligible now',
                  value: top3.filter((match) => match.eligibilityStatus === 'eligible').length,
                  tone: 'emerald',
                },
                {
                  label: 'Needs more info',
                  value: top3.filter((match) => match.eligibilityStatus === 'incomplete_data').length,
                  tone: 'amber',
                },
                {
                  label: 'Not suitable',
                  value: top3.filter((match) => match.eligibilityStatus === 'ineligible').length,
                  tone: 'red',
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="bg-white border border-stone-200 rounded-xl p-3.5"
                >
                  <div className="text-[11px] uppercase tracking-[0.08em] text-stone-500">
                    {item.label}
                  </div>
                  <div
                    className={`mt-2 text-2xl font-bold font-mono tabular-nums ${
                      item.tone === 'emerald'
                        ? 'text-emerald-700'
                        : item.tone === 'amber'
                        ? 'text-amber-700'
                        : 'text-red-700'
                    }`}
                  >
                    {item.value}
                  </div>
                </div>
              ))}
            </div>

            {top3.length === 0 ? (
              <div className="p-6 bg-white border border-stone-200 rounded-xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 text-xs text-stone-600">
                <div className="space-y-1 max-w-2xl">
                  <div className="font-semibold text-stone-900 text-sm">
                    {evaluation.configuredCategoriesCount === 0
                      ? 'No Local Product References Found'
                      : 'No Product Fits the Current Borrower Profile'}
                  </div>
                  <p className="leading-relaxed">
                    {evaluation.configuredCategoriesCount === 0
                      ? 'Refresh the product reference index before running a new match.'
                      : 'Try adding more detail to the stated purpose or business sector. The current borrower profile does not match any verified product rule set.'}
                  </p>
                </div>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => navigateTo('admin')}
                    className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Review Product References
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-stretch">
                {top3.map((match, idx) => {
                  const statusMeta = formatEligibilityStatus(
                    match.eligibilityStatus
                  );
                  return (
                    <div
                      key={match.subProductId}
                      className="bg-white border border-stone-200 rounded-xl p-5 flex flex-col justify-between gap-4 shadow-sm"
                    >
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-xs text-stone-500">
                            <span className="font-mono font-semibold text-orange-600">
                              Rank #{idx + 1}
                            </span>{' '}
                            · {match.categoryName}
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-lg font-bold font-mono tabular-nums text-stone-900">
                              {match.suitabilityScore}%
                            </div>
                            <div className="text-[10px] text-stone-400">
                              Suitability
                            </div>
                          </div>
                        </div>

                        <div className="rounded-lg bg-stone-50 border border-stone-200 p-3">
                          <div className="text-[11px] uppercase tracking-[0.08em] text-stone-500">
                            Product path
                          </div>
                          <div className="mt-1 text-sm font-semibold text-stone-900">
                            LoanBazaar / {match.categoryName} / {match.subProductName}
                          </div>
                        </div>

                        <div className="flex items-center justify-between gap-3">
                          <div className="text-xs text-stone-500">
                            <span className="font-mono text-stone-500">
                              {match.subProductCode}
                            </span>
                          </div>
                          <span className="text-stone-900">
                            {renderFailureLabel(statusMeta.label)}
                          </span>
                        </div>

                        {match.reasonsForMatching.length > 0 && (
                          <div className="rounded-lg bg-orange-50 border border-orange-100 p-3 text-xs">
                            <div className="font-semibold text-stone-800 mb-2">
                              Key reasons
                            </div>
                            <ul className="space-y-1 text-stone-700">
                              {match.reasonsForMatching.slice(0, 3).map((r, i) => (
                                <li key={i}>• {r}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {match.missingInformation.length > 0 && (
                          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs">
                            <div className="font-semibold text-amber-800 mb-2">
                              Additional information needed
                            </div>
                            <ul className="space-y-1 text-amber-900">
                              {match.missingInformation.map((m, i) => (
                                <li key={i}>• {m}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {match.failedRequirements.length > 0 && (
                          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs">
                            <div className="font-semibold text-red-800 mb-2">
                              Why it is not suitable
                            </div>
                            <ul className="space-y-1 text-red-700">
                              {match.failedRequirements.map((f, i) => (
                                <li key={i}>• {f}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>

                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ALTERNATIVE PRODUCTS */}
          {alternatives.length > 0 && (
            <section className="bg-white border border-stone-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-stone-200">
                <h2 className="text-sm font-semibold text-stone-900 font-display">
                  Alternative & Secondary Sub-Products ({alternatives.length})
                </h2>
                <p className="text-xs text-stone-500">
                  Other candidate products that may require a closer policy review or more borrower detail.
                </p>
              </div>
              <div className="divide-y divide-stone-200 text-xs">
                {alternatives.map((alt) => {
                  const statusMeta = formatEligibilityStatus(alt.eligibilityStatus);
                  return (
                    <div
                      key={alt.subProductId}
                      className="px-5 py-3.5 flex flex-col md:flex-row md:items-center md:justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="font-semibold text-stone-900">
                          {alt.subProductName}{' '}
                          <span className="font-normal text-stone-500">
                            · {alt.categoryName}
                          </span>
                        </div>
                        {alt.failedRequirements.length > 0 && (
                          <div className="text-stone-900">
                            <span className="text-red-600">Failed</span>: {' '}
                            <span className="text-stone-900">
                              {alt.failedRequirements.join(' · ')}
                            </span>
                          </div>
                        )}
                        {alt.missingInformation.length > 0 && (
                          <div className="text-amber-800">
                            Missing: {alt.missingInformation.join(' · ')}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <span className="font-mono tabular-nums font-semibold text-stone-700">
                          {alt.suitabilityScore}%
                        </span>
                        <span className="text-stone-900">
                          {renderFailureLabel(statusMeta.label)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* FULL 18-CATEGORY MATRIX + NOTE */}
          <div className="space-y-6">
            <section
              ref={reviewPanelRef}
              className="w-full bg-white border border-stone-200 rounded-xl overflow-hidden shadow-sm"
            >
              <button
                type="button"
                onClick={() => setIsReviewExpanded((prev) => !prev)}
                className="w-full p-4 border-b border-stone-200 bg-stone-100 text-left hover:bg-stone-200 transition-colors"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium text-stone-700 uppercase tracking-[0.08em]">
                      Structured Product Fit Audit · All {evaluation.categoryResults.length || 19} Categories
                    </div>
                    <h2 className="text-base font-semibold text-stone-900 font-display mt-0.5 truncate">
                      Product Category Fit and Eligibility Review
                    </h2>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 text-right font-mono tabular-nums text-xs text-stone-700">
                    <div>
                      <div className="font-semibold text-stone-900">
                        {evaluation.categoryResults.filter((item) => item.suitabilityScore > 0).length}{' '}
                        categories with fit signals
                      </div>
                      <div className="text-stone-700">
                        Rule-based suitability is shown with clear eligibility and reasons
                      </div>
                    </div>
                    <ChevronDown
                      className={`w-4 h-4 text-stone-800 transition-transform ${
                        isReviewExpanded ? 'rotate-180' : ''
                      }`}
                    />
                  </div>
                </div>
              </button>

              {isReviewExpanded && (
                <>
                  <div className="p-5 border-b border-stone-200 space-y-4">
                    <SegmentedControl<ResultFilter>
                      options={[
                        {
                          value: 'all',
                          label: `All ${evaluation.categoryResults.length || 19}`,
                          count: evaluation.categoryResults.length,
                        },
                        {
                          value: 'pending',
                          label: 'Reference matches',
                          count: evaluation.categoryResults.filter(
                            (c) => c.suitabilityScore > 0
                          ).length,
                        },
                        {
                          value: 'placeholders',
                          label: 'Placeholders',
                          count: evaluation.categoryResults.filter(
                            (c) => c.isPlaceholder
                          ).length,
                        },
                      ]}
                      value={resultFilter}
                      onChange={setResultFilter}
                    />
                  </div>

                  {filteredResults.length === 0 ? (
                    <div className="p-8 text-center text-xs text-stone-500">
                      No category slots match the selected filter view.
                    </div>
                  ) : (
                    <div className="divide-y divide-stone-200">
                      {filteredResults.map((cat) => {
                        const outcomeMeta = formatBaselineOutcome(cat.outcome);
                        const isExpanded = Boolean(expandedCategoryIds[cat.categoryId]);
                        const hasDetails =
                          !cat.isPlaceholder &&
                          (cat.categoryChecks.length > 0 ||
                            cat.subProductResults.length > 0);

                        return (
                          <div key={cat.categoryId}>
                            <div
                              onClick={() =>
                                hasDetails ? toggleExpand(cat.categoryId) : undefined
                              }
                              className={`px-5 py-3.5 flex items-center justify-between gap-4 hover:bg-stone-50/70 transition-colors ${
                                hasDetails ? 'cursor-pointer' : ''
                              }`}
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                {hasDetails ? (
                                  <span
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      toggleExpand(cat.categoryId);
                                    }}
                                    className="p-1 text-stone-500 hover:text-stone-900 rounded cursor-pointer"
                                  >
                                    {isExpanded ? (
                                      <ChevronDown className="w-4 h-4" />
                                    ) : (
                                      <ChevronRight className="w-4 h-4" />
                                    )}
                                  </span>
                                ) : (
                                  <span className="w-6 shrink-0" />
                                )}

                                <span className="font-mono tabular-nums text-xs text-stone-400 w-6 shrink-0">
                                  {String(cat.slotNumber).padStart(2, '0')}
                                </span>

                                <div className="min-w-0">
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      hasDetails
                                        ? toggleExpand(cat.categoryId)
                                        : isAdmin
                                        ? openCategoryInAdmin(cat.categoryId)
                                        : undefined;
                                    }}
                                    className="text-left text-xs font-medium text-stone-900 hover:text-orange-700 truncate block max-w-full cursor-pointer"
                                  >
                                    {cat.displayName}
                                  </button>
                                  <div className="text-[11px] text-stone-500 flex items-center gap-1.5">
                                    <span className="font-mono">{cat.code}</span>
                                    <span aria-hidden="true">·</span>
                                    <span className="tabular-nums">
                                      {cat.subProductResults.length} sub-products
                                    </span>
                                    {!cat.isPlaceholder && (
                                      <>
                                        <span aria-hidden="true">·</span>
                                        <span className="font-mono tabular-nums">
                                          Suitability: {cat.suitabilityScore}%
                                        </span>
                                      </>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-3 shrink-0 text-xs">
                                <span className={outcomeMeta.textClass}>
                                  {outcomeMeta.label}
                                </span>
                                {cat.isPlaceholder && isAdmin && (
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openCategoryInAdmin(cat.categoryId);
                                    }}
                                    className="p-1.5 text-stone-400 hover:text-stone-800 rounded cursor-pointer"
                                    title="Configure slot in Admin"
                                  >
                                    <Sliders className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>

                            {isExpanded && hasDetails && (
                              <div className="px-6 py-4 bg-stone-50/70 border-t border-stone-200/80 space-y-4 text-xs">
                                {cat.subProductResults.map((sp) => {
                                  const spElig = formatEligibilityStatus(
                                    sp.eligibilityStatus
                                  );
                                  return (
                                    <div
                                      key={sp.subProductId}
                                      className="py-2.5 border-b last:border-b-0 border-stone-200 space-y-2"
                                    >
                                      <div className="flex items-center justify-between gap-3">
                                        <div>
                                          <span className="font-semibold text-stone-900">
                                            {sp.name}
                                          </span>
                                          <span className="ml-2 font-mono text-[11px] text-stone-500">
                                            {sp.code} · {sp.suitabilityScore}%
                                          </span>
                                        </div>
                                        <span className={spElig.textClass}>
                                          {spElig.label}
                                        </span>
                                      </div>

                                      {sp.checks.length > 0 && (
                                        <div className="pl-3 space-y-1 text-[11px] text-stone-600">
                                          {sp.checks.map((c) => (
                                            <div
                                              key={c.ruleId}
                                              className="flex flex-wrap items-center justify-between gap-2"
                                            >
                                              <span>
                                                · [{c.stage === 'stage1_requirement' ? 'S1' : 'S2'}]{' '}
                                                {c.label}
                                              </span>
                                              <span className="font-mono tabular-nums">
                                                {c.actualSummary} vs {c.expectedSummary} —{' '}
                                                <strong
                                                  className={
                                                    c.status === 'passed'
                                                      ? 'text-emerald-700'
                                                      : c.status === 'missing_data'
                                                      ? 'text-amber-700'
                                                      : 'text-red-700'
                                                  }
                                                >
                                                  {c.status === 'passed'
                                                    ? 'PASS'
                                                    : c.status === 'missing_data'
                                                    ? 'MISSING'
                                                    : 'FAIL'}
                                                </strong>
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="w-full bg-stone-50 border-t border-stone-200 p-5 text-stone-800">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="inline-block w-2.5 h-2.5 rounded-full bg-stone-400" />
                      <h3 className="text-base font-semibold text-stone-900 font-display">
                        Note
                      </h3>
                    </div>
                    <div className="flex flex-col gap-3 text-xs leading-relaxed text-stone-600">
                      <p>
                        The engine evaluates borrower details against coded product rules, including
                        purpose fit, borrower type fit, and documented eligibility checks. This is not
                        a probability score and it does not replace policy review.
                      </p>
                      <p>
                        Product suitability is explained as a clear sequence: LoanBazaar → product →
                        sub-product → eligibility status → key reasons. AI only interprets these results
                        without overriding the rule outcome.
                      </p>
                    </div>
                  </div>
                </>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
