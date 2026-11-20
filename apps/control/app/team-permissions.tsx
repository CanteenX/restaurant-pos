import { controlPermissionSatisfied, type ControlPermissionKey } from '@nventra/types/dist/permissions';

export const sections = [['Client operations', 'cc.business.read'], ['Helpdesk', 'cc.ticket.read'],
  ['Audit log', 'cc.audit.read'], ['Team', 'cc.staff.read'], ['Roles', 'cc.role.manage']] as const;
export const visibleSections = (grants: readonly string[]) => sections.filter(([, key]) => controlPermissionSatisfied(grants, key));
const groups: [string, [ControlPermissionKey, string][]][] = [
  ['Team', [['cc.staff.read', 'View staff'], ['cc.staff.manage', 'Manage staff'], ['cc.role.manage', 'Manage roles']]],
  ['Businesses', [['cc.business.read', 'View businesses'], ['cc.business.manage', 'Manage businesses']]],
  ['Plans', [['cc.plan.read', 'View plans'], ['cc.plan.manage', 'Manage plans']]],
  ['Billing', [['cc.billing.read', 'Read invoices'], ['cc.billing.manage', 'Manage invoices and payments']]],
  ['Hosted services', [['cc.hosted.read', 'View hosted access'], ['cc.hosted.manage', 'Manage hosted access']]],
  ['Customer portal', [['cc.portal.read', 'View portal contacts'], ['cc.portal.create', 'Create portal contacts'], ['cc.portal.manage', 'Manage portal contacts']]],
  ['Helpdesk', [['cc.ticket.read', 'Read tickets'], ['cc.ticket.manage', 'Manage tickets'], ['cc.ticket.reply', 'Reply to tickets']]],
  ['Audit', [['cc.audit.read', 'View audit log']]],
];
export function PermissionEditor({ grants, ceiling, onChange, locked = false }: {
  grants: string[]; ceiling: string[]; onChange: (grants: string[]) => void; locked?: boolean;
}) {
  return <div className="permission-groups">{groups.map(([name, permissions]) => <fieldset key={name}><legend>{name}</legend>
    {permissions.map(([key, label]) => <label key={key}><input type="checkbox" checked={grants.includes(key)}
      disabled={locked || !ceiling.includes(key)} onChange={(event) => onChange(event.target.checked ? [...grants, key] : grants.filter((g) => g !== key))} />{label}</label>)}
  </fieldset>)}</div>;
}
export function SectionPreview({ grants }: { grants: string[] }) {
  return <section aria-label="Visible sections"><h3>Visible sections</h3><p>{visibleSections(grants).map(([name]) => name).join(' · ') || 'No sections'}</p>
    <small>Individual permissions also control actions within each section.</small></section>;
}
