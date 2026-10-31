import React, { useState } from 'react';
import { ArrowRight, Eye, EyeOff, Lock, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import { useAppState } from '../context/AppStateContext';

export function AuthModule() {
  const { signInLocalUser, signUpLocalUser } = useAppState();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'employee' as 'admin' | 'employee',
  });

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (mode === 'signin') {
      await signInLocalUser({
        email: form.email,
        password: form.password,
        role: form.role,
        displayName: form.name || undefined,
      });
      return;
    }

    await signUpLocalUser({
      displayName: form.name,
      email: form.email,
      password: form.password,
      role: form.role,
    });
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#fff7ed_0%,_#f8fafc_38%,_#eef4fb_100%)] flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-6xl grid overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_30px_80px_rgba(15,23,42,0.08)] lg:grid-cols-[1.2fr_0.8fr]">
        <div className="relative hidden overflow-hidden bg-slate-950 p-10 text-white lg:flex lg:flex-col lg:justify-between">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(249,115,22,0.28),_transparent_38%),radial-gradient(circle_at_bottom_right,_rgba(244,114,182,0.20),_transparent_32%)]" />
          <div className="relative z-10">
            <img
              src="/loanbazaar-logo.png"
              alt="LoanBazaar"
              className="h-12 w-auto object-contain mb-8"
            />
            <div className="inline-flex items-center gap-2 rounded-full border border-orange-400/30 bg-orange-500/10 px-3 py-1.5 text-[11px] font-medium text-orange-200 uppercase tracking-[0.2em]">
              <Sparkles className="h-3.5 w-3.5" />
              Product intelligence platform
            </div>
          </div>

          <div className="relative z-10 space-y-6">
            <h1 className="max-w-md text-4xl font-semibold leading-tight text-white">
              Match the right funding product to every borrower.
            </h1>
            <p className="max-w-md text-sm leading-7 text-slate-300">
              Track product coverage, review policy fit, and evaluate borrower intake against your approved lending portfolio with a cleaner, more structured workflow.
            </p>

            <div className="grid gap-3 max-w-md">
              {[
                'Portfolio product matching',
                'Admin policy verification',
                'Borrower assessment workflow',
              ].map((item) => (
                <div key={item} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-white/3 px-3 py-2.5 text-sm text-slate-200">
                  <ShieldCheck className="h-4 w-4 text-orange-400" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>

        </div>

        <div className="p-6 sm:p-8 lg:p-10">
          <div className="mb-8 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-orange-600">
                Welcome back
              </p>
              <h2 className="mt-2 text-3xl font-semibold text-slate-900">
                {mode === 'signin' ? 'Sign in' : 'Create account'}
              </h2>
            </div>
            <div className="rounded-full border border-slate-200 bg-slate-50 p-2 text-slate-600">
              <UserRound className="h-5 w-5" />
            </div>
          </div>

          <div className="mb-6 inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1">
            {(['signin', 'signup'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  mode === item ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                }`}
              >
                {item === 'signin' ? 'Sign in' : 'Sign up'}
              </button>
            ))}
          </div>

          <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
            {mode === 'signup' && (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-slate-700">Full name</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Enter your full name"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
                />
              </label>
            )}

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Work email</span>
              <input
                type="email"
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="name@company.com"
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
                required
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Password</span>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                  placeholder={mode === 'signin' ? 'Enter your password' : 'Create a password'}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 pr-11 text-sm text-slate-800 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
                  minLength={6}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-800"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-slate-700">Access level</span>
              <select
                value={form.role}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    role: event.target.value as 'admin' | 'employee',
                  }))
                }
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
              >
                <option value="admin">Administrator</option>
                <option value="employee">Employee</option>
              </select>
            </label>

            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:from-orange-600 hover:to-orange-700"
            >
              <span>{mode === 'signin' ? 'Sign in to workspace' : 'Create account'}</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

        </div>
      </div>
    </div>
  );
}
