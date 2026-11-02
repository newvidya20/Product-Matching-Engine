import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { DocumentAiError, documentAiClient, registerUnlockHandler } from '../../api/documentAiClient';

interface GateUser {
  email?: string;
  displayName?: string;
}

/**
 * Asks for the Document AI access code when a request comes back 401, once, then lets the
 * client retry. Mount it on any page that calls the Document AI routes.
 */
export function DocumentAccessGate({ user }: { user?: GateUser | null }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    setCode('');
    setError(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  useEffect(() => {
    registerUnlockHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setOpen(true);
        })
    );
    return () => {
      registerUnlockHandler(null);
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await documentAiClient.createAuthSession({
        accessCode: code.trim(),
        actorEmail: user?.email,
        actorDisplayName: user?.displayName,
      });
      if (status.authenticated) {
        finish(true);
      } else {
        setError('That code was not accepted.');
      }
    } catch (err) {
      setError(
        err instanceof DocumentAiError && err.code === 'unauthenticated'
          ? 'That code was not accepted.'
          : err instanceof Error
            ? err.message
            : 'Could not unlock Document AI.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-stone-900/40" onClick={() => finish(false)} aria-hidden="true" />
      <form
        onSubmit={(event) => void submit(event)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="docai-unlock-title"
        className="relative z-10 w-full max-w-sm bg-white border border-stone-200 rounded-xl p-5 space-y-4 shadow-xl"
      >
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-orange-50 text-orange-700">
            <KeyRound className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="space-y-0.5">
            <h2 id="docai-unlock-title" className="text-base font-semibold text-stone-900 font-display">
              Unlock Document AI
            </h2>
            <p className="text-xs text-stone-500 leading-relaxed">
              Enter the access code your admin set for document upload and extraction.
            </p>
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="docai-access-code" className="block text-xs font-medium text-stone-700">
            Access code
          </label>
          <input
            id="docai-access-code"
            ref={inputRef}
            type="password"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-orange-600"
          />
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={() => finish(false)}
            className="px-3.5 py-2 text-xs font-medium text-stone-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg disabled:opacity-50 cursor-pointer"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
            Unlock
          </button>
        </div>
      </form>
    </div>
  );
}
