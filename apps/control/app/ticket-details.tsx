'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { call, pagePath, useRequestScope, type Page } from './api';
import { ticketPatch } from '@nventra/types/dist/control-ticket';

export const ticketStatus = ticketPatch.shape.status.unwrap();
export const statuses = ticketStatus.options;
export type TicketStatus = (typeof statuses)[number];
export type Ticket = { id: string; subject: string; status: TicketStatus; priority: string };
export const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

type Message = { id: string; direction: string; visibility: string; text: string };
type Detail = Ticket & { messages: Page<Message> };

export function TicketDetails({ id, manage, report, clearError, onStatusChange }: {
  id: string; manage: boolean; report: (failure: unknown) => void; clearError: () => void;
  onStatusChange: (id: string, status: TicketStatus) => void;
}) {
  const path = 'tickets/' + id;
  const [ticket, setTicket] = useState<Detail | null>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const requests = useRequestScope();
  const noteAttempt = useRef<{ text: string; key: string }>(undefined);

  useEffect(() => {
    const scope = requests.current;
    if (!scope) return;
    void call<Detail>(path, undefined, scope).then(setTicket).catch((failure: unknown) => {
      if (!scope.aborted) { setTicket(null); report(failure); }
    });
  }, [path, report, requests]);

  async function change(action: (scope: AbortSignal) => Promise<void>) {
    const scope = requests.current;
    if (!scope || scope.aborted) return;
    setBusy(true);
    setNotice('');
    clearError();
    try { await action(scope); }
    catch (failure) { if (!scope.aborted) report(failure); }
    finally { if (!scope.aborted) setBusy(false); }
  }

  function saveStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = ticketStatus.safeParse(new FormData(event.currentTarget).get('status'));
    if (!parsed.success) return;
    const status = parsed.data;
    void change(async (scope) => {
      await call(path, { status }, undefined, 'PATCH');
      if (scope.aborted) return;
      setTicket((current) => current && { ...current, status });
      onStatusChange(id, status);
    });
  }

  function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const text = new FormData(form).get('note');
    if (typeof text !== 'string' || !text.trim()) { setNotice('Enter a note before saving.'); return; }
    const attempt = noteAttempt.current?.text === text ? noteAttempt.current : { text, key: crypto.randomUUID() };
    noteAttempt.current = attempt;
    void change(async (scope) => {
      await call(path + '/notes', { text, requestKey: attempt.key });
      if (scope.aborted) return;
      const refreshed = await call<Detail>(path, undefined, scope);
      if (scope.aborted) return;
      setTicket(refreshed);
      onStatusChange(id, refreshed.status);
      noteAttempt.current = undefined;
      form.reset();
      setNotice('Internal note added.');
    });
  }

  function more() {
    const cursor = ticket?.messages.nextCursor;
    if (!cursor) return;
    void change(async (scope) => {
      const next = await call<Detail>(pagePath(path, cursor), undefined, scope);
      if (!scope.aborted) setTicket((current) => current && {
        ...current, messages: { items: [...current.messages.items, ...next.messages.items], nextCursor: next.messages.nextCursor },
      });
    });
  }

  if (!ticket) return <section className="detail"><p role="status">{ticket === null ? 'Ticket unavailable.' : 'Loading ticket…'}</p></section>;

  return <section className="detail ticket-detail">
    <h2>{ticket.subject}</h2>
    <p>{label(ticket.status)} · {label(ticket.priority)} priority</p>
    {manage && <form key={ticket.status} onSubmit={saveStatus}>
      <fieldset className="ticket-status" disabled={busy}>
        <label>Status<select name="status" defaultValue={ticket.status}>
          {statuses.map((status) => <option key={status} value={status}>{label(status)}</option>)}
        </select></label>
        <button className="primary" type="submit">Save status</button>
      </fieldset>
    </form>}
    <h3>Conversation</h3>
    {!ticket.messages.items.length && <p>No messages yet.</p>}
    <ol className="ticket-thread">{ticket.messages.items.map((message) => <li key={message.id}>
      <article className={message.visibility === 'staff' ? 'ticket-note' : 'ticket-message'}>
        <strong>{message.visibility === 'staff' ? 'Internal note' : 'Customer message'}</strong>
        <p>{message.text}</p>
      </article>
    </li>)}</ol>
    {ticket.messages.nextCursor && <button disabled={busy} onClick={more}>More messages</button>}
    {manage && <form onSubmit={addNote}><fieldset disabled={busy}>
      <label>Internal note<textarea name="note" maxLength={4000} required rows={3} /></label>
      <small>Visible only to staff.</small>
      <button className="primary" type="submit">Add internal note</button>
    </fieldset></form>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}