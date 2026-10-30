import React, { useState } from 'react';
import {
  BookOpen,
  ClipboardPlus,
  Cpu,
  History,
  LayoutDashboard,
  Lock,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Sliders,
  X,
} from 'lucide-react';
import { useAppState } from '../../context/AppStateContext';
import type { AppModuleId } from '../../types/domain';
import { isCategoryConfigured } from '../../utils/formatters';

interface NavEntry {
  id: AppModuleId;
  label: string;
  group: 'Advisory Operations' | 'Catalog & Governance';
  adminOnly?: boolean;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavEntry[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    group: 'Advisory Operations',
    icon: LayoutDashboard,
  },
  {
    id: 'new-assessment',
    label: 'New Borrower Assessment',
    group: 'Advisory Operations',
    icon: ClipboardPlus,
  },
  {
    id: 'matching-engine',
    label: 'Product Matching Engine',
    group: 'Advisory Operations',
    icon: Cpu,
  },
  {
    id: 'history',
    label: 'Assessment History',
    group: 'Advisory Operations',
    icon: History,
  },
  {
    id: 'directory',
    label: 'Product Directory',
    group: 'Catalog & Governance',
    icon: BookOpen,
  },
  {
    id: 'admin',
    label: 'Admin Product Management',
    group: 'Catalog & Governance',
    adminOnly: true,
    icon: Sliders,
  },
  {
    id: 'settings',
    label: 'Settings',
    group: 'Catalog & Governance',
    icon: Settings,
  },
];

function LoanBazaarLogo({ className = 'h-10 w-auto' }: { className?: string }) {
  return (
    <img
      src="/loanbazaar-logo.png"
      alt="LoanBazaar – Secure Distribution Venture Pvt. Ltd."
      className={`${className} object-contain select-none shrink-0`}
    />
  );
}

function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      role="img"
    >
      <circle cx="32" cy="32" r="29" fill="#fff" stroke="#ff4fb1" strokeWidth="3" />
      <g stroke="#f97316" strokeWidth="2.2" strokeLinecap="round" opacity="0.95">
        <line x1="32" y1="6" x2="32" y2="14" />
        <line x1="32" y1="50" x2="32" y2="58" />
        <line x1="6" y1="32" x2="14" y2="32" />
        <line x1="50" y1="32" x2="58" y2="32" />
        <line x1="13.5" y1="13.5" x2="18.5" y2="18.5" />
        <line x1="45.5" y1="45.5" x2="50.5" y2="50.5" />
        <line x1="13.5" y1="50.5" x2="18.5" y2="45.5" />
        <line x1="45.5" y1="18.5" x2="50.5" y2="13.5" />
      </g>
      <circle cx="32" cy="32" r="11" fill="#f97316" />
      <circle cx="32" cy="32" r="4" fill="#fff" />
    </svg>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    state,
    navigateTo,
    clearToast,
  } = useAppState();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const currentNav =
    NAV_ITEMS.find((item) => item.id === state.activeModule) ?? NAV_ITEMS[0];

  const configuredCount = state.categories.filter(isCategoryConfigured).length;
  const totalSlots = state.categories.length || 19;
  const totalSubProducts = state.categories.reduce(
    (sum, cat) => sum + cat.subProducts.length,
    0
  );

  const draftRulesCount = state.categories.reduce((acc, cat) => {
    const catDrafts = cat.baselineRules.filter(
      (r) => r.verificationStatus === 'draft'
    ).length;
    const subDrafts = cat.subProducts.reduce(
      (sAcc, sp) =>
        sAcc +
        sp.baselineRules.filter((r) => r.verificationStatus === 'draft').length,
      0
    );
    return acc + catDrafts + subDrafts;
  }, 0);

  const isEmployeeRestricted =
    state.currentUser !== null && state.currentUser.role === 'employee';

  const handleSelectNav = (id: AppModuleId) => {
    navigateTo(id);
    setMobileMenuOpen(false);
  };

  const renderSidebarContent = (isCollapsed = false) => (
    <div className="flex flex-col h-full bg-white text-slate-700">
      <div
        className={`h-20 ${
          isCollapsed ? 'px-2 justify-center' : 'px-4 justify-between'
        } border-b border-slate-200 flex items-center gap-2`}
      >
        <button
          type="button"
          onClick={() => handleSelectNav('dashboard')}
          className="flex items-center text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-orange-500 rounded-md min-w-0"
          aria-label="LoanBazaar Home"
        >
          {isCollapsed ? (
            <img
              src="/Screenshot 2026-10-30 112643.jpg"
              alt="LoanBazaar"
              className="h-10 w-10 object-contain rounded-full"
            />
          ) : (
            <div className="w-full flex items-center justify-center px-2">
              <img
                src="/loanbazaar-logo.png"
                alt="LoanBazaar"
                className="h-12 w-auto max-w-[220px] object-contain"
              />
            </div>
          )}
        </button>
        <button
          type="button"
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          className={`hidden lg:inline-flex p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md cursor-pointer shrink-0 ${
            isCollapsed ? 'absolute top-5 left-[3.15rem] z-10' : ''
          }`}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? (
            <PanelLeftOpen className="w-4 h-4" />
          ) : (
            <PanelLeftClose className="w-4 h-4" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          className="lg:hidden p-1.5 text-slate-500 hover:text-slate-900 rounded-md cursor-pointer shrink-0"
          aria-label="Close navigation menu"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-5 space-y-6">
        {(['Advisory Operations', 'Catalog & Governance'] as const).map((groupName) => {
          const groupItems = NAV_ITEMS.filter((i) => i.group === groupName);
          return (
            <div key={groupName} className="space-y-1.5">
              {!isCollapsed && (
                <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-400">
                  {groupName}
                </div>
              )}
              {groupItems.map((item) => {
                const Icon = item.icon;
                const active = state.activeModule === item.id;
                const lockedForEmployee = Boolean(item.adminOnly) && isEmployeeRestricted;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectNav(item.id)}
                    className={`w-full flex items-center ${
                      isCollapsed ? 'justify-center px-2' : 'justify-between px-3'
                    } gap-2 py-2.5 text-sm rounded-xl transition-all cursor-pointer whitespace-nowrap ${
                      active
                        ? 'bg-orange-50 text-orange-700 font-semibold'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 font-medium'
                    }`}
                    title={isCollapsed ? item.label : undefined}
                    aria-label={isCollapsed ? item.label : undefined}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span className="flex items-center gap-3 min-w-0 truncate">
                      <Icon
                        className={`w-4 h-4 shrink-0 ${
                          active ? 'text-orange-600' : 'text-slate-400'
                        }`}
                      />
                      {!isCollapsed && <span className="truncate">{item.label}</span>}
                    </span>

                    {!isCollapsed && lockedForEmployee ? (
                      <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    ) : !isCollapsed && item.id === 'admin' && draftRulesCount > 0 ? (
                      <span className="text-[11px] font-mono tabular-nums text-amber-700 shrink-0">
                        {draftRulesCount}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-[#edf3fa] text-slate-900">
      <aside
        className={`hidden lg:block relative ${
          sidebarCollapsed ? 'w-20' : 'w-72'
        } transition-[width] duration-200 shrink-0 border-r border-slate-200 sticky top-0 h-screen bg-white text-slate-700`}
      >
        {renderSidebarContent(sidebarCollapsed)}
      </aside>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/45"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-10 w-72 max-w-[82vw] h-full bg-white text-slate-700 border-r border-slate-200">
            {renderSidebarContent()}
          </aside>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-20 px-4 sm:px-8 bg-white/80 border-b border-slate-200/80 backdrop-blur-sm flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg cursor-pointer shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={() => handleSelectNav('dashboard')}
              className="lg:hidden shrink-0 cursor-pointer"
              aria-label="LoanBazaar Home"
            >
              <LoanBazaarLogo className="h-7 max-w-[140px] w-auto" />
            </button>

            <nav
              aria-label="Breadcrumb"
              className="hidden sm:flex items-center gap-2 text-sm text-slate-500 truncate"
            >
              <span className="hidden sm:inline font-semibold text-slate-900 whitespace-nowrap">
                LoanBazaar
              </span>
              <span className="hidden sm:inline text-slate-300" aria-hidden="true">/</span>
              <span className="hidden md:inline whitespace-nowrap">{currentNav.group}</span>
              <span className="hidden md:inline text-slate-300" aria-hidden="true">/</span>
              <span className="font-semibold text-slate-900 truncate">{currentNav.label}</span>
            </nav>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {state.activeModule !== 'new-assessment' && (
              <button
                type="button"
                onClick={() => navigateTo('new-assessment')}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-white bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 rounded-lg shadow-sm transition-all whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Assessment</span>
              </button>
            )}

          </div>
        </header>

        {state.toast && (
          <div className="px-4 sm:px-8 pt-4">
            <div
              role="status"
              className={`px-4 py-2.5 rounded-xl border text-xs flex items-center justify-between gap-4 ${
                state.toast.tone === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : state.toast.tone === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-slate-100 border-slate-200 text-slate-700'
              }`}
            >
              <span>{state.toast.message}</span>
              <button
                type="button"
                onClick={clearToast}
                className="text-current opacity-70 hover:opacity-100 cursor-pointer"
                aria-label="Dismiss message"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        <main className="flex-1 px-4 sm:px-8 py-6 sm:py-8 w-full mx-auto max-w-[1360px] space-y-6">
          {children}
        </main>
      </div>
    </div>
  );
}
