import { useEffect, useRef, useState, type FormEvent } from 'react';
import { call, pagePath, useRequestScope, type Page } from '../api';

type Failure = (error: unknown) => void;
type Invoice = { id: string; reference: string; description: string; dueOn: string; amountPaise: number; balancePaise: number };
type Payment = { id: string; reference: string; method: string; amountPaise: number };
type Outlet = { id: string; displayName: string; timeZone: string;
  plan: { label: string; startsAt: string; endsAt: string } | null };
type Download = { id: string; label: string };
type Ticket = { id: string; subject: string; status: string };
type Message = { id: string; direction: 'inbound' | 'outbound'; text: string };
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

function useCollection<T>(path: string, onError: Failure, refresh = 0) {
  const [data, setData] = useState<Page<T>>();
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);

  useEffect(() => {
    const scope = new AbortController();
    active.current = scope;
    void call<Page<T>>(path, undefined, scope.signal).then((page) => {
      if (!scope.signal.aborted) setData(page);
    }).catch((error: unknown) => {
      if (scope.signal.aborted) return;
      setData(undefined);
      onError(error);
    });
    return () => scope.abort();
  }, [path, refresh, onError]);

  async function more() {
    const scope = active.current;
    if (!scope || scope.signal.aborted || !data?.nextCursor || pending.current) return;
    pending.current = true;
    setLoading(true);
    try {
      const page = await call<Page<T>>(pagePath(path, data.nextCursor), undefined, scope.signal);
      if (!scope.signal.aborted) setData((current) => current && ({
        items: [...current.items, ...page.items], nextCursor: page.nextCursor,
      }));
    } catch (error) {
      if (!scope.signal.aborted) {
        setData(undefined);
        onError(error);
      }
    } finally {
      pending.current = false;
      setLoading(false);
    }
  }
  return { data, more, loading };
}

function Payments({ id, onError }: { id: string; onError: Failure }) {
  const { data, more, loading } = useCollection<Payment>('portal/invoices/' + encodeURIComponent(id) + '/payments', onError);
  return <section aria-label="Invoice payments">
    {data?.items.length === 0 && <p>No payments recorded.</p>}
    {!!data?.items.length && <ul>{data.items.map((payment) => <li key={payment.id}>
      {payment.reference} · {payment.method === 'upi' ? 'UPI' : 'Bank transfer'} · {inr.format(payment.amountPaise / 100)}
    </li>)}</ul>}
    {data?.nextCursor && <button type="button" disabled={loading} onClick={more}>More payments</button>}
  </section>;
}

export function Invoices({ onError }: { onError: Failure }) {
  const [selected, setSelected] = useState<string>();
  const { data, more, loading } = useCollection<Invoice>('portal/invoices', onError);
  return <section className="detail" aria-label="Invoices"><h2>Invoices</h2>
    {data?.items.length === 0 && <p>No invoices.</p>}
    {!!data?.items.length && <div className="table-scroll"><table>
      <thead><tr><th scope="col">Reference</th><th scope="col">Due date</th><th scope="col">Invoice amount</th>
        <th scope="col">Balance</th><th scope="col">Payments</th></tr></thead>
      <tbody>{data.items.map((row) => <tr key={row.id}>
        <td><strong>{row.reference}</strong><br />{row.description}</td><td>{row.dueOn}</td>
        <td>{inr.format(row.amountPaise / 100)}</td><td>{inr.format(row.balancePaise / 100)}</td>
        <td><button type="button" aria-expanded={selected === row.id} onClick={() => setSelected(selected === row.id ? undefined : row.id)}>View payments</button></td>
      </tr>)}</tbody>
    </table></div>}
    {data?.nextCursor && <button type="button" disabled={loading} onClick={more}>More invoices</button>}
    {selected && data?.items.some((row) => row.id === selected) && <Payments key={selected} id={selected} onError={onError} />}
  </section>;
}

export function Outlets({ onError }: { onError: Failure }) {
  const { data, more, loading } = useCollection<Outlet>('portal/outlets', onError);
  return <section className="detail" aria-label="Outlets"><h2>Outlets and service plans</h2>
    {data?.items.length === 0 && <p>No active outlets.</p>}
    {!!data?.items.length && <ul>{data.items.map((outlet) => <li key={outlet.id}>
      <strong>{outlet.displayName}</strong> · {outlet.timeZone}
      {outlet.plan && <p><strong>{outlet.plan.label}</strong> · Ends {outlet.plan.endsAt.slice(0, 10)}</p>}
    </li>)}</ul>}
    {data?.nextCursor && <button type="button" disabled={loading} onClick={more}>More outlets</button>}
  </section>;
}

export function Downloads({ onError }: { onError: Failure }) {
  const { data } = useCollection<Download>('portal/downloads', onError);
  return <section className="detail" aria-label="Downloads"><h2>Downloads</h2>
    {data?.items.length === 0 && <p>No files are available.</p>}
    {!!data?.items.length && <ul>{data.items.map((file) => <li key={file.id}>
      <a href={'/api/control/v1/portal/downloads/' + encodeURIComponent(file.id)} download>{file.label}</a>
    </li>)}</ul>}
  </section>;
}

function TicketConversation({ id, onError }: { id: string; onError: Failure }) {
  const path = 'portal/tickets/' + encodeURIComponent(id);
  const [ticket, setTicket] = useState<(Ticket & { messages: Page<Message> })>();
  const requests = useRequestScope();
  const paging = useRef(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const scope = requests.current;
    if (!scope) return;
    void call<Ticket & { messages: Page<Message> }>(path, undefined, scope).then((value) => {
      if (!scope.aborted) setTicket(value);
    }).catch((error: unknown) => {
      if (!scope.aborted) onError(error);
    });
  }, [path, onError, requests]);

  async function more() {
    const scope = requests.current;
    if (!scope || scope.aborted || !ticket?.messages.nextCursor || paging.current) return;
    paging.current = true;
    setLoading(true);
    try {
      const next = await call<Ticket & { messages: Page<Message> }>(pagePath(path, ticket.messages.nextCursor), undefined, scope);
      if (!scope.aborted) setTicket((current) => current && ({
        ...next, messages: { items: [...current.messages.items, ...next.messages.items], nextCursor: next.messages.nextCursor },
      }));
    } catch (error) {
      if (!scope.aborted) {
        setTicket(undefined);
        onError(error);
      }
    } finally {
      paging.current = false;
      if (!scope.aborted) setLoading(false);
    }
  }

  return ticket && <section aria-label="Ticket conversation">
    <h3>{ticket.subject}</h3>
    <ol>{ticket.messages.items.map((message) => <li key={message.id}>
      <strong>{message.direction === 'outbound' ? 'Nventra support' : 'Customer'}</strong>
      <p style={{ whiteSpace: 'pre-wrap' }}>{message.text}</p>
    </li>)}</ol>
    {ticket.messages.nextCursor && <button type="button" disabled={loading} onClick={more}>More messages</button>}
  </section>;
}

export function PortalTickets({ onError }: { onError: Failure }) {
  const [selected, setSelected] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const requests = useRequestScope();
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined);
  const pending = useRef(false);
  const { data, more, loading } = useCollection<Ticket>('portal/tickets', onError, refresh);

  async function raise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scope = requests.current;
    if (!scope || scope.aborted || pending.current) return;
    const form = event.currentTarget, fields = new FormData(form);
    const body = { subject: String(fields.get('subject')).trim(), text: String(fields.get('text')).trim() };
    if (!body.subject || !body.text) return;
    const fingerprint = JSON.stringify(body);
    const requestKey = attempt.current?.body === fingerprint ? attempt.current.key : crypto.randomUUID();
    attempt.current = { body: fingerprint, key: requestKey };
    pending.current = true;
    setBusy(true);
    try {
      await call('portal/tickets', { ...body, requestKey });
      if (scope.aborted) return;
      form.reset();
      attempt.current = undefined;
      setRefresh((value) => value + 1);
    } catch (error) {
      if (!scope.aborted) onError(error);
    } finally {
      pending.current = false;
      if (!scope.aborted) setBusy(false);
    }
  }

  return <section className="detail" aria-label="Support tickets"><h2>Support tickets</h2>
    <form onSubmit={raise}><fieldset disabled={busy}>
      <label>Subject<input name="subject" required maxLength={160} /></label>
      <label>Message<textarea name="text" required maxLength={4000} rows={4} /></label>
      <button className="primary">Raise ticket</button>
    </fieldset></form>
    {data && <ul>{data.items.map((ticket) => <li key={ticket.id}>
      <button type="button" aria-pressed={selected === ticket.id} onClick={() => setSelected(ticket.id)}>{ticket.subject}</button> · {ticket.status}
    </li>)}</ul>}
    {data?.nextCursor && <button type="button" disabled={loading} onClick={more}>More tickets</button>}
    {selected && data?.items.some((row) => row.id === selected) && <TicketConversation key={selected} id={selected} onError={onError} />}
  </section>;
}
