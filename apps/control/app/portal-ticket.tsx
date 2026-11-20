'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { call, useRequestScope } from './api';

// Tickets opened by a customer in the portal are bound to one business; staff cannot move them.
export function PortalTicketScope({ businessId, directory }: { businessId: string | null; directory: boolean }) {
  const [name, setName] = useState<string>();
  const requests = useRequestScope();
  useEffect(() => {
    const scope = requests.current;
    if (!scope || !businessId || !directory) return;
    void call<{ displayName: string }>('businesses/' + businessId, undefined, scope)
      .then((business) => { if (!scope.aborted) setName(business.displayName); })
      .catch(() => undefined);
  }, [businessId, directory, requests]);
  return <fieldset className="portal-ticket-scope">
    <legend>Portal ticket scope</legend>
    <p>{name ?? 'Customer business'}</p>
    <small>The business is fixed because the customer opened this ticket from their portal.</small>
  </fieldset>;
}

export function PortalReply({ path, busy, change, refresh, posted }: {
  path: string; busy: boolean;
  change: (action: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  refresh: (signal: AbortSignal) => Promise<void>;
  posted: () => void;
}) {
  const [draft, setDraft] = useState('');
  const attempt = useRef<{ text: string; requestKey: string }>(undefined);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get('portalReply');
    if (busy || typeof text !== 'string' || !text.trim()) return;
    const request = attempt.current?.text === text ? attempt.current : { text, requestKey: crypto.randomUUID() };
    attempt.current = request;
    void change(async (signal) => {
      await call(path + '/portal-replies', request);
      if (signal.aborted) return;
      await refresh(signal);
      if (signal.aborted) return;
      attempt.current = undefined;
      setDraft('');
      posted();
    });
  }

  return <form onSubmit={submit}>
    <fieldset disabled={busy}>
      <legend>Reply to the customer</legend>
      <small>Visible to the customer in their portal. Nothing is emailed.</small>
      <label>Portal reply<textarea name="portalReply" maxLength={4000} required rows={4}
        value={draft} onChange={(event) => setDraft(event.currentTarget.value)} /></label>
      <button className="primary" type="submit">Post portal reply</button>
    </fieldset>
  </form>;
}
