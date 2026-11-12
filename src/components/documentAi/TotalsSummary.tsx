import { useEffect, useState } from 'react';
import { documentAiClient } from '../../api/documentAiClient';
import type { SessionTotals } from '../../types/totals';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function formatRupees(n: number): string {
  return `₹${inr.format(Math.round(n))}`;
}

/** Short lakh/crore hint, e.g. ₹1.05 Cr. Empty below one lakh. */
export function shortRupees(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
  return '';
}

function Money({ value, strong }: { value: number | null; strong?: boolean }) {
  if (value === null) return <span className="text-stone-500">Not read</span>;
  const hint = shortRupees(value);
  return (
    <span className={strong ? 'font-semibold text-stone-900' : 'text-stone-800'}>
      {formatRupees(value)}
      {hint && <span className="ml-1 text-xs font-normal text-stone-500">({hint})</span>}
    </span>
  );
}

function Badge({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${warn ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'}`}>
      {children}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
      <span className="text-stone-600">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

export function TotalsSummary({ sessionId, extractedCount }: { sessionId: string; extractedCount: number }) {
  const [totals, setTotals] = useState<SessionTotals | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!sessionId || extractedCount === 0) {
      setTotals(null);
      return;
    }
    let cancelled = false;
    documentAiClient
      .getTotals(sessionId)
      .then((t) => {
        if (!cancelled) setTotals(t);
      })
      .catch(() => {
        if (!cancelled) setTotals(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, extractedCount]);

  if (!totals || (totals.gst.length === 0 && totals.bank.accounts.length === 0)) return null;
  const all = totals.bank.allAccounts;

  return (
    <section className="rounded-xl border border-stone-200 bg-stone-50" aria-label="Totals from your documents">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold text-stone-900">Totals from your documents</span>
        <span className="text-xs text-stone-500">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="space-y-4 px-4 pb-4">
          {totals.gst.map((g) => (
            <div key={`${g.gstin ?? ''}${g.financialYear}`} className="space-y-1 rounded-lg bg-white p-3 border border-stone-200">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-stone-900">GST turnover, {g.financialYear}</span>
                <Badge warn={g.partYear}>{g.monthsCovered} of {g.monthsExpected} months{g.partYear ? ' (part year)' : ''}</Badge>
              </div>
              <Row label="Total turnover"><Money value={g.total} strong /></Row>
              <Row label="Taxable outward"><Money value={g.outwardTaxable} /></Row>
              {g.zeroRated > 0 && <Row label="Zero rated"><Money value={g.zeroRated} /></Row>}
              {g.nilExempt > 0 && <Row label="Nil rated / exempt"><Money value={g.nilExempt} /></Row>}
              {g.gstin && <p className="text-[11px] text-stone-500">GSTIN {g.gstin}</p>}
            </div>
          ))}
          {totals.bank.accounts.length > 0 && (
            <div className="space-y-2">
              {totals.bank.accounts.map((a) => (
                <div key={a.label} className="space-y-1 rounded-lg bg-white p-3 border border-stone-200">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all text-sm font-medium text-stone-900">Bank: {a.label}</span>
                    <Badge warn={a.missingMonths.length > 0}>
                      {a.monthsCovered} month{a.monthsCovered === 1 ? '' : 's'}{a.missingMonths.length > 0 ? `, missing ${a.missingMonths.length}` : ''}
                    </Badge>
                  </div>
                  <Row label="Total credits"><Money value={a.totalCredits} strong /></Row>
                  <Row label="Total debits"><Money value={a.totalDebits} /></Row>
                  <Row label="Average monthly credits"><Money value={a.averageMonthlyCredits} /></Row>
                  <p className="text-[11px] text-stone-500">
                    {a.firstMonth} to {a.lastMonth}
                    {a.missingMonths.length > 0 && ` · not counted: ${a.missingMonths.join(', ')}`}
                  </p>
                </div>
              ))}
              {all && totals.bank.accounts.length > 1 && (
                <div className="space-y-1 rounded-lg border border-stone-300 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-stone-900">All accounts</span>
                    <Badge>{all.months} month{all.months === 1 ? '' : 's'}</Badge>
                  </div>
                  <Row label="Total credits"><Money value={all.totalCredits} strong /></Row>
                  <Row label="Total debits"><Money value={all.totalDebits} /></Row>
                  <Row label="Average monthly credits"><Money value={all.averageMonthlyCredits} /></Row>
                </div>
              )}
            </div>
          )}
          {totals.notes.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-900">
              {totals.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
