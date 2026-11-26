'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { call, pagePath, useRequestScope, type Page } from './api';

type Plan = { code: string; version: number; label: string };
type Term = { id: string; operation: 'assign' | 'renew' | 'cancel'; startsAt: string | null; endsAt: string | null; planCode: string | null; planVersion: number | null };
const operationLabels = { assign: 'Assigned', renew: 'Renewed', cancel: 'Cancelled' };
const day = (value: Date) => value.toISOString().slice(0, 10);
const dateLabel = (value: string | null) => value ? day(new Date(value)) : '—';

export function OutletPlans({ outletId, verifiedAt, allowManage, onError, onSaved }: {
  outletId: string; verifiedAt: string; allowManage: boolean; onError: (failure: unknown) => void; onSaved: () => void;
}) {
  const path = 'outlets/' + outletId + '/service-plans';
  const [catalog, setCatalog] = useState<Plan[]>();
  const [history, setHistory] = useState<Page<Term>>();
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const requests = useRequestScope();
  const attempt = useRef<{ body: string; key: string }>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([call<Plan[]>('plans', undefined, controller.signal), call<Page<Term>>(path, undefined, controller.signal)])
      .then(([plans, terms]) => { setCatalog(plans); setHistory(terms); })
      .catch((failure: unknown) => { if (!controller.signal.aborted) onError(failure); });
    return () => controller.abort();
  }, [path, onError]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const latest = history?.items[0];
  const ending = latest?.endsAt;
  const operation = ending ? 'renew' : 'assign';
  const today = day(new Date(clock));
  const earliestRenewal = ending && day(new Date(Math.ceil(Date.parse(ending) / 86_400_000) * 86_400_000));
  const recommendedStart = earliestRenewal && earliestRenewal > today ? earliestRenewal : today;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scope = requests.current;
    if (!scope || scope.aborted) return;
    const values = new FormData(event.currentTarget);
    const [planCode, planVersion] = String(values.get('plan')).split(':');
    const startsAt = new Date(String(values.get('starts'))).toISOString();
    const endsAt = new Date(String(values.get('ends'))).toISOString();
    const change = { planCode, planVersion: Number(planVersion), startsAt, endsAt };
    const body = JSON.stringify([operation, change]);
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    try {
      await call<Term>(path + '/' + operation, { ...change, requestKey: attempt.current.key });
      if (scope.aborted) return;
      const latestHistory = await call<Page<Term>>(path, undefined, scope);
      if (scope.aborted) return;
      setHistory(latestHistory);
      attempt.current = undefined;
      onSaved();
    } catch (failure) { if (!scope.aborted) onError(failure); } finally { if (!scope.aborted) setBusy(false); }
  }

  async function more() {
    const scope = requests.current;
    if (!history || !scope || scope.aborted) return;
    setBusy(true);
    try {
      const next = await call<Page<Term>>(pagePath(path, history.nextCursor), undefined, scope);
      if (!scope.aborted) setHistory({ items: [...history.items, ...next.items], nextCursor: next.nextCursor });
    } catch (failure) { if (!scope.aborted) onError(failure); } finally { if (!scope.aborted) setBusy(false); }
  }

  if (!catalog || !history) return <p role="status">Loading service plans…</p>;
  return <>
    {ending && Date.parse(ending) > clock && <aside><h3>Upcoming renewal</h3><p>Term ends <time dateTime={ending}>{dateLabel(ending)} UTC</time>.</p></aside>}
    {allowManage && (clock - Date.parse(verifiedAt) <= 600_000 ?
      <form key={latest?.id ?? 'initial'} onSubmit={save}><fieldset disabled={busy}>
        <legend>{operation === 'assign' ? 'Assign service plan' : 'Renew service plan'}</legend>
        <label>Plan<select name="plan" required defaultValue={latest?.planCode ? latest.planCode + ':' + latest.planVersion : ''}>
          <option value="" disabled>Choose a plan</option>
          {catalog.map((plan) => <option key={plan.code + ':' + plan.version} value={plan.code + ':' + plan.version}>{plan.label} · v{plan.version}</option>)}
        </select></label>
        <div className="dates">
          <label>Starts on<input type="date" name="starts" defaultValue={recommendedStart} required /></label>
          <label>Ends on<input type="date" name="ends" required /></label>
        </div>
        <small>Dates start at midnight UTC.</small>
        <button className="primary" type="submit">{operation === 'assign' ? 'Assign plan' : 'Renew plan'}</button>
      </fieldset></form> : <p>Sign in again to change service plans.</p>)}
    <details><summary>Plan catalog</summary><ul>{catalog.map((plan) =>
      <li key={plan.code + ':' + plan.version}>{plan.label} · v{plan.version}</li>)}</ul></details>
    <h3>Plan history</h3>
    {history.items.length ? <div className="table-scroll" role="region" tabIndex={0} aria-label="Plan history table"><table>
      <thead><tr><th scope="col">Change</th><th scope="col">Plan</th><th scope="col">Starts (UTC)</th><th scope="col">Ends (UTC)</th></tr></thead>
      <tbody>{history.items.map((term) => <tr key={term.id}><td>{operationLabels[term.operation]}</td>
        <td>{catalog.find((plan) => plan.code === term.planCode && plan.version === term.planVersion)?.label ?? term.planCode ?? '—'}</td>
        <td>{dateLabel(term.startsAt)}</td><td>{dateLabel(term.endsAt)}</td></tr>)}</tbody>
    </table></div> : <p>No service plan history yet.</p>}
    {history.nextCursor !== null && <button disabled={busy} onClick={more}>More plan history</button>}
  </>;
}
