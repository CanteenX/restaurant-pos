'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { visibleSections } from './team-permissions';
import { Team } from './team';
import { Dashboard } from './dashboard';
import { AuditLog } from './audit-log';
import { Helpdesk } from './helpdesk';
import { call, ApiError, type Session } from './api';

type Challenge = { challenge: string; enrollmentSecret?: string; invited?: boolean };

export default function ControlCenter() {
  const [session, setSession] = useState<Session | null>();
  const [challenge, setChallenge] = useState<Challenge>();
  const [codes, setCodes] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [workspace, setWorkspace] = useState('Client operations');
  const [invitation, setInvitation] = useState<string>();
  const available = visibleSections(session?.grants ?? []);
  const active = available.find(([name]) => name === workspace)?.[0] ?? available[0]?.[0];

  const billingAttempts = useRef(new Map<string, string>());
  const expire = useCallback(() => {
    billingAttempts.current.clear();
    setSession(null);
  }, []);

  useEffect(() => {
    const fragment = window.location.hash;
    if (fragment) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      const token = new URLSearchParams(fragment.slice(1)).get('token');
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) queueMicrotask(() => setInvitation(token));
    }
    const controller = new AbortController();
    void call<Session>('staff/session', undefined, controller.signal).then(setSession).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setSession(null);
      if (!(failure instanceof ApiError && failure.status === 401)) setError('Control Center is unavailable.');
    });
    return () => controller.abort();
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      if (!challenge) {
        if (invitation) {
          const accepted = await call<Challenge>('staff/users/invite/accept', { token: invitation,
            password: values.get('password'), name: values.get('name') || undefined });
          setChallenge({ ...accepted, invited: true });
          setInvitation(undefined);
          return;
        }
        const proof = values.get('proof');
        setChallenge(await call<Challenge>('staff/session/challenge', {
          email: values.get('email'), password: values.get('password'), ...(proof ? { enrollmentProof: proof } : {}),
        }));
        return;
      }
      const result = await call<{ recoveryCodes?: string[] }>(
        challenge.enrollmentSecret ? 'staff/enrollment' : 'staff/session/verify',
        { challenge: challenge.challenge, code: values.get('code') },
      );
      setChallenge(undefined);
      setCodes(result.recoveryCodes);
      setSession(await call<Session>('staff/session'));
    } catch {
      setError(challenge ? 'Verification failed.' : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setError('');
    try {
      await call('staff/session/logout', {});
      expire();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) expire();
      else setError('Sign-out failed. Try again.');
    }
  }

  return <>
    <header className="masthead"><div className="brand"><b aria-hidden="true">N</b><span>Nventra <small>Control Center</small></span></div>
      {session && !codes && <button type="button" onClick={signOut}>Sign out</button>}
    </header>
    <main>
      {error && <p role="alert">{error}</p>}
      {codes ? <section className="signin">
        <h1>Recovery codes</h1><p>Save these codes securely. Each can be used once in place of an authenticator code.</p>
        <ul className="codes">{codes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
        <button className="primary" onClick={() => setCodes(undefined)}>Done</button>
      </section> : session ? <>
        {available.length > 1 && <nav className="actions staff-workspace-nav" aria-label="Staff workspace">
          {available.map(([name]) => <button key={name} type="button" aria-pressed={active === name}
            onClick={() => setWorkspace(name)}>{name}</button>)}
        </nav>}
        {active === 'Audit log' ? <AuditLog onExpired={expire} /> : active === 'Helpdesk'
          ? <Helpdesk session={session} onExpired={expire} /> : active === 'Team' || active === 'Roles'
            ? <Team key={active} session={session} rolesOnly={active === 'Roles'} onExpired={expire} /> : active === 'Client operations'
              ? <Dashboard session={session} onExpired={expire} billingAttempts={billingAttempts} /> : <p>No sections are available for your current permissions.</p>}
      </> : session === null ?
        <section className="signin"><h1>{challenge ? 'Two-factor verification' : invitation ? 'Accept invitation' : 'Staff sign-in'}</h1>
          <form method="post" key={challenge ? 'factor' : 'credentials'} onSubmit={signIn}>
            <fieldset disabled={busy}>
              {challenge ? <>
                {challenge.enrollmentSecret && <p>Enter this key in your authenticator app. <code data-testid="authenticator-key">{challenge.enrollmentSecret}</code></p>}
                <label>Verification code<input name="code" autoComplete="one-time-code" maxLength={14} required /></label>
              </> : <>
                {invitation ? <label>Your name<input name="name" maxLength={120} autoComplete="name" /></label> : <label>Email<input name="email" type="email" autoComplete="username" required /></label>}
                <label>Password<input name="password" type="password" minLength={invitation ? 12 : undefined} autoComplete={invitation ? 'new-password' : 'current-password'} required /></label>
                {!invitation && <label>Enrollment proof <small>for first-time setup</small><input name="proof" type="password" autoComplete="off" /></label>}
              </>}
              <div className="actions">
                <button className="primary" type="submit">{challenge ? 'Verify' : 'Continue'}</button>
                {challenge && !challenge.invited && <button type="button" onClick={() => { setChallenge(undefined); setError(''); }}>Back</button>}
              </div>
            </fieldset>
          </form>
        </section> : <p role="status">Checking session…</p>}
    </main>
  </>;
}
