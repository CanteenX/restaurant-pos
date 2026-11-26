# Proposed release notes: v1.1.1

This patch is a proposal for the owner's approval. Its contents depend on the
changes being merged into staging and verified before release.

## Proposed change

- If #379 merges, the CasaOS manifest's visible release notes will describe
  Nventra rather than unrelated upstream releases. Existing CasaOS app
  identity and AppData paths remain unchanged.

## Known limitations

- A backup used to restore its own snapshot can appear as `PENDING` afterward.
  Status reconciliation remains open in #370; do not interpret that status as
  proof that a backup is valid or invalid.
- CasaOS retains its legacy application identity and path for compatibility.
  An identity or data-path migration has not been implemented (#371).
- The v1.1.0 release notes document additional open limitations, including
  untranslated order and customer details and untested recovery paths.

This proposal does not itself publish a release or deploy an update.
