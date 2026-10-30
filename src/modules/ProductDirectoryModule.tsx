import React, { useState } from 'react';
import { BookOpen, ExternalLink, Search, Sliders } from 'lucide-react';
import { useAppState } from '../context/AppStateContext';
import {
  DemoContextBanner,
  EmptyStatePanel,
  PageHeader,
  SegmentedControl,
  SlideOverDrawer,
} from '../components/ui/Primitives';
import type { ProductCategory } from '../types/domain';
import {
  formatCategoryLifecycle,
  formatShortDate,
  formatStudyMaterialStatus,
  getCategoryDisplayTitle,
  isCategoryConfigured,
} from '../utils/formatters';

type DirectoryFilter = 'all' | 'configured' | 'placeholders';

export function ProductDirectoryModule() {
  const { state, setCatalogViewMode, openCategoryInAdmin } = useAppState();

  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<DirectoryFilter>('all');
  const [inspectedCategory, setInspectedCategory] =
    useState<ProductCategory | null>(null);

  const isAdmin = !state.currentUser || state.currentUser.role === 'admin';

  const activeCatalog =
    state.catalogViewMode === 'fictional_demo_sandbox' &&
    state.settings.enableDemoSandbox
      ? state.fictionalDemoCategories
      : state.categories;

  const filteredCatalog = activeCatalog.filter((cat) => {
    const configured = isCategoryConfigured(cat);
    if (filter === 'configured' && !configured) return false;
    if (filter === 'placeholders' && configured) return false;

    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;

    const inCat =
      cat.code.toLowerCase().includes(q) ||
      getCategoryDisplayTitle(cat).toLowerCase().includes(q) ||
      cat.description.toLowerCase().includes(q) ||
      cat.studyMaterialRef.toLowerCase().includes(q);

    const inSub = cat.subProducts.some(
      (sp) =>
        sp.code.toLowerCase().includes(q) ||
        sp.name.toLowerCase().includes(q) ||
        sp.description.toLowerCase().includes(q)
    );

    return inCat || inSub;
  });

  const configuredCount = activeCatalog.filter(isCategoryConfigured).length;
  const placeholderCount = activeCatalog.length - configuredCount;

  const inspectedDocs = inspectedCategory
    ? state.documents.filter((d) => d.categoryId === inspectedCategory.id)
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Product Catalogue"
        description="Browse the active product universe and review category coverage, policy readiness, and sub-product depth across the portfolio."
        metadataItems={[
          `${activeCatalog.length} main categories`,
          `${configuredCount} active`,
          `${state.documents.length} product references`,
        ]}
        actions={
          isAdmin ? (
            <button
              type="button"
              onClick={() => openCategoryInAdmin(activeCatalog[0]?.id || 'cat-01')}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Manage Product Master</span>
            </button>
          ) : undefined
        }
      />

      <DemoContextBanner
        mode={state.catalogViewMode}
        enableDemoSandbox={state.settings.enableDemoSandbox}
        onToggleMode={setCatalogViewMode}
      />

      {/* Search & Filter Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search slot code, category name, or sub-product..."
            className="w-full pl-9 pr-3.5 py-2 text-xs bg-white border border-stone-200 rounded-lg focus:outline-none focus:border-orange-600"
          />
        </div>

        <SegmentedControl<DirectoryFilter>
          options={[
            {
              value: 'all',
              label: `All ${activeCatalog.length || 19} Slots`,
              count: activeCatalog.length,
            },
            { value: 'configured', label: 'Active', count: configuredCount },
            {
              value: 'placeholders',
              label: 'Placeholders',
              count: placeholderCount,
            },
          ]}
          value={filter}
          onChange={setFilter}
        />
      </div>

      {filteredCatalog.length === 0 ? (
        <EmptyStatePanel
          icon={<BookOpen className="w-6 h-6" />}
          title="No Matching Product Categories Found"
          description="Clear the search filter or update the product master to add new coverage."
          actionLabel="Reset Filters"
          onAction={() => {
            setSearchQuery('');
            setFilter('all');
          }}
        />
      ) : (
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50/70 text-[11px] font-medium text-stone-500">
                  <th className="py-3 px-4 w-14">Slot</th>
                  <th className="py-3 px-4 w-28">Code</th>
                  <th className="py-3 px-4">Main Category & Sub-Products</th>
                  <th className="py-3 px-4">Policy Status</th>
                  <th className="py-3 px-4 text-right">Sub-Products</th>
                  <th className="py-3 px-4 text-right">Verified Rules</th>
                  <th className="py-3 px-4 text-right">PDFs</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 text-xs">
                {filteredCatalog.map((cat) => {
                  const configured = isCategoryConfigured(cat);
                  const studyMeta = formatStudyMaterialStatus(
                    cat.studyMaterialStatus
                  );
                  const verifiedRules =
                    cat.baselineRules.filter(
                      (r) =>
                        r.verificationStatus !== 'draft' &&
                        r.verificationStatus !== 'rejected'
                    ).length +
                    cat.subProducts.reduce(
                      (s, sp) =>
                        s +
                        sp.baselineRules.filter(
                          (r) =>
                            r.verificationStatus !== 'draft' &&
                            r.verificationStatus !== 'rejected'
                        ).length,
                      0
                    );
                  const catDocsCount = state.documents.filter(
                    (d) => d.categoryId === cat.id
                  ).length;

                  return (
                    <tr
                      key={cat.id}
                      className="hover:bg-stone-50/80 transition-colors"
                    >
                      <td className="py-3.5 px-4 font-mono tabular-nums text-stone-500">
                        {String(cat.slotNumber).padStart(2, '0')}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-stone-700 whitespace-nowrap">
                        {cat.code}
                      </td>
                      <td className="py-3.5 px-4 max-w-md">
                        <div
                          className={
                            configured
                              ? 'font-semibold text-stone-900'
                              : 'font-medium text-stone-500'
                          }
                        >
                          {getCategoryDisplayTitle(cat)}
                        </div>
                        <div className="text-[11px] text-stone-500 mt-0.5 truncate">
                          {cat.description ||
                            'No product reference has been indexed for this category yet.'}
                        </div>
                        {cat.subProducts.length > 0 && (
                          <div className="text-[11px] text-stone-600 mt-1 flex flex-wrap items-center gap-1.5">
                            {cat.subProducts.map((sp, i) => (
                              <React.Fragment key={sp.id}>
                                {i > 0 && <span aria-hidden="true">·</span>}
                                <span>{sp.name || sp.code}</span>
                              </React.Fragment>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className={studyMeta.textClass}>
                          {studyMeta.label}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-medium text-stone-900">
                        {cat.subProducts.length}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-600">
                        {verifiedRules}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-stone-600">
                        {catDocsCount}
                      </td>
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setInspectedCategory(cat)}
                            className="px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 rounded-md transition-colors cursor-pointer"
                          >
                            Inspect
                          </button>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => openCategoryInAdmin(cat.id)}
                              className="px-2.5 py-1 text-xs font-medium text-orange-700 hover:bg-orange-50 rounded-md transition-colors cursor-pointer"
                            >
                              Edit
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Category, Sub-Products & Linked Drive PDFs Drawer */}
      <SlideOverDrawer
        open={Boolean(inspectedCategory)}
        title={
          inspectedCategory
            ? getCategoryDisplayTitle(inspectedCategory)
            : 'Category Detail'
        }
        subtitle={
          inspectedCategory
            ? `Slot ${String(inspectedCategory.slotNumber).padStart(2, '0')} · ${
                inspectedCategory.code
              } · Updated ${formatShortDate(inspectedCategory.updatedAt)}`
            : undefined
        }
        onClose={() => setInspectedCategory(null)}
        footer={
          inspectedCategory && (
            <>
              <button
                type="button"
                onClick={() => setInspectedCategory(null)}
                className="px-4 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer"
              >
                Close
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    const id = inspectedCategory.id;
                    setInspectedCategory(null);
                    openCategoryInAdmin(id);
                  }}
                  className="px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg cursor-pointer"
                >
                  Configure in Admin
                </button>
              )}
            </>
          )
        }
      >
        {inspectedCategory && (
          <div className="space-y-6 text-xs">
            <div className="space-y-2">
              <div className="text-stone-500">Status & Source Governance</div>
              <div className="text-sm font-medium text-stone-900">
                {formatCategoryLifecycle(inspectedCategory.status).label} ·{' '}
                {
                  formatStudyMaterialStatus(inspectedCategory.studyMaterialStatus)
                    .label
                }
              </div>
              <p className="text-stone-600 leading-relaxed pt-1">
                {inspectedCategory.description ||
                  'No description is available in the local reference.'}
              </p>
            </div>

            {/* Local source PDFs */}
            <div className="pt-4 border-t border-stone-200 space-y-2">
              <div className="font-semibold text-stone-900">
                Product References ({inspectedDocs.length})
              </div>
              {inspectedDocs.length === 0 ? (
                <p className="text-stone-500">
                  No local PDFs are indexed for this category.
                </p>
              ) : (
                <div className="divide-y divide-stone-200 border-t border-b border-stone-200">
                  {inspectedDocs.map((doc) => (
                    <div
                      key={doc.id}
                      className="py-2.5 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-stone-900 truncate">
                          {doc.fileName}
                        </div>
                        <div className="text-[11px] text-stone-500">
                          Status: {doc.extractionStatus.replace(/_/g, ' ')} ·{' '}
                          {formatShortDate(doc.uploadedAt)}
                        </div>
                      </div>
                      <span className="text-[11px] text-stone-500 shrink-0">
                        Local project file
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Sub-Products */}
            <div className="pt-4 border-t border-stone-200 space-y-3">
              <div className="font-semibold text-stone-900">
                Sub-Products ({inspectedCategory.subProducts.length})
              </div>
              {inspectedCategory.subProducts.length === 0 ? (
                <p className="text-stone-500">
                  Zero sub-products defined for this slot. Unlimited sub-products are supported.
                </p>
              ) : (
                <div className="divide-y divide-stone-200 border-t border-b border-stone-200">
                  {inspectedCategory.subProducts.map((sp) => (
                    <div key={sp.id} className="py-3.5 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-stone-900">
                          {sp.name || 'Unnamed Sub-Product'}
                        </span>
                        <span className="font-mono text-stone-500">{sp.code}</span>
                      </div>
                      {sp.description && (
                        <p className="text-stone-600 leading-relaxed">
                          {sp.description}
                        </p>
                      )}
                      {sp.suitableBorrowerTypes &&
                        sp.suitableBorrowerTypes.length > 0 && (
                          <div className="text-[11px] text-stone-600">
                            <strong>Borrower Types:</strong>{' '}
                            {sp.suitableBorrowerTypes.join(', ')}
                          </div>
                        )}
                      {sp.fundingPurposes && sp.fundingPurposes.length > 0 && (
                        <div className="text-[11px] text-stone-600">
                          <strong>Use Cases:</strong>{' '}
                          {sp.fundingPurposes.join(', ')}
                        </div>
                      )}
                      {sp.requiredDocuments && sp.requiredDocuments.length > 0 && (
                        <div className="text-[11px] text-stone-600">
                          <strong>Required Docs:</strong>{' '}
                          {sp.requiredDocuments.join(' · ')}
                        </div>
                      )}
                      {sp.restrictionsAndExclusions &&
                        sp.restrictionsAndExclusions.length > 0 && (
                          <div className="text-[11px] text-red-700">
                            <strong>Exclusions:</strong>{' '}
                            {sp.restrictionsAndExclusions.join(' · ')}
                          </div>
                        )}
                      <div className="text-[11px] text-stone-500">
                        {
                          sp.baselineRules.filter(
                            (r) => r.verificationStatus === 'verified'
                          ).length
                        }{' '}
                        verified rules ·{' '}
                        {
                          sp.baselineRules.filter(
                            (r) => r.verificationStatus === 'draft'
                          ).length
                        }{' '}
                        draft rules
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </SlideOverDrawer>
    </div>
  );
}
