'use client';

import { useEffect, useId, useState } from 'react';
import { call, pagePath, useRequestScope, type Page } from './api';
import { ticketPatch } from '@nventra/types/dist/control-ticket';

type Scope = { businessId: string; outletId: string };
type Choice = { id: string; displayName?: string; email?: string };

function DirectoryChoice({ label, empty, path, value, select }: {
  label: string; empty: string; path: string; value: string; select: (id: string) => void;
}) {
  const labelId = useId();
  const [page, setPage] = useState<Page<Choice>>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const requests = useRequestScope();

  useEffect(() => {
    const signal = requests.current;
    if (!signal) return;
    void call<Page<Choice>>(path, undefined, signal).then((result) => {
      if (!signal.aborted) setPage(result);
    }).catch(() => { if (!signal.aborted) setFailed(true); });
  }, [path, requests]);

  async function more() {
    const signal = requests.current;
    if (!page?.nextCursor || !signal || signal.aborted || loading) return;
    setLoading(true);
    try {
      const result = await call<Page<Choice>>(pagePath(path, page.nextCursor), undefined, signal);
      if (!signal.aborted) setPage({ items: [...page.items, ...result.items], nextCursor: result.nextCursor });
    } catch {
      if (!signal.aborted) { setPage(undefined); setFailed(true); }
    } finally { if (!signal.aborted) setLoading(false); }
  }

  return <div>
    <label><span id={labelId}>{label}</span><select aria-labelledby={labelId}
      value={value} disabled={!page} onChange={(event) => select(event.currentTarget.value)}>
      <option value="">{empty}</option>
      {page && value && !page.items.some((choice) => choice.id === value) &&
        <option value={value}>Current selection</option>}
      {page?.items.map((choice) => <option key={choice.id} value={choice.id}>{choice.displayName ?? choice.email}</option>)}
    </select></label>
    {page?.nextCursor && <button type="button" onClick={() => void more()} disabled={loading}>More choices for {label.toLowerCase()}</button>}
    {failed && <small role="status">Could not load {label.toLowerCase()} choices.</small>}
  </div>;
}

export function BusinessOutletChoice({ scope, change, filter }: { scope: Scope; change: (scope: Scope) => void; filter?: boolean }) {
  return <>
    <DirectoryChoice label={filter ? 'Filter by business' : 'Ticket business'} path="businesses"
      empty={filter ? 'All businesses' : 'No business'} value={scope.businessId}
      select={(businessId) => change({ businessId, outletId: '' })} />
    {scope.businessId && <DirectoryChoice key={scope.businessId} label={filter ? 'Filter by outlet' : 'Ticket outlet'}
      path={'businesses/' + scope.businessId + '/outlets'} empty={filter ? 'All outlets' : 'No outlet'}
      value={scope.outletId} select={(outletId) => change({ ...scope, outletId })} />}
  </>;
}

export function TicketAssignment({ ticket, busy, directory, save }: {
  ticket: { businessId: string | null; outletId: string | null; ownerId: string | null; needsBusinessLinkConfirmation?: boolean };
  busy: boolean; directory: boolean; save: (change: ReturnType<typeof ticketPatch.parse>) => void;
}) {
  const [scope, setScope] = useState<Scope>({ businessId: ticket.businessId ?? '', outletId: ticket.outletId ?? '' });
  const [ownerId, setOwnerId] = useState(ticket.ownerId ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const businessChanged = (scope.businessId || null) !== ticket.businessId;
  const outletChanged = (scope.outletId || null) !== ticket.outletId;
  const ownerChanged = (ownerId || null) !== ticket.ownerId;
  const requireConfirmation = Boolean(ticket.needsBusinessLinkConfirmation && businessChanged && scope.businessId);

  return <form onSubmit={(event) => {
    event.preventDefault();
    const result = ticketPatch.safeParse({
      ...(businessChanged && { businessId: scope.businessId || null }),
      ...(outletChanged && { outletId: scope.outletId || null }),
      ...(ownerChanged && { ownerId: ownerId || null }),
      ...(requireConfirmation && confirmed && { confirmedBusinessLink: true }),
    });
    if (result.success && (!requireConfirmation || confirmed)) save(result.data);
  }}>
    <fieldset disabled={busy}>
      <legend>Assignment</legend>
      {directory && <BusinessOutletChoice scope={scope} change={(next) => {
        if (next.businessId !== scope.businessId) setConfirmed(false);
        setScope(next);
      }} />}
      <DirectoryChoice label="Ticket owner" path="tickets/eligible-owners" empty="Unassigned" value={ownerId} select={setOwnerId} />
      {requireConfirmation && <label className="reply-acknowledgment">
        <input type="checkbox" checked={confirmed} required onChange={(event) => setConfirmed(event.currentTarget.checked)} />
        I verified that this email belongs to the selected business.
      </label>}
      <button className="primary" type="submit" disabled={!(businessChanged || outletChanged || ownerChanged) ||
        (requireConfirmation && !confirmed)}>Save assignment</button>
    </fieldset>
  </form>;
}
