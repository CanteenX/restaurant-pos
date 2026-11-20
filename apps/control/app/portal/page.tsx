'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, call, useRequestScope } from '../api';
import { Downloads, Invoices, Outlets, PortalTickets } from './sections';

type Principal = { accountId: string; businessId: string; email: string };
type Summary = {
  business: { id: string; displayName: string };
  hostedStatus: 'active' | 'suspended';
  supportEmail: string;
  paymentInstructions: string;
};
const tabs = ['Invoices', 'Outlets', 'Downloads', 'Tickets'] as const;
type Tab = typeof tabs[number];

export default function CustomerPortal() {
  const [account, setAccount] = useState<Principal | null>();
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const requests = useRequestScope();
  const expire = useCallback(() => setAccount(null), []);

  useEffect(() => {
    const scope = requests.current;
    if (!scope) return;
    void call<Principal>('portal/session', undefined, scope).then((value) => {
      if (!scope.aborted) setAccount(value);
    }).catch((failure: unknown) => {
      if (scope.aborted) return;
      setAccount(null);
      if (!(failure instanceof ApiError && failure.status === 401)) setError('The customer portal is unavailable.');
    });
  }, [requests]);

  async function run(work: (scope: AbortSignal) => Promise<void>) {
    const scope = requests.current;
    if (!scope || scope.aborted || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try { await work(scope); }
    catch {
      if (!scope.aborted) setError(account ? 'Sign-out could not be completed.' :
        activating ? 'Activation failed. Check your code.' : 'Sign-in failed. Check your email and password.');
    } finally {
      pending.current = false;
      if (!scope.aborted) setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = form.get('password');
    const body = activating ? { code: String(form.get('code')).trim(), password } :
      { email: String(form.get('email')).trim(), password };
    void run(async (scope) => {
      const value = await call<Principal>(activating ? 'portal/activate' : 'portal/session', body);
      if (!scope.aborted) {
        setAccount(value);
        setActivating(false);
      }
    });
  }

  function signOut() {
    void run(async (scope) => {
      try { await call('portal/logout', {}); }
      catch (failure) {
        if (!(failure instanceof ApiError && failure.status === 401)) throw failure;
      }
      if (!scope.aborted) expire();
    });
  }

  return <>
    <header className="masthead">
      <div className="brand"><b aria-hidden="true">N</b><span>Nventra <small>Customer portal</small></span></div>
      {account && <button type="button" disabled={busy} onClick={signOut}>Sign out</button>}
    </header>
    <main>
      {error && <p role="alert">{error}</p>}
      {account ? <CustomerWorkspace key={account.accountId} onExpired={expire} /> : account === null ?
        <section className="signin">
          <h1>{activating ? 'Activate portal account' : 'Customer portal sign-in'}</h1>
          <form key={activating ? 'activation' : 'credentials'} method="post" onSubmit={submit}>
            <fieldset disabled={busy}>
              {activating ? <label>Activation code<input name="code" type="password" autoComplete="off" maxLength={43} required /></label> :
                <label>Email<input name="email" type="email" autoComplete="username" maxLength={254} required /></label>}
              <label>Password<input name="password" type="password" autoComplete={activating ? 'new-password' : 'current-password'}
                minLength={activating ? 12 : undefined} maxLength={72} required /></label>
              <div className="actions">
                <button className="primary">{activating ? 'Set password' : 'Sign in'}</button>
                <button type="button" onClick={() => { setActivating(!activating); setError(''); }}>
                  {activating ? 'Back to sign-in' : 'Activate account'}
                </button>
              </div>
            </fieldset>
          </form>
        </section> : <p role="status">Checking customer session…</p>}
    </main>
  </>;
}

function CustomerWorkspace({ onExpired }: { onExpired: () => void }) {
  const [summary, setSummary] = useState<Summary>();
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<Tab>('Invoices');
  const [error, setError] = useState('');
  const refreshAccess = useCallback(() => {
    setSummary(undefined);
    setError('');
    setRevision((next) => next + 1);
  }, []);

  const showError = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) return onExpired();
    setError(failure instanceof ApiError && failure.status === 404 ? 'This resource could not be found.' :
      'The request could not be completed. Try again.');
  }, [onExpired]);
  const paidError = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 403) {
      setTab('Invoices');
      return refreshAccess();
    }
    showError(failure);
  }, [showError, refreshAccess]);

  useEffect(() => {
    const controller = new AbortController();
    void call<Summary>('portal/summary', undefined, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setSummary(value);
      if (value.hostedStatus === 'suspended') setTab('Invoices');
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) showError(failure);
    });
    return () => controller.abort();
  }, [revision, showError]);

  const active = summary?.hostedStatus === 'active';
  return <>
    {error && <p role="alert">{error}</p>}
    {!summary ? <section className="detail">
      {!error && <p role="status">Checking hosted access…</p>}
      {error && <button type="button" onClick={refreshAccess}>Retry</button>}
    </section> : <>
      <h1>{summary.business.displayName}</h1>
      {summary.hostedStatus === 'suspended' && <aside aria-label="Hosted access suspended">
        <h2>Hosted access suspended</h2>
        <p>{summary.paymentInstructions}</p>
        <p>Contact support at <a href={'mailto:' + summary.supportEmail}>{summary.supportEmail}</a>.</p>
      </aside>}
      <nav className="actions staff-workspace-nav" aria-label="Customer workspace">
        {(active ? tabs : ['Invoices'] as const).map((name) => <button key={name} type="button"
          aria-pressed={name === tab} onClick={() => { setTab(name); setError(''); }}>{name}</button>)}
        <button type="button" onClick={refreshAccess}>Refresh access</button>
      </nav>
      {tab === 'Invoices' && <Invoices onError={showError} />}
      {active && tab === 'Outlets' && <Outlets onError={paidError} />}
      {active && tab === 'Downloads' && <Downloads onError={paidError} />}
      {active && tab === 'Tickets' && <PortalTickets onError={paidError} />}
    </>}
  </>;
}
