# Customer portal identity

Apply the Control database migrations with the migration login. To enable portal authentication, have the database administrator create the `control_portal_runtime` NOLOGIN group and grant it to a dedicated login that inherits its privileges. Apply [portal-runtime-grants.sql](portal-runtime-grants.sql) as the migration owner in the Control database. The portal login uses specific authentication functions to access credentials and sessions. The portal login needs no owner, staff, operator, mail worker or PostgreSQL administrative group membership.

Configure `CONTROL_PORTAL_DATABASE_URL` with that login and a distinct 64-hex-character `CONTROL_PORTAL_AUTH_KEY` using the existing secret store. Reuse the staff application's exact HTTPS `CONTROL_ORIGIN`. Keep driver and network debugging disabled. Both portal settings can be omitted for a staff-only process. Partial settings or an unsuitable portal login prevent startup. Preserve the auth key across restarts. Rotating it makes outstanding activation codes and session cookies unusable.

Staff with `cc.portal.manage` and 2FA verified within ten minutes can create an invitation, reissue one or revoke customer access. An invitation has a ten-minute, single-use code. Share it over an approved channel directly with the intended customer. The API stores its digest and never returns the original code in the directory. Portal accounts use one normalized email per business account. The same email cannot identify accounts in multiple businesses in this release.

The customer enters the code and chooses a password on the portal. Sign-in issues a separate, eight-hour Secure HttpOnly session. Reissue and revocation invalidate existing sessions in the same transaction. The directory requires `cc.portal.read`.

PostgreSQL rate limits credentials by normalized identity and socket peer. Requests through the same reverse proxy share a peer quota. The API ignores client-supplied forwarded addresses.
