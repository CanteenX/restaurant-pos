# Control Center staff invitations

A staff member with `cc.staff.manage` and recent two-factor verification can invite a recipient to a role within their own permissions. An invitation expires after 72 hours. The recipient chooses a password and completes authenticator enrolment before a session starts.

Manual delivery is the default. The issue response shows the invitation link once. Share it directly with its intended recipient. If you approve email delivery, set `CONTROL_STAFF_INVITE_MAIL_ENABLED=true` and provide `CONTROL_GMAIL_USER` and `CONTROL_GMAIL_APP_PASSWORD` through the host’s secret store. Email delivery uses the configured HTTPS Control origin. The issue response reports delivery status.

If email delivery is unconfirmed, check the configured mailbox and confirm delivery with the recipient. The invitation remains valid until it expires. If the recipient needs immediate access and has yet to redeem the invitation, use the existing operator `create` flow with the chosen role and deliver its enrollment proof independently. The outstanding invite cannot replace that account. Otherwise, issue another invitation after expiry.

The authenticator challenge expires five minutes after the invitation is redeemed. If the challenge is lost or expires, the operator can `rotate` the enrollment proof for the enabled, unenrolled account. Share the ten-minute proof directly with the recipient. They can start enrollment again through standard staff sign-in with their chosen password and this proof. The original invitation remains consumed.
