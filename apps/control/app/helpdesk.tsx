'use client';

import { useCallback, useEffect, useState } from 'react';
import { controlPermissionSatisfied } from '@nventra/types/dist/permissions';
import { ApiError, call, pagePath, useRequestScope, type Page, type Session } from './api';
import { TicketDetails, label, statuses, type Ticket, type TicketStatus } from './ticket-details';

export function Helpdesk({ session, onExpired }: { session: Session; onExpired: () => void }) {
  const [filter, setFilter] = useState('');
  const manage = controlPermissionSatisfied(session.grants, 'cc.ticket.manage');
  return <>
    <h1>Helpdesk</h1>
    <label className="ticket-filter">Filter by status
      <select value={filter} onChange={(event) => setFilter(event.currentTarget.value)}>
        <option value="">All statuses</option>
        {statuses.map((status) => <option key={status} value={status}>{label(status)}</option>)}
      </select>
    </label>
    <TicketQueue key={filter} filter={filter} manage={manage} onExpired={onExpired} />
  </>;
}

function TicketQueue({ filter, manage, onExpired }: { filter: string; manage: boolean; onExpired: () => void }) {
  const path = filter ? 'tickets?status=' + encodeURIComponent(filter) : 'tickets';
  const [page, setPage] = useState<Page<Ticket>>();
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requests = useRequestScope();

  const report = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) return onExpired();
    setError(failure instanceof ApiError && failure.status === 403
      ? 'Your current permissions do not allow this action.' : 'Could not complete the ticket request. Try again.');
  }, [onExpired]);

  useEffect(() => {
    const scope = requests.current;
    if (!scope) return;
    void call<Page<Ticket>>(path, undefined, scope).then(setPage).catch((failure: unknown) => {
      if (!scope.aborted) report(failure);
    });
  }, [path, report, requests]);

  async function more() {
    const scope = requests.current;
    if (!page?.nextCursor || !scope || scope.aborted) return;
    setLoading(true);
    setError('');
    try {
      const next = await call<Page<Ticket>>(pagePath(path, page.nextCursor), undefined, scope);
      setPage((current) => current && { items: [...current.items, ...next.items], nextCursor: next.nextCursor });
    } catch (failure) { if (!scope.aborted) report(failure); } finally { if (!scope.aborted) setLoading(false); }
  }

  function statusChanged(id: string, status: TicketStatus) {
    setPage((current) => current && {
      ...current, items: current.items.map((ticket) => ticket.id === id ? { ...ticket, status } : ticket)
        .filter((ticket) => !filter || ticket.status === filter),
    });
    if (filter && filter !== status) setSelected(undefined);
  }

  return <>
    {error && <p role="alert">{error}</p>}
    <div className="workspace helpdesk-workspace">
      <section className="directory" aria-label="Ticket queue">
        <h2>Ticket queue</h2>
        {!page && !error && <p role="status">Loading tickets…</p>}
        {page && !page.items.length && <p>No tickets found.</p>}
        <ul>{page?.items.map((ticket) => <li key={ticket.id}>
          <button aria-pressed={selected === ticket.id} onClick={() => { setSelected(ticket.id); setError(''); }}>
            {ticket.subject}<small>{label(ticket.status)}</small>
          </button>
        </li>)}</ul>
        {page?.nextCursor && <button disabled={loading} onClick={more}>More tickets</button>}
      </section>
      {selected ? <TicketDetails key={selected} id={selected} manage={manage} report={report}
        clearError={() => setError('')} onStatusChange={statusChanged} /> :
        <section className="detail"><p>Choose a ticket to view its conversation.</p></section>}
    </div>
  </>;
}