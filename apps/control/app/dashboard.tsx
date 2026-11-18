'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { controlPermissionSatisfied } from '@nventra/types/dist/permissions';
import { ApiError, call, pagePath, type Page, type Session } from './api';
import { OutletPlans } from './outlet-plans';

type Business = { id: string; displayName: string; legalName: string; archived: boolean };
type Outlet = { id: string; displayName: string; timeZone: string; archived: boolean };
type Fail = (failure: unknown) => void;
const empty = { items: [], nextCursor: null };

function Directory<T extends Business | Outlet>({ path, name, onSelect, onError, allowCreate, selectedId }: {
  path: string; name: 'business' | 'outlet'; onSelect: (item: T) => void; onError: Fail; allowCreate: boolean; selectedId?: string;
}) {
  const [page, setPage] = useState<Page<T>>(empty);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void call<Page<T>>(path, undefined, controller.signal).then(setPage).catch((failure) => {
      if (!controller.signal.aborted) onError(failure);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, onError]);
  const [creating, setCreating] = useState(false);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setLoading(true);
    try {
      const record = await call<T>(path, Object.fromEntries(new FormData(form)));
      setPage((current) => ({ ...current, items: [...current.items, record] }));
      setCreating(false);
      onSelect(record);
    } catch (failure) { onError(failure); } finally { setLoading(false); }
  }
  async function more() {
    setLoading(true);
    try {
      const next = await call<Page<T>>(pagePath(path, page.nextCursor));
      setPage({ items: [...new Map([...page.items, ...next.items].map((item) => [item.id, item])).values()], nextCursor: next.nextCursor });
    } catch (failure) { onError(failure); } finally { setLoading(false); }
  }
  const label = name === 'business' ? 'Businesses' : 'Outlets';
  return <section className="directory" aria-label={label}>
    <h2>{label}</h2>
    <ul>{page.items.map((item) => <li key={item.id}><button aria-pressed={selectedId === item.id} onClick={() => onSelect(item)}>
      {item.displayName}{item.archived && <small>Archived</small>}
    </button></li>)}</ul>
    {loading ? <p role="status">Loading…</p> : page.items.length === 0 && <p>No {label.toLowerCase()} yet.</p>}
    {page.nextCursor !== null && <button disabled={loading} onClick={more}>More {label.toLowerCase()}</button>}
    {allowCreate && !creating && <button disabled={loading} onClick={() => setCreating(true)}>Add {name}</button>}
    {creating && <form onSubmit={add}><fieldset disabled={loading}>
      <label>Display name<input name="displayName" maxLength={160} required /></label>
      {name === 'business' ? <label>Legal name<input name="legalName" maxLength={160} required /></label> :
        <label>Time zone<input name="timeZone" placeholder="Asia/Kolkata" maxLength={64} required /></label>}
      <div className="actions"><button type="submit" className="primary">Save {name}</button>
        <button type="button" onClick={() => setCreating(false)}>Cancel</button></div>
    </fieldset></form>}
  </section>;
}

export function Dashboard({ session, onExpired }: { session: Session; onExpired: () => void }) {
  const [business, setBusiness] = useState<Business>();
  const [outlet, setOutlet] = useState<Outlet>();
  const [notice, setNotice] = useState('');
  const can = (key: Parameters<typeof controlPermissionSatisfied>[1]) => controlPermissionSatisfied(session.grants, key);
  const onError = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) return onExpired();
    setNotice(failure instanceof ApiError && failure.status === 403 ? 'This action requires permission and recent verification.' :
      failure instanceof ApiError && failure.status === 409 ? 'These details conflict with an existing record.' :
      'The request could not be completed. Check the details and try again.');
  }, [onExpired]);
  function openBusiness(item: Business) { setBusiness(item); setOutlet(undefined); setNotice(''); }
  function openOutlet(item: Outlet) { setOutlet(item); setNotice(''); }

  return <>
    <h1>Client operations</h1>
    {notice && <p role="alert">{notice} <button onClick={() => setNotice('')}>Dismiss</button></p>}
    {can('cc.business.read') ? <div className="workspace">
      <Directory<Business> path="businesses" name="business" selectedId={business?.id} onSelect={openBusiness} onError={onError} allowCreate={can('cc.business.manage')} />
      {business && <Directory<Outlet> key={business.id} path={'businesses/' + business.id + '/outlets'}
        name="outlet" selectedId={outlet?.id} onSelect={openOutlet} onError={onError} allowCreate={!business.archived && can('cc.business.manage')} />}
      <section className="detail">
        {outlet ? <><h2>{outlet.displayName}</h2><p>{business?.displayName} · {outlet.timeZone}</p>
          {can('cc.plan.read') && <OutletPlans key={outlet.id} outletId={outlet.id} onError={onError} onSaved={() => setNotice('')}
            allowManage={!business?.archived && !outlet.archived && can('cc.plan.manage')} verifiedAt={session.verifiedAt} />}
        </> : business ? <><h2>{business.displayName}</h2><p>{business.legalName}</p><p>Choose an outlet to see its service plan.</p></> : <p>Choose a business to find its outlets.</p>}
      </section>
    </div> : <p>Your current permissions do not include the client registry.</p>}
  </>;
}