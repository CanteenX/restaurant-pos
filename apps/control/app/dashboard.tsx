'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { controlPermissionSatisfied } from '@nventra/types/dist/permissions';
import { ApiError, call, pagePath, useRequestScope, type Page, type Session } from './api';
import { OutletPlans } from './outlet-plans';
import { BusinessBilling, OverdueInvoices, UpcomingRenewals, type BillingAttempts } from './business-billing';
import { BusinessTicketHistory, HostedAccess, PortalContacts } from './business-access';

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
  const requests = useRequestScope();
  const [creating, setCreating] = useState(false);
  const [creationUnconfirmed, setCreationUnconfirmed] = useState(false);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scope = requests.current;
    if (!scope || scope.aborted || creationUnconfirmed) return;
    const form = event.currentTarget;
    setLoading(true);
    try {
      const record = await call<T>(path, Object.fromEntries(new FormData(form)));
      if (scope.aborted) return;
      setPage((current) => ({ ...current, items: [...current.items, record] }));
      setCreating(false);
      onSelect(record);
    } catch (failure) {
      if (scope.aborted) return;
      const unconfirmed = !(failure instanceof ApiError) || failure.status === 408 || failure.status >= 500;
      if (unconfirmed) {
        setCreationUnconfirmed(true);
        setCreating(false);
      } else {
        onError(failure);
      }
    } finally { if (!scope.aborted) setLoading(false); }
  }
  async function more() {
    const scope = requests.current;
    if (!scope || scope.aborted) return;
    setLoading(true);
    try {
      const next = await call<Page<T>>(pagePath(path, page.nextCursor), undefined, scope);
      if (!scope.aborted) {
        setPage({ items: [...new Map([...page.items, ...next.items].map((item) => [item.id, item])).values()], nextCursor: next.nextCursor });
      }
    } catch (failure) { if (!scope.aborted) onError(failure); } finally { if (!scope.aborted) setLoading(false); }
  }
  const label = name === 'business' ? 'Businesses' : 'Outlets';
  return <section className="directory" aria-label={label}>
    <h2>{label}</h2>
    <ul>{page.items.map((item) => <li key={item.id}><button aria-pressed={selectedId === item.id} onClick={() => onSelect(item)}>
      {item.displayName}{item.archived && <small>Archived</small>}
    </button></li>)}</ul>
    {loading ? <p role="status">Loading…</p> : page.items.length === 0 && <p>No {label.toLowerCase()} yet.</p>}
    {page.nextCursor !== null && <button disabled={loading} onClick={more}>More {label.toLowerCase()}</button>}
    {allowCreate && !creating && <button disabled={loading || creationUnconfirmed} onClick={() => setCreating(true)}>Add {name}</button>}
    {creationUnconfirmed && <p role="alert">Reload the directory and check whether it was created before submitting again.</p>}
    {creating && <form onSubmit={add}><fieldset disabled={loading}>
      <label>Display name<input name="displayName" maxLength={160} required /></label>
      {name === 'business' ? <label>Legal name<input name="legalName" maxLength={160} required /></label> :
        <label>Time zone<input name="timeZone" placeholder="Asia/Kolkata" maxLength={64} required /></label>}
      <div className="actions"><button type="submit" className="primary">Save {name}</button>
        <button type="button" onClick={() => setCreating(false)}>Cancel</button></div>
    </fieldset></form>}
  </section>;
}

export function Dashboard({ session, onExpired, billingAttempts }: { session: Session; onExpired: () => void; billingAttempts: BillingAttempts }) {
  const [business, setBusiness] = useState<Business>();
  const [outlet, setOutlet] = useState<Outlet>();
  const [notice, setNotice] = useState('');
  const [queue, setQueue] = useState<'overdue' | 'renewals'>();
  const [renewalRefresh, setRenewalRefresh] = useState(0);
  const [billingRefresh, setBillingRefresh] = useState(0);
  const [billingBlocked, setBillingBlocked] = useState(false);
  const requests = useRequestScope();
  const can = (key: Parameters<typeof controlPermissionSatisfied>[1]) => controlPermissionSatisfied(session.grants, key);
  const onError = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) return onExpired();
    setNotice(failure instanceof ApiError && failure.status === 403 ? 'This action requires permission and recent verification.' :
      failure instanceof ApiError && failure.status === 409 ? 'These details conflict with an existing record.' :
      'The request could not be completed. Check the details and try again.');
  }, [onExpired]);
  const onBillingReadError = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 403) {
      billingAttempts.current.clear();
      setBillingBlocked(true);
    }
    onError(failure);
  }, [billingAttempts, onError]);
  const canReadBilling = !billingBlocked && can('cc.billing.read');
  const selection = useRef(0);
  function openBusiness(item: Business) {
    selection.current += 1;
    setBusiness(item);
    setOutlet(undefined);
    setNotice('');
  }
  function openOutlet(item: Outlet) { setOutlet(item); setNotice(''); }
  async function openQueuedBusiness(id: string) {
    const signal = requests.current;
    if (!signal || signal.aborted) return;
    const intent = ++selection.current;
    try {
      const item = await call<Business>('businesses/' + id, undefined, signal);
      if (!signal.aborted && intent === selection.current) openBusiness(item);
    } catch (failure) { if (!signal.aborted && intent === selection.current) onError(failure); }
  }

  return <>
    <h1>Client operations</h1>
    {notice && <p role="alert">{notice} <button onClick={() => setNotice('')}>Dismiss</button></p>}
    <div className="actions">
      {canReadBilling && <button type="button" aria-expanded={queue === 'overdue'}
        onClick={() => setQueue(queue === 'overdue' ? undefined : 'overdue')}>Overdue invoices</button>}
      {can('cc.plan.read') && <button type="button" aria-expanded={queue === 'renewals'}
        onClick={() => setQueue(queue === 'renewals' ? undefined : 'renewals')}>Upcoming renewals</button>}
    </div>
    {queue === 'overdue' && canReadBilling &&
      <OverdueInvoices businessId={business?.id} onError={onBillingReadError} refresh={billingRefresh} openBusiness={openQueuedBusiness} />}
    {queue === 'renewals' && can('cc.plan.read') &&
      <UpcomingRenewals businessId={business?.id} onError={onError} refresh={renewalRefresh} openBusiness={openQueuedBusiness} />}
    {can('cc.business.read') ? <div className="workspace">
      <Directory<Business> path="businesses" name="business" selectedId={business?.id} onSelect={openBusiness} onError={onError} allowCreate={can('cc.business.manage')} />
      {business && <Directory<Outlet> key={business.id} path={'businesses/' + business.id + '/outlets'}
        name="outlet" selectedId={outlet?.id} onSelect={openOutlet} onError={onError} allowCreate={!business.archived && can('cc.business.manage')} />}
      <section className="detail">
        {outlet ? <><h2>{outlet.displayName}</h2><p>{business?.displayName} · {outlet.timeZone}</p>
          {can('cc.plan.read') && <OutletPlans key={outlet.id} outletId={outlet.id} onError={onError} onSaved={() => { setNotice(''); setRenewalRefresh((value) => value + 1); }}
            allowManage={!business?.archived && !outlet.archived && can('cc.plan.manage')} verifiedAt={session.verifiedAt} />}
        </> : business ? <><h2>{business.displayName}</h2><p>{business.legalName}</p><p>Choose an outlet to see its service plan.</p></> : <p>Choose a business to find its outlets.</p>}
        {business && can('cc.hosted.read') && <HostedAccess key={'access-' + business.id} id={business.id} name={business.displayName}
          manage={can('cc.hosted.manage') && !business.archived} onError={onError} />}
        {business && can('cc.portal.read') && <PortalContacts key={'contacts-' + business.id} id={business.id}
          manage={can('cc.portal.manage') && !business.archived} onError={onError} />}
        {business && can('cc.ticket.read') && <BusinessTicketHistory key={'tickets-' + business.id} id={business.id} onError={onError} />}
        {business && canReadBilling && <BusinessBilling key={business.id} id={business.id} attempts={billingAttempts}
          manage={can('cc.billing.manage') && !business.archived} onError={onError} onReadError={onBillingReadError}
          onChanged={() => setBillingRefresh((value) => value + 1)} />}
      </section>
    </div> : <p>Your current permissions do not include the client registry.</p>}
  </>;
}