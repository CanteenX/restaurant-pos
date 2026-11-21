'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { canManageControlStaff } from '@nventra/types/dist/permissions';
import { call, ApiError, pagePath, useRequestScope, type Page, type Session } from './api';
import { canSelectRole, PermissionEditor, SectionPreview } from './team-permissions';

type Role = { id: string; key: string; name: string; description: string; grants: string[]; isSystem: boolean; _count: { members: number } };
type Staff = { id: string; name: string | null; email: string; enabled: boolean; twoFactorEnabled: boolean;
  lastSignInAt: string | null; roleId: string | null; grants: string[] };
type Draft = { id?: string; key: string; name: string; description: string; roleId: string; grants: string[]; email: string };
const blank: Draft = { key: '', name: '', description: '', roleId: '', grants: [], email: '' };
type Confirmation = { label: string; path: string; method?: 'DELETE' };

async function all<T>(path: string, signal: AbortSignal) {
  const items: T[] = [];
  let cursor: Page<T>['nextCursor'] = null;
  do {
    const page: Page<T> = await call<Page<T>>(pagePath(path + '?limit=50', cursor), undefined, signal);
    items.push(...page.items); cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

export function Team({ session, rolesOnly = false, onExpired }: { session: Session; rolesOnly?: boolean; onExpired: () => void }) {
  const [roles, setRoles] = useState<Role[]>([]), [staff, setStaff] = useState<Staff[]>([]);
  const [draft, setDraft] = useState<Draft>(), [confirm, setConfirm] = useState<Confirmation>();
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [result, setResult] = useState('');
  const requests = useRequestScope();
  const manage = session.grants.includes(rolesOnly ? 'cc.role.manage' : 'cc.staff.manage');
  function fail(failure: unknown) {
    if (failure instanceof ApiError && failure.status === 401) return onExpired();
    setError(failure instanceof ApiError && failure.status === 409 ? 'This conflicts with an existing record. Roles with members cannot be deleted.' :
      failure instanceof ApiError && failure.status === 403 ? 'Permission denied. Sign in again for recent verification if needed.' :
      'Request could not be confirmed. Reload and check the current state before retrying.');
  }
  async function refresh(signal: AbortSignal) {
    const [nextRoles, people] = await Promise.all([all<Role>('staff/roles', signal), rolesOnly ? Promise.resolve([]) : all<Staff>('staff/users', signal)]);
    if (!signal.aborted) { setRoles(nextRoles); setStaff(people); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => refresh(controller.signal)).catch((failure) => { if (!controller.signal.aborted) fail(failure); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
    // The parent remounts this view when its session or workspace changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const roleAllowed = (role: Role) => canSelectRole(role, session.grants, session.isSystemAdmin === true);
  const personAllowed = (person: Staff) => canManageControlStaff({ staffId: session.staffId, grants: session.grants },
    { staffId: person.id, grants: person.grants }, person.grants);
  async function write(path: string, body: object, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST') {
    const signal = requests.current;
    if (!signal || signal.aborted || busy) return;
    setBusy(true); setError(''); setResult('');
    try {
      const answer = await call<{ inviteLink?: string; delivery?: string }>(path, body, signal, method);
      if (signal.aborted) return;
      setDraft(undefined); setConfirm(undefined);
      setResult(answer.inviteLink ?? (answer.delivery === 'unconfirmed' ? 'Mail delivery is unconfirmed. Check with the recipient.' : 'Saved.'));
      await refresh(signal);
    } catch (failure) { if (!signal.aborted) fail(failure); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (rolesOnly) return void write('staff/roles' + (draft.id ? '/' + draft.id : ''), {
      ...(!draft.id && { key: draft.key }), name: draft.name, description: draft.description, grants: draft.grants,
    }, draft.id ? 'PATCH' : 'POST');
    const role = roles.find((r) => r.id === draft.roleId);
    if (!role) return;
    const body = { roleId: role.id, extraGrants: draft.grants.filter((g) => !role.grants.includes(g)),
      removedGrants: role.grants.filter((g) => !draft.grants.includes(g)) };
    void write(draft.id ? 'staff/users/' + draft.id + '/role' : 'staff/users/invite',
      { ...body, ...(!draft.id && { email: draft.email }) }, draft.id ? 'PUT' : 'POST');
  }
  return <section className="team" aria-label={rolesOnly ? 'Roles' : 'Team'}><h1>{rolesOnly ? 'Roles' : 'Team'}</h1>
    <p>{rolesOnly ? 'Define access once. Changes apply live to every member.' : 'Invite colleagues and manage individual access.'}</p>
    {error && <p role="alert">{error}</p>}{result && <div role="status"><p>{result}</p><button onClick={() => setResult('')}>Dismiss result</button></div>}
    {busy && <p role="status">Loading…</p>}
    <button disabled={busy} onClick={() => { const signal = requests.current; if (signal) { setBusy(true); void refresh(signal).catch(fail).finally(() => setBusy(false)); } }}>Refresh</button>
    {manage && <button disabled={busy} onClick={() => { setDraft(blank); setResult(''); }}>{rolesOnly ? 'Create role' : 'Invite staff'}</button>}
    <div className="table-scroll"><table><thead><tr>{(rolesOnly ? ['Role', 'Description', 'Members', 'Actions'] :
      ['Name', 'Email', 'Role', '2FA', 'Last sign-in', 'Status', 'Actions']).map((label) => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{rolesOnly ? roles.map((role) => <tr key={role.id}><td>{role.name}{role.isSystem && ' · Locked'}</td><td>{role.description}</td><td>{role._count.members}</td><td>
        {manage && !role.isSystem && <><button disabled={busy || !roleAllowed(role)} onClick={() => setDraft({ ...blank, ...role })}>Edit {role.name}</button>
          <button disabled={busy || !roleAllowed(role) || role._count.members > 0} onClick={() => setConfirm({ label: 'Delete ' + role.name, path: 'staff/roles/' + role.id, method: 'DELETE' })}>Delete {role.name}</button></>}
      </td></tr>) : staff.map((person) => <tr key={person.id}><td>{person.name || 'Not provided'}</td><td>{person.email}</td>
        <td>{roles.find((r) => r.id === person.roleId)?.name || 'Unassigned'}</td><td>{person.twoFactorEnabled ? 'Enrolled' : 'Not enrolled'}</td>
        <td>{person.lastSignInAt ? new Date(person.lastSignInAt).toLocaleString() : 'Not recorded'}</td><td>{person.enabled ? 'Active' : 'Deactivated'}</td><td>
          {manage && <fieldset disabled={busy || !personAllowed(person)}><button onClick={() => setDraft({ ...blank, ...person, roleId: person.roleId ?? '', name: person.name ?? '' })}>Edit access</button>
            {([['Reset 2FA', 'reset-factor'], ['Sign out everywhere', 'revoke-sessions'], [person.enabled ? 'Deactivate' : 'Reactivate', person.enabled ? 'deactivate' : 'reactivate']] as const)
              .map(([label, action]) => <button key={action} onClick={() => setConfirm({ label: label + ' for ' + person.email, path: 'staff/users/' + person.id + '/' + action })}>{label}</button>)}
          </fieldset>}
        </td></tr>)}</tbody></table></div>
    {!busy && !(rolesOnly ? roles : staff).length && <p>No records yet.</p>}
    {confirm && <section aria-label="Confirm action"><h2>{confirm.label}?</h2><p>This changes the selected account or role immediately.</p>
      <button disabled={busy} onClick={() => void write(confirm.path, {}, confirm.method)}>Confirm {confirm.label}</button>
      <button disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button></section>}
    {draft && <form onSubmit={save} aria-label={rolesOnly ? 'Role editor' : 'Staff access editor'}><fieldset disabled={busy}><h2>{rolesOnly ? 'Role details' : 'Staff access'}</h2>
      {rolesOnly ? <>{!draft.id && <label>Role key<input value={draft.key} required pattern="[a-z][a-z0-9-]{1,47}" onChange={(e) => setDraft({ ...draft, key: e.target.value })} /></label>}
        <label>Role name<input value={draft.name} required maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>Description<input value={draft.description} maxLength={300} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label></> : <>
        {!draft.id && <label>Staff email<input type="email" required value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></label>}
        <label>Role<select aria-label="Role" required value={draft.roleId} onChange={(e) => { const role = roles.find((r) => r.id === e.target.value); setDraft({ ...draft, roleId: e.target.value, grants: role?.grants ?? [] }); }}>
          <option value="">Choose a role</option>{roles.map((r) => <option key={r.id} value={r.id} disabled={!roleAllowed(r)}>{r.name}</option>)}</select></label></>}
      <PermissionEditor grants={draft.grants} ceiling={session.grants} locked={!rolesOnly && roles.some((r) => r.id === draft.roleId && r.isSystem)}
        onChange={(grants) => setDraft({ ...draft, grants })} />
      <SectionPreview grants={draft.grants} />
      <div className="actions"><button type="submit" className="primary">{rolesOnly ? 'Save role' : draft.id ? 'Save access' : 'Send invitation'}</button>
        <button type="button" onClick={() => setDraft(undefined)}>Cancel editing</button></div>
    </fieldset></form>}
  </section>;
}
