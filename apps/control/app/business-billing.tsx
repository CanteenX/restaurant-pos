import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { call, pagePath, useRequestScope, type Page } from './api';
import { formatInr } from './money';

type Failure = (error: unknown) => void;
type Invoice = {
  id: string;
  businessId: string;
  reference: string;
  description: string;
  dueOn: string;
  amountPaise: number;
  paidPaise: number;
  balancePaise: number;
  overdue: boolean;
};
type Payment = {
  id: string;
  reference: string;
  amountPaise: number;
  method: 'bank_transfer' | 'upi';
};
export type BillingAttempts = RefObject<Map<string, string>>;

export function useOperationList<T>(path: string, refresh: number, onError: Failure) {
  const [result, setResult] = useState<{ path: string; page: Page<T> }>();
  const page = result?.path === path ? result.page : undefined;
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const paging = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void call<Page<T>>(path, undefined, controller.signal).then((result) => {
      if (!controller.signal.aborted) setResult({ path, page: result });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setResult(undefined);
      onError(error);
    });
    return () => controller.abort();
  }, [path, refresh, onError]);

  async function more() {
    const signal = request.current?.signal;
    if (!page?.nextCursor || !signal || signal.aborted || paging.current) return;
    paging.current = true;
    setLoading(true);
    try {
      const next = await call<Page<T>>(pagePath(path, page.nextCursor), undefined, signal);
      if (!signal.aborted) setResult((current) => current?.path === path ? { path, page: {
        items: [...current.page.items, ...next.items], nextCursor: next.nextCursor,
      } } : current);
    } catch (error) {
      if (!signal.aborted) {
        setResult(undefined);
        onError(error);
      }
    } finally {
      paging.current = false;
      setLoading(false);
    }
  }
  return { page, more, loading };
}

function amountInPaise(value: FormDataEntryValue | null) {
  if (typeof value !== 'string' || !/^\d{1,14}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

function RecordAmount({ path, kind, attempts, onSaved, onCancel, onError }: {
  path: string; kind: 'invoice' | 'payment'; attempts: BillingAttempts; onSaved: () => void; onCancel: () => void; onError: Failure;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState('');
  const scope = useRequestScope();
  const invoice = kind === 'invoice';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const signal = scope.current;
    if (!signal || signal.aborted || pending.current) return;
    const form = new FormData(event.currentTarget);
    const amountPaise = amountInPaise(form.get('amount'));
    if (!amountPaise) {
      setValidation('Enter a positive INR amount with up to two decimal places.');
      return;
    }
    setValidation('');
    const common = { reference: String(form.get('reference')).trim(), amountPaise };
    const body = invoice
      ? { ...common, description: String(form.get('description')).trim(), dueOn: form.get('dueOn') }
      : { ...common, method: form.get('method') };
    const attempt = path + '\n' + JSON.stringify(body);
    const requestKey = attempts.current.get(attempt) ?? crypto.randomUUID();
    attempts.current.set(attempt, requestKey);
    pending.current = true;
    setBusy(true);
    try {
      await call(path, { ...body, requestKey });
      if (attempts.current.get(attempt) === requestKey) attempts.current.delete(attempt);
      if (!signal.aborted) onSaved();
    } catch (error) {
      if (!signal.aborted) onError(error);
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  return <form onSubmit={submit}><fieldset disabled={busy}>
    <label>{invoice ? 'Invoice reference' : 'Payment reference'}<input name="reference" maxLength={120} required /></label>
    {invoice ? <>
      <label>Description<input name="description" maxLength={1000} required /></label>
      <label>Due date<input type="date" name="dueOn" required /></label>
    </> : <label>Payment method<select name="method" defaultValue="bank_transfer">
      <option value="bank_transfer">Bank transfer</option><option value="upi">UPI</option>
    </select></label>}
    <label>{invoice ? 'Invoice amount (INR)' : 'Payment amount (INR)'}<input name="amount" inputMode="decimal" required /></label>
    {validation && <p role="alert">{validation}</p>}
    <div className="actions"><button className="primary">Save {kind}</button>
      <button type="button" onClick={onCancel}>Cancel</button></div>
  </fieldset></form>;
}

function Payments({ invoice, path, manage, refresh, attempts, onChanged, onError, onReadError }: {
  invoice: Invoice; path: string; manage: boolean; refresh: number; attempts: BillingAttempts;
  onChanged: () => void; onError: Failure; onReadError: Failure;
}) {
  const [recording, setRecording] = useState(false);
  const { page, more, loading } = useOperationList<Payment>(path, refresh, onReadError);
  return <section aria-label="Payments">
    <h3>Payments for {invoice.reference}</h3>
    <p>Balance {formatInr(invoice.balancePaise)}</p>
    {page?.items.length === 0 && <p>No payments recorded.</p>}
    {!!page?.items.length && <ul>{page.items.map((payment) => <li key={payment.id}>
      <span>{payment.reference}</span> · {payment.method === 'upi' ? 'UPI' : 'Bank transfer'} · {formatInr(payment.amountPaise)}
    </li>)}</ul>}
    {page?.nextCursor && <button type="button" disabled={loading} onClick={more}>More payments</button>}
    {manage && invoice.balancePaise > 0 && !recording && <button type="button" onClick={() => setRecording(true)}>Record payment</button>}
    {recording && <RecordAmount path={path} kind="payment" attempts={attempts} onError={onError} onCancel={() => setRecording(false)}
      onSaved={() => { setRecording(false); onChanged(); }} />}
  </section>;
}

export function BusinessBilling({ id, manage, attempts, onError, onReadError, onChanged }: {
  id: string; manage: boolean; attempts: BillingAttempts; onError: Failure; onReadError: Failure; onChanged: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const path = 'businesses/' + id + '/invoices';
  const { page, more, loading } = useOperationList<Invoice>(path, refresh, onReadError);
  const selected = page?.items.find(({ id: invoiceId }) => invoiceId === selectedId);
  function changed() {
    setRefresh((revision) => revision + 1);
    onChanged();
  }
  return <section aria-label="Invoices and payments">
    <h3>Invoices and payments</h3>
    {page?.items.length === 0 && <p>No invoices recorded.</p>}
    {!!page?.items.length && <div className="table-scroll"><table>
      <thead><tr><th scope="col">Invoice</th><th scope="col">Due date</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead>
      <tbody>{page.items.map((row) => <tr key={row.id}>
        <td><button type="button" aria-pressed={selectedId === row.id} onClick={() => setSelectedId(row.id)}>{row.reference}</button></td>
        <td>{row.dueOn}</td><td>{formatInr(row.amountPaise)}</td>
        <td>{row.balancePaise === 0 ? 'Paid' : row.overdue ? 'Overdue' : row.paidPaise ? 'Partially paid' : 'Open'}</td>
      </tr>)}</tbody>
    </table></div>}
    {page?.nextCursor && <button type="button" disabled={loading} onClick={more}>More invoices</button>}
    {manage && !recording && <button type="button" onClick={() => setRecording(true)}>Record invoice</button>}
    {recording && <RecordAmount path={path} kind="invoice" attempts={attempts} onError={onError} onCancel={() => setRecording(false)}
      onSaved={() => { setRecording(false); changed(); }} />}
    {selected && <Payments key={selected.id} invoice={selected} path={path + '/' + selected.id + '/payments'} manage={manage}
      refresh={refresh} attempts={attempts} onChanged={changed} onError={onError} onReadError={onReadError} />}
  </section>;
}

type QueueProps = {
  businessId?: string; onError: Failure; refresh: number; openBusiness: (id: string) => void;
};

function useQueue<T>(endpoint: string, { businessId, refresh, onError }: QueueProps) {
  const [currentOnly, setCurrentOnly] = useState(false);
  const query = currentOnly && businessId ? '?businessId=' + encodeURIComponent(businessId) : '';
  const list = useOperationList<T>(endpoint + query, refresh, onError);
  return { ...list, filter: businessId && <label><input type="checkbox" checked={currentOnly}
    onChange={(event) => setCurrentOnly(event.currentTarget.checked)} />Selected business only</label> };
}

export function OverdueInvoices(props: QueueProps) {
  const { page, more, loading, filter } = useQueue<Invoice>('billing/overdue', props);
  return <section className="detail" aria-label="Overdue invoices">
    <h2>Overdue invoices</h2>
    {filter}
    {page?.items.length === 0 && <p>No overdue invoices.</p>}
    {!!page?.items.length && <ul>{page.items.map((invoice) => <li key={invoice.id}>
      <button type="button" onClick={() => props.openBusiness(invoice.businessId)}>{invoice.reference}</button>
      {' · ' + invoice.dueOn + ' · ' + formatInr(invoice.balancePaise)}
    </li>)}</ul>}
    {page?.nextCursor && <button type="button" disabled={loading} onClick={more}>More overdue invoices</button>}
  </section>;
}

type Upcoming = { businessId: string; businessName: string; outletId: string; outletName: string; label: string; endsAt: string };
const indiaDate = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });

export function UpcomingRenewals(props: QueueProps) {
  const { page, more, loading, filter } = useQueue<Upcoming>('plans/renewals', props);
  return <section className="detail" aria-label="Upcoming renewals">
    <h2>Upcoming renewals</h2>
    {filter}
    {page?.items.length === 0 && <p>No service terms end in the next 30 days.</p>}
    {!!page?.items.length && <ul>{page.items.map((row) => <li key={row.outletId}>
      <button type="button" onClick={() => props.openBusiness(row.businessId)}>{row.businessName} · {row.outletName}</button>
      {' · ' + row.label + ' · ' + indiaDate.format(new Date(row.endsAt))}
    </li>)}</ul>}
    {page?.nextCursor && <button type="button" disabled={loading} onClick={more}>More renewals</button>}
  </section>;
}
