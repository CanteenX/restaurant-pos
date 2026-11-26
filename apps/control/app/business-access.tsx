import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, call, useRequestScope } from './api';
import { useOperationList } from './business-billing';

type Failure = (error: unknown) => void;
type Hosted = { status: 'active' | 'suspended'; version: string; reason?: string };
type Account = { id: string; email: string; status: 'pending' | 'active' | 'revoked' };
type Activation = { account: Account; activationCode: string; expiresAt: string };
type AccessProps = { id: string; manage: boolean; onError: Failure };

export function HostedAccess({ id, name, manage, onError }: AccessProps & { name: string }) {
  const path = 'businesses/' + id + '/hosted-access';
  const [access, setAccess] = useState<Hosted>();
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const attempt = useRef<{ body: string; key: string } | undefined>(undefined);
  const pending = useRef(false);
  const requests = useRequestScope();

  useEffect(() => {
    const controller = new AbortController();
    void call<Hosted>(path, undefined, controller.signal).then((value) => {
      if (!controller.signal.aborted) setAccess(value);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setAccess(undefined);
      onError(error);
    });
    return () => controller.abort();
  }, [path, refresh, onError]);

  function close() {
    setEditing(false);
    setReason('');
    setConfirmation('');
    attempt.current = undefined;
  }

  async function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const signal = requests.current;
    if (!access || !signal || signal.aborted || pending.current || confirmation.trim() !== name || !reason.trim()) return;
    const status = access.status === 'active' ? 'suspended' : 'active';
    const body = { status, reason: reason.trim() };
    const fingerprint = JSON.stringify(body);
    const requestKey = attempt.current?.body === fingerprint ? attempt.current.key : crypto.randomUUID();
    attempt.current = { body: fingerprint, key: requestKey };
    pending.current = true;
    setBusy(true);
    setStale(false);
    try {
      const response = await fetch('/api/control/v1/' + path, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': '"' + access.version + '"' },
        body: JSON.stringify({ ...body, requestKey }),
      });
      if (!response.ok) throw new ApiError(response.status);
      if (signal.aborted) return;
      close();
      setAccess(undefined);
      setRefresh((value) => value + 1);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.status === 412) {
        close();
        setStale(true);
        setAccess(undefined);
        setRefresh((value) => value + 1);
      } else {
        if (error instanceof ApiError && error.status === 403) {
          close();
          setAccess(undefined);
          setRefresh((value) => value + 1);
        }
        onError(error);
      }
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  const active = access?.status === 'active';
  return <section aria-label="Hosted access">
    <h3>Hosted access</h3>
    {stale && <p role="alert">Access changed in another session. Review the current status before trying again.</p>}
    {access && <>
      <p>{active ? 'Active' : 'Suspended'}</p>
      {access.reason && <p>{access.reason}</p>}
      {manage && !editing && <button type="button" onClick={() => { setStale(false); setEditing(true); }}>
        {active ? 'Suspend hosted access' : 'Restore hosted access'}
      </button>}
      {manage && editing && <form onSubmit={change}><fieldset disabled={busy}>
        <legend>{active ? 'Suspend' : 'Restore'} hosted services for {name}</legend>
        <p>Restaurant billing on the installed POS continues independently.</p>
        <label>Reason<input maxLength={240} required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <label>Confirm business name<input required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <div className="actions">
          <button className="primary" disabled={!reason.trim() || confirmation.trim() !== name}>
            {active ? 'Confirm suspension' : 'Confirm restoration'}
          </button>
          <button type="button" onClick={close}>Cancel</button>
        </div>
      </fieldset></form>}
    </>}
  </section>;
}

export function PortalContacts({ id, canCreate, manage, onError }: AccessProps & { canCreate: boolean }) {
  const path = 'businesses/' + id + '/portal-accounts';
  const [refresh, setRefresh] = useState(0);
  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<{ account: Account; kind: 'reissue' | 'revoke' }>();
  const [activation, setActivation] = useState<{ source: 'create' | 'reissue'; receipt: Activation }>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const requests = useRequestScope();
  const { page, more, loading } = useOperationList<Account>(path, refresh, onError);

  async function run(body: { email: string } | { account: Account; kind: 'reissue' | 'revoke' }) {
    if (!('email' in body ? canCreate : manage)) return;
    const signal = requests.current;
    if (!signal || signal.aborted || pending.current) return;
    pending.current = true;
    setBusy(true);
    setActivation(undefined);
    try {
      if ('email' in body) {
        const created = await call<Activation>(path, { email: body.email });
        if (!signal.aborted) setActivation({ source: 'create', receipt: created });
      } else if (body.kind === 'reissue') {
        const issued = await call<Activation>(path + '/' + body.account.id + '/reissue', {});
        if (!signal.aborted) setActivation({ source: 'reissue', receipt: issued });
      } else {
        await call(path + '/' + body.account.id + '/revoke', {});
      }
      if (signal.aborted) return;
      setAdding(false);
      setAction(undefined);
      setRefresh((value) => value + 1);
    } catch (error) {
      if (!signal.aborted) onError(error);
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run({ email: String(form.get('email')).trim() });
  }

  return <section aria-label="Customer contacts">
    <h3>Customer contacts</h3>
    {page?.items.length === 0 && <p>No portal accounts yet.</p>}
    {!!page?.items.length && <ul>{page.items.map((account) => <li key={account.id}>
      <span>{account.email}</span> · {account.status}
      {manage && <div className="actions">
        <button type="button" disabled={busy} onClick={() => { setAdding(false); setAction({ account, kind: 'reissue' }); }}>Reissue activation</button>
        {account.status !== 'revoked' && <button type="button" disabled={busy}
          onClick={() => { setAdding(false); setAction({ account, kind: 'revoke' }); }}>Revoke access</button>}
      </div>}
    </li>)}</ul>}
    {page?.nextCursor && <button type="button" disabled={loading} onClick={more}>More contacts</button>}
    {canCreate && !adding && !(manage && action) && <button type="button" onClick={() => setAdding(true)}>Add contact</button>}
    {canCreate && adding && <form onSubmit={create}><fieldset disabled={busy}>
      <label>Contact email<input name="email" type="email" maxLength={254} required /></label>
      <div className="actions"><button className="primary">Create portal account</button>
        <button type="button" onClick={() => setAdding(false)}>Cancel</button></div>
    </fieldset></form>}
    {manage && action && <aside>
      <p>{action.kind === 'reissue' ? 'Reissuing activation signs this contact out.' : 'This contact will lose portal access.'} {action.account.email}</p>
      <div className="actions">
        <button className="primary" type="button" disabled={busy} onClick={() => void run(action)}>Confirm {action.kind}</button>
        <button type="button" disabled={busy} onClick={() => setAction(undefined)}>Cancel</button>
      </div>
    </aside>}
    {page && activation && (activation.source === 'create' ? canCreate : manage) && <aside aria-label="New activation">
      <p><strong>Activation code</strong> for {activation.receipt.account.email}</p>
      <p><code>{activation.receipt.activationCode}</code></p>
      <p>Expires at {new Date(activation.receipt.expiresAt).toLocaleTimeString()}</p>
      <button type="button" onClick={() => setActivation(undefined)}>Close activation code</button>
    </aside>}
  </section>;
}

type Ticket = { id: string; subject: string; status: string; priority: string };

export function BusinessTicketHistory({ id, onError }: { id: string; onError: Failure }) {
  const { page, more, loading } = useOperationList<Ticket>('tickets?businessId=' + encodeURIComponent(id), 0, onError);
  return <section aria-label="Business support tickets">
    <h3>Business support tickets</h3>
    {page?.items.length === 0 && <p>No tickets linked to this business.</p>}
    {!!page?.items.length && <ul>{page.items.map((ticket) => <li key={ticket.id}>
      <strong>{ticket.subject}</strong> · {ticket.status} · {ticket.priority}
    </li>)}</ul>}
    {page?.nextCursor && <button type="button" disabled={loading} onClick={more}>More business tickets</button>}
  </section>;
}
