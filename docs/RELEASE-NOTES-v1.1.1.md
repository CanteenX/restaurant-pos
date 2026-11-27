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
  available (#392). Rollback was tested with fake Docker, not a real registry.
- The installation guide now explains how to use published backend and web
  images while building the locally sourced updater sidecar (#396).
- Menu and order endpoints now reject missing or invalid branch identifiers
  with a clear error before checking branch access (#397).

## Known limitations

- A backup used to restore its own snapshot can appear as `PENDING` afterward.
  Status reconciliation remains open in #370; do not interpret that status as
  proof that a backup is valid or invalid.
- CasaOS retains its legacy application identity and path for compatibility;
  an identity or data-path migration has not been implemented.
- Loyalty points can be over-debited when the requested redemption exceeds the
  bill. Issue #394 is open and blocked by an automated security review.
- Downgrade protection cannot determine the version of unversioned or mutable
  tags. Use an immutable numeric release tag when this protection is needed.
- The v1.1.0 release notes document additional open limitations, including
  untranslated order and customer details and untested recovery paths.

This proposal does not itself publish a release or deploy an update.
