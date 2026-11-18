'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, call, pagePath, useRequestScope, type Page } from './api';
import { ticketPatch } from '@nventra/types/dist/control-ticket';
import { TicketReply, type ReplyTarget } from './ticket-reply';
import { TicketAssignment } from './ticket-routing';

export const statuses = ticketPatch.shape.status.unwrap().options;
const priorities = ticketPatch.shape.priority.unwrap().options;
export type Ticket = {
  id: string; subject: string; status: (typeof statuses)[number]; priority: (typeof priorities)[number];
  businessId: string | null; outletId: string | null; ownerId: string | null; unansweredSince?: string;
};
export type TicketTriage = Pick<Ticket, 'status' | 'priority' | 'businessId' | 'outletId' | 'ownerId'>;
const triageOf = ({ status, priority, businessId, outletId, ownerId }: Ticket): TicketTriage =>
  ({ status, priority, businessId, outletId, ownerId });
export const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const deliveryLabels = new Map([
  ['queued', 'Queued'], ['sending', 'Sending'], ['held', 'Held for review'], ['sent', 'Sent'], ['failed', 'Delivery failed'],
]);
type Message = { id: string; direction: string; visibility: string; text: string; deliveryState?: string };
type Detail = Ticket & { messages: Page<Message>; replyTarget?: ReplyTarget | null; needsBusinessLinkConfirmation?: boolean };

export function TicketDetails({ id, manage, directory, reply, report, clearError, onTriageChange }: {
  id: string; manage: boolean; directory: boolean; reply: boolean; report: (failure: unknown) => void; clearError: () => void;
  onTriageChange: (id: string, triage: TicketTriage) => void;
}) {
  const path = 'tickets/' + id;
  const [ticket, setTicket] = useState<Detail | null>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState('');
  const requests = useRequestScope();
  const noteAttempt = useRef<{ text: string; key: string }>(undefined);

  useEffect(() => {
    const scope = requests.current;
    if (!scope) return;
    void call<Detail>(path, undefined, scope).then((detail) => {
      if (!scope.aborted) setTicket(detail);
    }).catch((failure: unknown) => {
      if (!scope.aborted) { setTicket(null); report(failure); }
    });
  }, [path, report, requests]);

  async function change(action: (scope: AbortSignal) => Promise<void>) {
    const scope = requests.current;
    if (!scope || scope.aborted || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    clearError();
    try { await action(scope); }
    catch (failure) {
      if (scope.aborted) return;
      if (failure instanceof ApiError && failure.status === 403) {
        setTicket(null);
        noteAttempt.current = undefined;
      }
      report(failure);
    } finally {
      inFlight.current = false;
      if (!scope.aborted) setBusy(false);
    }
  }

  function saveTriage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const parsed = ticketPatch.safeParse({ status: values.get('status'), priority: values.get('priority') });
    if (!ticket || !parsed.success || !parsed.data.status || !parsed.data.priority) return;
    const { status, priority } = parsed.data;
    const changed = { ...(status !== ticket.status && { status }), ...(priority !== ticket.priority && { priority }) };
    if (Object.keys(changed).length === 0) return;
    savePatch(changed);
  }

  function savePatch(patch: ReturnType<typeof ticketPatch.parse>, success = '') {
    void change(async (scope) => {
      await call(path, patch, undefined, 'PATCH');
      if (scope.aborted) return;
      const refreshed = await call<Detail>(path, undefined, scope);
      if (scope.aborted) return;
      setTicket((current) => current && { ...refreshed, messages: current.messages });
      onTriageChange(id, triageOf(refreshed));
      setNotice(success);
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
      onTriageChange(id, triageOf(refreshed));
      noteAttempt.current = undefined;
      form.reset();
      setNotice('Internal note added.');
    });
  }

  async function refreshConversation(scope: AbortSignal) {
    const refreshed = await call<Detail>(path, undefined, scope);
    if (!scope.aborted) {
      setTicket(refreshed);
      onTriageChange(id, triageOf(refreshed));
    }
  }

  function more() {
    const cursor = ticket?.messages.nextCursor;
    if (!cursor) return;
    void change(async (scope) => {
      const next = await call<Detail>(pagePath(path, cursor), undefined, scope);
      if (scope.aborted) return;
      setTicket((current) => current && {
        ...next, messages: { items: [...current.messages.items, ...next.messages.items], nextCursor: next.messages.nextCursor },
      });
      onTriageChange(id, triageOf(next));
    });
  }

  if (!ticket) return <section className="detail">
    <p role="status">{ticket === null ? 'Ticket unavailable.' : 'Loading ticket…'}</p>
    {ticket === null && <button type="button" disabled={busy} onClick={() => void change(refreshConversation)}>Retry ticket</button>}
  </section>;

  return <section className="detail ticket-detail">
    <h2>{ticket.subject}</h2>
    <p>{label(ticket.status)} · {label(ticket.priority)} priority</p>
    {manage && <form key={ticket.status + ticket.priority} onSubmit={saveTriage}>
      <fieldset className="ticket-status" disabled={busy}>
        <label>Status<select name="status" defaultValue={ticket.status}>
          {statuses.map((status) => <option key={status} value={status}>{label(status)}</option>)}
        </select></label>
        <label>Priority<select name="priority" defaultValue={ticket.priority}>
          {priorities.map((priority) => <option key={priority} value={priority}>{label(priority)}</option>)}
        </select></label>
        <button className="primary" type="submit">Save status and priority</button>
      </fieldset>
    </form>}
    {manage && <TicketAssignment key={[ticket.businessId, ticket.outletId, ticket.ownerId].join(':')}
      ticket={ticket} directory={directory} busy={busy} save={(patch) => savePatch(patch, 'Ticket assignment saved.')} />}
    <h3>Conversation</h3>
    <button type="button" disabled={busy} onClick={() => void change(refreshConversation)}>Refresh conversation</button>
    {!ticket.messages.items.length && <p>No messages yet.</p>}
    <ol className="ticket-thread">{ticket.messages.items.map((message) => {
      const outbound = message.visibility === 'public' && message.direction === 'outbound';
      const status = outbound && deliveryLabels.get(message.deliveryState ?? '');
      const title = message.visibility === 'staff' ? 'Internal note' : outbound
        ? (message.deliveryState ? 'Email reply' : 'Staff reply') : 'Customer message';
      return <li key={message.id}>
        <article className={message.visibility === 'staff' ? 'ticket-note' : 'ticket-message'}>
          <strong>{title}</strong>
          {status && <small>{status}</small>}
          <p>{message.text}</p>
        </article>
      </li>;
    })}</ol>
    {ticket.messages.nextCursor && <button disabled={busy} onClick={more}>More messages</button>}
    {manage && <form onSubmit={addNote}><fieldset disabled={busy}>
      <label>Internal note<textarea name="note" maxLength={4000} required rows={3} /></label>
      <small>Visible only to staff.</small>
      <button className="primary" type="submit">Add internal note</button>
    </fieldset></form>}
    {reply && (ticket.replyTarget ?
      <TicketReply key={ticket.replyTarget.address + ':' + ticket.replyTarget.verified}
        path={path} target={ticket.replyTarget} busy={busy} change={change}
        refresh={refreshConversation} queued={() => setNotice('Reply queued.')} /> :
      <p>No reply address is available for this ticket.</p>)}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
