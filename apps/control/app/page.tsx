'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Dashboard } from './dashboard';
import { call, ApiError, type Session } from './api';

type Challenge = { challenge: string; enrollmentSecret?: string };

export default function ControlCenter() {
  const [session, setSession] = useState<Session | null>();
  const [challenge, setChallenge] = useState<Challenge>();
  const [codes, setCodes] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const expire = useCallback(() => setSession(null), []);

  useEffect(() => {
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
      setSession(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) setSession(null);
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
      </section> : session ? <Dashboard session={session} onExpired={expire} /> : session === null ?
        <section className="signin"><h1>{challenge ? 'Two-factor verification' : 'Staff sign-in'}</h1>
          <form method="post" key={challenge ? 'factor' : 'credentials'} onSubmit={signIn}>
            <fieldset disabled={busy}>
              {challenge ? <>
                {challenge.enrollmentSecret && <p>Enter this key in your authenticator app. <code data-testid="authenticator-key">{challenge.enrollmentSecret}</code></p>}
                <label>Verification code<input name="code" autoComplete="one-time-code" maxLength={14} required /></label>
              </> : <>
                <label>Email<input name="email" type="email" autoComplete="username" required /></label>
                <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
                <label>Enrollment proof <small>for first-time setup</small><input name="proof" type="password" autoComplete="off" /></label>
              </>}
              <div className="actions">
                <button className="primary" type="submit">{challenge ? 'Verify' : 'Continue'}</button>
                {challenge && <button type="button" onClick={() => { setChallenge(undefined); setError(''); }}>Back</button>}
              </div>
            </fieldset>
          </form>
        </section> : <p role="status">Checking session…</p>}
    </main>
  </>;
}