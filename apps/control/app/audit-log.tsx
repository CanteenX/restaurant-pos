import { useEffect, useState } from 'react';
import { ApiError, call, pagePath } from './api';

type AuditEvent = {
  sequence: string; occurredAtMs: string; action: string; outcome: string;
  actorType: string; actorId: string; subjectType: string; subjectId: string | null;
};
type AuditPage = { items: AuditEvent[]; nextCursor: string | null };

export function AuditLog({ onExpired }: { onExpired: () => void }) {
  const [history, setHistory] = useState<(string | null)[]>([null]);
  const cursor = history[history.length - 1];
  return <section className="detail"><h1>Audit log</h1>
    <Events key={cursor ?? 'first'} cursor={cursor} onExpired={onExpired}
      next={(value) => setHistory(previous => [...previous,value])}
      back={() => setHistory(previous => previous.slice(0,-1))} />
  </section>;
}

function Events({ cursor, next, back, onExpired }: {
  cursor: string | null; next: (cursor: string) => void; back: () => void; onExpired: () => void;
}) {
  const [page, setPage] = useState<AuditPage>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void call<AuditPage>(pagePath('audit-events?limit=20',cursor),undefined,controller.signal).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) return onExpired();
      setError(failure instanceof ApiError && failure.status === 403
        ? 'Your current permissions do not allow access to the audit log.' : 'Could not load the audit log.');
    });
    return () => controller.abort();
  }, [cursor,onExpired]);
  if (error) return <p role="alert">{error}</p>;
  if (!page) return <p role="status">Loading audit events…</p>;
  const nextCursor = page.nextCursor;
  return <>
    {page.items.length ? <div className="table-scroll" role="region" tabIndex={0} aria-label="Audit events table"><table aria-label="Audit events">
      <thead><tr>{['Time','Action','Result','Actor','Subject'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{page.items.map(event => <tr key={event.sequence}>
        <td>{new Date(Number(event.occurredAtMs)).toLocaleString()}</td><td>{event.action}</td><td>{event.outcome}</td>
        <td>{event.actorType} <code>{event.actorId}</code></td>
        <td>{event.subjectType} {event.subjectId && <code>{event.subjectId}</code>}</td>
      </tr>)}</tbody>
    </table></div> : <p>No audit events found.</p>}
    <div className="actions">
      {cursor && <button type="button" onClick={back}>Previous</button>}
      {nextCursor && <button type="button" onClick={() => next(nextCursor)}>Next</button>}
    </div>
  </>;
}
