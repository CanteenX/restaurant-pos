# Customer portal resources

The Control portal uses the separate portal database login and session cookie configured for customer authentication. An active portal account can read its business summary, invoices and recorded payments. A hosted suspension takes effect for that session on its next outlet, plan or download request. Archived businesses have no portal resource listing.

The summary displays `nventra01@gmail.com` for payment help. Set `CONTROL_PORTAL_SUPPORT_EMAIL` to a single validated support address to override it. Payment guidance directs the customer to their invoice and that support address.

Local downloads are optional. Leave `CONTROL_PORTAL_DOWNLOAD_DIR` unset to serve an empty list. To publish a release, configure an absolute canonical local directory owned by the release operator and readable by the Control API's operating-system account. Keep write access to that directory and its parents with trusted release operators. Copy only reviewed release artifacts into the directory. A file becomes available only under its predefined customer-facing ID.

| Customer-facing ID | Operator filename |
| --- | --- |
| `windows-installer` | `OrderRestro.msix` |
| `windows-update` | `OrderRestro-update.msix` |

Customers download with their authenticated portal session. The API checks hosted access and opens the named regular file before streaming it. The response uses a fixed attachment filename. Missing files and filesystem aliases are omitted.
