'use client';

import { useRef, useState, type FormEvent } from 'react';
import { call } from './api';

export type ReplyTarget = { address: string; verified: boolean };
const templates = [
  { label: 'Use acknowledgment template', text: 'Thanks for contacting Nventra Support. We are looking into your request.' },
  { label: 'Use request-details template', text: 'Could you share what you expected to happen, what happened instead, and which outlet was affected?' },
];

export function TicketReply({ path, target, busy, change, refresh, queued }: {
  path: string;
  target: ReplyTarget;
  busy: boolean;
  change: (action: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  refresh: (signal: AbortSignal) => Promise<void>;
  queued: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [draft, setDraft] = useState('');
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
      setDraft('');
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
      <div className="reply-templates">{templates.map(({ label, text }) =>
        <button key={label} type="button" onClick={() => setDraft(text)}>{label}</button>)}</div>
      <label><span id="ticket-reply-label">Email reply</span><textarea aria-labelledby="ticket-reply-label"
        name="reply" maxLength={4000} required rows={4}
        value={draft} onChange={(event) => setDraft(event.currentTarget.value)} /></label>
      <button className="primary" type="submit" disabled={!target.verified && !confirmed}>Queue reply</button>
    </fieldset>
  </form>;
}
