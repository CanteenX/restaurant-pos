# Proposed release notes: v1.1.1

This patch is a proposal for the owner's approval.

## Change

- The CasaOS manifest's visible release notes describe Nventra rather than
  unrelated upstream releases. Existing CasaOS app
  identity and AppData paths remain unchanged.
- Scheduled report listings and actions now require the corresponding report
  permission, with branch boundaries enforced (#385).
- The updater rejects requests to downgrade from a numeric release to an older
  numeric release. Automatic rollback after a failed forward update remains
  available (#392).

## Known limitations

- A backup used to restore its own snapshot can appear as `PENDING` afterward.
  Status reconciliation remains open in #370; do not interpret that status as
  proof that a backup is valid or invalid.
- CasaOS retains its legacy application identity and path for compatibility.
  An identity or data-path migration has not been implemented (#371).
- Downgrade protection cannot determine the version of unversioned or mutable
  tags. Use an immutable numeric release tag when this protection is needed.
- The v1.1.0 release notes document additional open limitations, including
  untranslated order and customer details and untested recovery paths.

This proposal does not itself publish a release or deploy an update.
