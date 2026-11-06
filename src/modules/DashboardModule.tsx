import React from 'react';
import {
  ArrowRight,
  ClipboardPlus,
  Cpu,
  Sliders,
} from 'lucide-react';
import { useAppState } from '../context/AppStateContext';
import {
  DemoContextBanner,
  EmptyStatePanel,
  PageHeader,
  StatStrip,
  TableSkeletonRows,
} from '../components/ui/Primitives';
import {
  formatAssessmentStatus,
  formatDateTime,
  formatEntityType,
  formatFundingPurpose,
  formatMoney,
  formatShortDate,
  getCategoryDisplayTitle,
  isCategoryConfigured,
} from '../utils/formatters';

export function DashboardModule() {
  const {
    state,
    navigateTo,
    openAdminTab,
    openAssessmentInEngine,
    openCategoryInAdmin,
    setCatalogViewMode,
  } = useAppState();

  const activeCatalog =
    state.catalogViewMode === 'fictional_demo_sandbox' &&
    state.settings.enableDemoSandbox
      ? state.fictionalDemoCategories
      : state.categories;

  const totalSlots = activeCatalog.length || 19;
  const configuredCategoriesCount = activeCatalog.filter(isCategoryConfigured).length;
  const totalSubProductsCount = activeCatalog.reduce(
    (sum, cat) => sum + cat.subProducts.length,
    0
  );

  const verifiedRulesCount = activeCatalog.reduce((sum, cat) => {
    const cRules = cat.baselineRules.filter(
      (r) => r.verificationStatus !== 'draft' && r.verificationStatus !== 'rejected'
    ).length;
    const sRules = cat.subProducts.reduce(
      (sAcc, sp) =>
        sAcc +
        sp.baselineRules.filter(
          (r) =>
            r.verificationStatus !== 'draft' &&
            r.verificationStatus !== 'rejected'
        ).length,
      0
    );
    return sum + cRules + sRules;
  }, 0);

  const draftRulesCount = activeCatalog.reduce((sum, cat) => {
    const cDrafts = cat.baselineRules.filter(
      (r) => r.verificationStatus === 'draft'
    ).length;
    const sDrafts = cat.subProducts.reduce(
      (sAcc, sp) =>
        sAcc +
        sp.baselineRules.filter((r) => r.verificationStatus === 'draft').length,
      0
    );
    return sum + cDrafts + sDrafts;
  }, 0);

  const visibleAssessments = state.assessments.filter((a) => !a.isFictionalDemo);

  const evaluatedCount = visibleAssessments.filter(
    (a) => a.status === 'evaluated'
  ).length;
  const isAdmin = !state.currentUser || state.currentUser.role === 'admin';

  if (state.isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Advisory Operations Overview"
          description="Loading the local product reference and borrower assessments."
        />
        <TableSkeletonRows rows={6} cols={5} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio Overview"
        description="Track product coverage, borrower demand, and policy readiness across the lending book."
        metadataItems={[
          `${totalSlots} product categories`,
          `${state.documents.length} product references`,
          'Multi-stage matching enabled',
        ]}
        actions={
          <>
            {isAdmin && (
              <button
                type="button"
                onClick={() => openAdminTab('master')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-200 hover:bg-stone-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Sliders className="w-3.5 h-3.5 text-stone-500" />
                <span>Product Master</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => navigateTo('matching-engine')}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>Open Matching Engine</span>
            </button>
          </>
        }
      />

      <div className="p-4 sm:p-5 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-white border border-slate-800 rounded-xl shadow-sm">
        <div className="font-semibold text-white">Product coverage snapshot</div>
        <p className="mt-1 text-xs leading-relaxed text-slate-200">
          {state.documents.length} reference records are linked to the active product catalogue.
          Matching prioritises fit, policy alignment, and product suitability for each borrower case.
        </p>
      </div>

      <DemoContextBanner
        mode={state.catalogViewMode}
        enableDemoSandbox={state.settings.enableDemoSandbox}
        onToggleMode={setCatalogViewMode}
      />

      <StatStrip
        items={[
          {
            label: 'Product Categories',
            value: totalSlots,
            subtext: `${configuredCategoriesCount} active · ${
              totalSlots - configuredCategoriesCount
            } placeholders`,
            accent: 'default',
          },
          {
            label: 'Active Sub-Products',
            value: totalSubProductsCount,
            subtext: `${verifiedRulesCount} verified policy rules`,
            accent: 'gold',
          },
          {
            label: 'Borrower Assessments',
            value: visibleAssessments.length,
            subtext: `${evaluatedCount} evaluated this cycle`,
            accent: 'orange',
          },
          {
            label: 'Draft Rules',
            value: draftRulesCount,
            subtext:
              draftRulesCount > 0
                ? 'Awaiting admin review'
                : 'Policy checks aligned',
            accent: 'default',
          },
        ]}
      />

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Recent Borrower Assessments */}
        <section className="xl:col-span-7 bg-white border border-stone-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-stone-900 font-display">
                Recent Borrower Assessments
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Select any borrower intake to run Two-Stage Requirement & Eligibility Matching.
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigateTo('history')}
              className="inline-flex items-center gap-1 text-xs font-medium text-orange-700 hover:text-orange-800 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>View All</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {visibleAssessments.length === 0 ? (
            <div className="p-6">
              <EmptyStatePanel
                icon={<ClipboardPlus className="w-6 h-6" />}
                title="No Borrower Assessments Visible"
                description="Log a new borrower requirement to evaluate against your verified Product Master."
                actionLabel="Start New Assessment"
                onAction={() => navigateTo('new-assessment')}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50/70 text-[11px] font-medium text-stone-500">
                    <th className="py-2.5 px-4">Reference</th>
                    <th className="py-2.5 px-4">Company / Purpose</th>
                    <th className="py-2.5 px-4 text-right">Requested Facility</th>
                    <th className="py-2.5 px-4">State</th>
                    <th className="py-2.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200 text-xs">
                  {visibleAssessments.slice(0, 6).map((item) => {
                    const statusMeta = formatAssessmentStatus(item.status);
                    return (
                      <tr
                        key={item.id}
                        className="hover:bg-stone-50/80 transition-colors"
                      >
                        <td className="py-3 px-4 font-mono tabular-nums text-stone-700 whitespace-nowrap">
                          {item.referenceCode}
                        </td>
                        <td className="py-3 px-4 max-w-[240px]">
                          <div className="font-medium text-stone-900 truncate">
                            {item.applicantLabel}
                          </div>
                          <div className="text-[11px] text-stone-500 flex items-center gap-1.5 truncate">
                            <span>{formatFundingPurpose(item.fundingPurpose)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{formatEntityType(item.entityType)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{formatShortDate(item.updatedAt)}</span>
                            {item.isFictionalDemo && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-amber-700 font-medium">
                                  Fictional Demo
                                </span>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums font-medium text-stone-900 whitespace-nowrap">
                          {formatMoney(item.requestedAmount, item.currency)}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span className={statusMeta.textClass}>
                            {statusMeta.label}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => openAssessmentInEngine(item.id)}
                            className="px-2.5 py-1 text-xs font-medium text-orange-700 hover:bg-orange-50 rounded-md transition-colors cursor-pointer"
                          >
                            Match
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 19-Slot Readiness Matrix */}
        <section className="xl:col-span-5 bg-white border border-stone-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-stone-900 font-display">
                {totalSlots} Main Category Slots
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                Product categories and sub-products loaded from the project’s local reference.
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigateTo('directory')}
              className="inline-flex items-center gap-1 text-xs font-medium text-orange-700 hover:text-orange-800 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>Directory</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="max-h-[380px] overflow-y-auto divide-y divide-stone-200">
            {activeCatalog.map((cat) => {
              const configured = isCategoryConfigured(cat);
              const pdfCount = state.documents.filter(
                (d) => d.categoryId === cat.id
              ).length;

              return (
                <div
                  key={cat.id}
                  className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-stone-50/80 transition-colors"
                >
                  <div className="min-w-0 flex items-center gap-3">
                    <span className="font-mono tabular-nums text-xs text-stone-400 w-6 shrink-0">
                      {String(cat.slotNumber).padStart(2, '0')}
                    </span>
                    <div className="min-w-0">
                      <div
                        className={`text-xs truncate ${
                          configured
                            ? 'font-medium text-stone-900'
                            : 'text-stone-500'
                        }`}
                      >
                        {getCategoryDisplayTitle(cat)}
                      </div>
                      <div className="text-[11px] text-stone-400 flex items-center gap-1.5">
                        <span className="font-mono">{cat.code}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {cat.subProducts.length} sub-products
                        </span>
                        {pdfCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="tabular-nums text-stone-600">
                              {pdfCount} PDF{pdfCount > 1 ? 's' : ''}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {isAdmin ? (
                    <button
                      type="button"
                      onClick={() => openCategoryInAdmin(cat.id)}
                      className="px-2.5 py-1 text-xs font-medium text-stone-600 hover:text-stone-900 hover:bg-stone-100 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Manage
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => navigateTo('directory')}
                      className="px-2.5 py-1 text-xs font-medium text-stone-500 hover:text-stone-900 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      View
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
