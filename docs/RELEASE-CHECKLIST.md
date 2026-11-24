# Release checklist

Claude performs the release only after the owner explicitly says go. Use the owner-approved version in every step; `1.1.0` below is the current proposal.

## Before the go-ahead

1. Confirm staging CI and the nightly browser end-to-end workflow passed on the same final staging commit. Re-run them if staging changes.
2. Complete disposable-stack browser, upgrade and rollback QA, including POS, Hindi, Control Center roles, portal and mobile widths. Resolve all release-blocking and major findings and assess the remaining issues.
3. Review [release notes](RELEASE-NOTES-v1.1.0.md), [UPGRADING.md](UPGRADING.md), the image names, package provenance, and all four CasaOS image references. Verify existing customers have a tested backup. Drain older Control API instances before granting new permission keys.
4. Confirm the proposed version and the single version-bump procedure in the image publication documentation. Do not publish an image before release approval.

## After the owner says go

1. Open the release PR from `staging` to `master`. Merge it with a **merge commit** whose message contains `staging`, as required by master-guard. Record the merge SHA.
2. Create and push tag `v1.1.0` on that master commit. The tag triggers `docker-publish`. Wait for the workflow to finish and inspect the backend and web manifests for both `linux/amd64` and `linux/arm64` (four image/architecture combinations):

   ```sh
   docker buildx imagetools inspect ghcr.io/canteenx/nventra-pos-backend:1.1.0
   docker buildx imagetools inspect ghcr.io/canteenx/nventra-pos-web:1.1.0
   ```

3. Ask the owner to make the GHCR packages public (#32), then verify anonymous pulls of both versioned images. Earlier 1.0.x packages have their old names; see [UPGRADING.md](UPGRADING.md).
4. Check the Render demo deploy. The Render GitHub app currently lacks access to the private repository; until the owner grants it, trigger a manual deploy as described in [DEPLOY-DEMO.md](DEPLOY-DEMO.md). Verify the backend health endpoint and the Vercel demo. Check the separate website's Vercel deployment as well.
5. Perform post-release smoke checks for login, a representative POS workflow and the published image versions. Record the release SHA, tag, image digests and results.

## Recovery

Use the database setup, rollback and `rollback_failed` recovery instructions in [UPGRADING.md](UPGRADING.md). Keep existing database and uploads volumes, preserve the backup, and investigate a failed prior setup before restarting the backend. Escalate a failed smoke or deployment instead of declaring the release healthy.
