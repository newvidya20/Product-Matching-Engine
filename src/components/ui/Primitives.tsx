import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface PageHeaderProps {
  title: string;
  description: string;
  metadataItems?: string[];
  actions?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  metadataItems = [],
  actions,
}: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-4 pb-6 border-b border-stone-200 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1.5 max-w-2xl">
        {metadataItems.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
            {metadataItems.map((item, idx) => (
              <React.Fragment key={idx}>
                {idx > 0 && <span aria-hidden="true">·</span>}
                <span>{item}</span>
              </React.Fragment>
            ))}
          </div>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900 font-display">
          {title}
        </h1>
        <p className="text-sm text-stone-600 leading-relaxed">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5 shrink-0">{actions}</div>}
    </div>
  );
}

export interface StatMetricItem {
  label: string;
  value: string | number;
  subtext: string;
  accent?: 'default' | 'orange' | 'gold';
}

export function StatStrip({ items }: { items: StatMetricItem[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-stone-200 rounded-xl divide-y sm:divide-y-0 sm:divide-x divide-stone-200">
      {items.map((item, idx) => (
        <div key={idx} className="p-5 flex flex-col justify-between gap-2">
          <span className="text-xs font-medium text-stone-500">{item.label}</span>
          <div
            className={`text-2xl font-semibold font-mono tabular-nums tracking-tight ${
              item.accent === 'orange'
                ? 'text-orange-600'
                : item.accent === 'gold'
                ? 'text-amber-700'
                : 'text-stone-900'
            }`}
          >
            {item.value}
          </div>
          <span className="text-xs text-stone-500">{item.subtext}</span>
        </div>
      ))}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 p-1 bg-stone-100 border border-stone-200/80 rounded-lg overflow-x-auto max-w-full">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-orange-600 ${
              active
                ? 'bg-white text-stone-900 shadow-xs'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            <span>{opt.label}</span>
            {typeof opt.count === 'number' && (
              <span className="ml-1.5 font-mono tabular-nums text-stone-400">
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyStatePanel({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon?: React.ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="py-12 px-6 text-center bg-white border border-stone-200 rounded-xl flex flex-col items-center justify-center gap-3">
      {icon && <div className="text-stone-400">{icon}</div>}
      <h3 className="text-base font-semibold text-stone-900">{title}</h3>
      <p className="text-sm text-stone-600 max-w-md leading-relaxed">{description}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-2 px-4 py-2 text-xs font-medium text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function TableSkeletonRows({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
      <div className="divide-y divide-stone-200">
        {Array.from({ length: rows }).map((_, rIdx) => (
          <div key={rIdx} className="px-4 py-3 flex items-center gap-4">
            {Array.from({ length: cols }).map((__, cIdx) => (
              <div
                key={cIdx}
                className="h-4 bg-stone-100 rounded animate-pulse flex-1"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DemoContextBanner({
  mode,
  enableDemoSandbox,
  onToggleMode,
}: {
  mode: 'official_catalog' | 'fictional_demo_sandbox';
  enableDemoSandbox: boolean;
  onToggleMode?: (next: 'official_catalog' | 'fictional_demo_sandbox') => void;
}) {
  if (!enableDemoSandbox && mode === 'official_catalog') return null;

  const isDemoMode = mode === 'fictional_demo_sandbox';

  return (
    <div className="px-4 py-3 bg-amber-50/70 border border-amber-200 rounded-xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div className="text-xs text-stone-700 leading-relaxed">
        {isDemoMode ? (
          <>
            <strong className="font-semibold text-amber-900">
              Fictional Demo Sandbox Active:
            </strong>{' '}
            Slots 01–03 currently overlay clearly labeled{' '}
            <span className="font-mono text-amber-900">[FICTIONAL DEMO]</span> sample structures so
            employees can test filters, baseline checks, and AI narratives without inventing real
            LoanBazaar product names.
          </>
        ) : (
          <>
            <strong className="font-semibold text-stone-900">
              Official Catalog View (19 Configurable Slots):
            </strong>{' '}
            Showing actual configured categories and clean empty placeholders awaiting official
            LoanBazaar study materials.
          </>
        )}
      </div>
      {enableDemoSandbox && onToggleMode && (
        <button
          type="button"
          onClick={() =>
            onToggleMode(isDemoMode ? 'official_catalog' : 'fictional_demo_sandbox')
          }
          className="px-3.5 py-1.5 text-xs font-medium border border-amber-300 bg-white hover:bg-amber-50 text-amber-900 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {isDemoMode ? 'Switch to Official 19 Placeholders' : 'Preview Fictional Demo Sandbox'}
        </button>
      )}
    </div>
  );
}

export function SlideOverDrawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="fixed inset-0 bg-stone-900/25 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-xl bg-white h-full border-l border-stone-200 flex flex-col">
        <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <h2 className="text-base font-semibold text-stone-900 truncate font-display">
              {title}
            </h2>
            {subtitle && <p className="text-xs text-stone-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="p-2 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-6">{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t border-stone-200 bg-stone-50/70 flex items-center justify-end gap-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
