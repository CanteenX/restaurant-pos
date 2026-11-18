'use client';

import { useRef, useState, type FormEvent } from 'react';
import { call } from './api';

export type ReplyTarget = { address: string; verified: boolean };

export function TicketReply({ path, target, busy, change, refresh, queued }: {
  path: string;
  target: ReplyTarget;
  busy: boolean;
  change: (action: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  refresh: (signal: AbortSignal) => Promise<void>;
  queued: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const attempt = useRef<{ text: string; requestKey: string }>(undefined);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const text = new FormData(form).get('reply');
    if (busy || typeof text !== 'string' || !text.trim() || (!target.verified && !confirmed)) return;
    const request = attempt.current?.text === text ? attempt.current : { text, requestKey: crypto.randomUUID() };
    attempt.current = request;
    void change(async (signal) => {
      await call(path + '/messages', { ...request, ...(!target.verified && { acknowledgeUnverified: true }) });
      if (signal.aborted) return;
      await refresh(signal);
      if (signal.aborted) return;
      attempt.current = undefined;
      form.reset();
      setConfirmed(false);
      queued();
    });
  }

  return <form onSubmit={submit}>
    <fieldset disabled={busy}>
      <legend>Email reply</legend>
      <p>To <strong>{target.address}</strong></p>
      {!target.verified && <label className="reply-acknowledgment">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} required />
        I checked this unverified recipient.
      </label>}
      <label>Email reply<textarea name="reply" maxLength={4000} required rows={4} /></label>
      <button className="primary" type="submit" disabled={!target.verified && !confirmed}>Queue reply</button>
    </fieldset>
  </form>;
}
