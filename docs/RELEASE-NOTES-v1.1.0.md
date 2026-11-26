# Proposed release notes: v1.1.0

This is a release proposal since v1.0.1. The owner must approve the version and release.

## What's new

- Control Center adds internal owner and staff tools for businesses, outlets, plans, manual billing, support tickets and customer portal access. Its data-driven staff roles can be edited without code changes, subject to permission and Admin safeguards. The source is in `apps/control` and `apps/control-api`; these apps are not included in the POS Docker images or deployed by this release.
- Hindi coverage extends to secondary POS pages and the login screen. Some screens remain in English, as noted below.
- Receipt email sends have bounded SMTP timeouts and claim fencing to prevent an old worker from finalising a newer attempt (#355).
- Backup restore has configurable size caps, SCRAM-safe credentials and operation timeouts (#356). Stock installations use limited PostgreSQL runtime and restore logins, with a separate setup job for migrations (#359).
- Retired unused licence enforcement code was removed (#282). Service plans remain business records in Control Center.

## Upgrade from v1.0.1

Take and verify a backup first. Apply the new Compose, CasaOS or Debian definition before starting the new version. The old in-app updater cannot add the required `db-setup` service. Follow [UPGRADING.md](UPGRADING.md) for the installation-specific procedure, recovery and the limited database roles. The v1.0.1 Compose and updater already referenced `nventra-pos-*`, while the published 1.0.x images used `nodedr-restaurant-pos-*` package names.

Do not use the v1.0.1 in-app updater for this transition even if it offers the new image. In local-registry QA it rolled back to a healthy v1.0.1 app after applying at least one newer migration. Exact migration and permission counts await verification against the released v1.0.1 build. CasaOS and Debian upgrade/rollback paths were not tested in the independent Docker-clone QA drill. The 1.1.0 images do not exist until the release tag is pushed and the publication workflow completes.

For a Control Center rolling deployment, drain older Control API instances before new permission keys are added to grants. Old instances may reject keys they do not recognise.

## Known limitations

- Order detail, refund and cancellation dialogs and `/customers/[id]` still have English text (#346). Hindi smoke coverage has follow-up work (#347).
- Open review follow-ups #348–#352 cover staff role lifecycle and provisioning, portal database boundaries, rejected-ticket audit and portal UI. Assess their current release impact during QA.
- The earliest #359 RED transcripts were not retained. Subsequent corrective RED evidence and independent reruns are recorded in the PR and shared work log; Claude's upgrade QA should verify its independent rerun before release.
- Wide tables in the Control Center staff area need horizontal scrolling at phone widths. See the role browser QA report and release QA findings.
- A restored backup record can show PENDING (#370). CasaOS retains legacy metadata and identifiers (#371); changing identifiers may affect existing paths.

## Version proposal

Propose **v1.1.0** as a minor release because it adds backward-compatible functionality since v1.0.1, including Control Center source and broader Hindi coverage. A **v1.0.2** patch would be appropriate if the release were limited to backward-compatible fixes without those feature additions. A **v2.0.0** major would be appropriate if the final release intentionally introduced incompatible public behaviour or an upgrade requiring a breaking change beyond the documented migration. The owner chooses the final version.
