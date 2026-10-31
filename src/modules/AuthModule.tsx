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
    <div className="min-h-screen bg-[#f4f1ee] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-[560px] pt-4">
        <div className="mb-8 flex justify-center">
          <img
            src="/loanbazaar-logo.png"
            alt="LoanBazaar"
            className="h-16 w-auto object-contain"
          />
        </div>

        <div className="text-center">
          <h1 className="text-[32px] font-black tracking-[-0.05em] text-[#0f172a]">
            Product Matching Engine
          </h1>
          <p className="mt-3 text-[12px] font-semibold uppercase tracking-[0.18em] text-[#475569]">
            Lead Assessment &amp; Initial Response Portal
          </p>
        </div>

        <div className="mt-8 rounded-[18px] border border-[#dfe3e8] bg-[#f8f8f7] p-5 shadow-[0_10px_25px_rgba(15,23,42,0.04)]">
          <div className="mb-6 flex rounded-xl border border-[#dfe3e8] bg-[#eef1f3] p-1.5">
            {(['signin', 'signup'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                  mode === item
                    ? 'bg-white text-[#0f172a] shadow-sm'
                    : 'text-[#64748b]'
                }`}
              >
                {item === 'signin' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>

          <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
            {mode === 'signup' && (
              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-[#0f172a]">Full Name</span>
                <div className="flex items-center gap-3 rounded-xl border border-[#dfe3e8] bg-[#edf3fb] px-3 py-2.5 shadow-inner">
                  <UserRound className="h-4 w-4 text-[#64748b]" />
                  <input
                    type="text"
                    value={form.name}
                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Enter full name"
                    className="w-full bg-transparent text-sm text-[#0f172a] placeholder:text-[#64748b] focus:outline-none"
                  />
                </div>
              </label>
            )}

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-[#0f172a]">Email Address</span>
              <div className="flex items-center gap-3 rounded-xl border border-[#dfe3e8] bg-[#edf3fb] px-3 py-2.5 shadow-inner">
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-[#64748b]" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z"/>
                  <path d="m5 7 7 6 7-6"/>
                </svg>
                <input
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                  placeholder="vidyaa.lb@gmail.com"
                  className="w-full bg-transparent text-sm text-[#0f172a] placeholder:text-[#64748b] focus:outline-none"
                  required
                />
              </div>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-[#0f172a]">Password</span>
              <div className="flex items-center gap-3 rounded-xl border border-[#dfe3e8] bg-[#edf3fb] px-3 py-2.5 shadow-inner">
                <Lock className="h-4 w-4 text-[#64748b]" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                  placeholder="••••••"
                  className="w-full bg-transparent text-sm text-[#0f172a] placeholder:text-[#64748b] focus:outline-none"
                  minLength={6}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="text-[#64748b] hover:text-[#0f172a]"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-[#0f172a]">User Type</span>
              <div className="rounded-xl border border-[#dfe3e8] bg-[#edf3fb] px-3 py-2.5 shadow-inner">
                <select
                  value={form.role}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      role: event.target.value as 'admin' | 'employee',
                    }))
                  }
                  className="w-full bg-transparent text-sm text-[#0f172a] focus:outline-none"
                >
                  <option value="employee">Employee</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
            </label>

            <button
              type="submit"
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#f59e0b] to-[#f97316] px-4 py-3 text-lg font-bold text-white shadow-[0_8px_20px_rgba(249,115,22,0.30)] transition hover:brightness-105"
            >
              <span>{mode === 'signin' ? 'Sign In to Hub' : 'Create Account'}</span>
              <ArrowRight className="h-5 w-5" />
            </button>
          </form>
        </div>

        <div className="mt-6 text-center text-[13px] text-[#64748b]">
          Loanbazaar Product Matching Engine
        </div>
      </div>
    </div>
  );
}
