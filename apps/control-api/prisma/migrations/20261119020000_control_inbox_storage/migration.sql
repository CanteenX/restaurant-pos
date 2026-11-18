BEGIN;
ALTER TABLE control.ticket_message
  DROP CONSTRAINT ticket_message_direction_check, DROP CONSTRAINT ticket_message_visibility_check,
  ALTER COLUMN visibility TYPE varchar(6), ALTER COLUMN text TYPE text, ALTER COLUMN author_id DROP NOT NULL, ALTER COLUMN request_key DROP NOT NULL,
  ADD CONSTRAINT message_kind CHECK (
    (direction = 'internal' AND visibility = 'staff' AND author_id IS NOT NULL AND request_key IS NOT NULL AND length(text) <= 4000)
    OR (direction = 'inbound' AND visibility = 'public' AND author_id IS NULL AND request_key IS NULL AND octet_length(text) <= 65536)
  );
CREATE TABLE control.mailbox_cursor (
  mailbox varchar(254) PRIMARY KEY CHECK (mailbox <> '' AND mailbox = lower(btrim(mailbox))),
  uid_validity bigint CHECK (uid_validity BETWEEN 1 AND 4294967295),
  through_uid bigint NOT NULL DEFAULT 0 CHECK (through_uid BETWEEN 0 AND 4294967295),
  lease_token uuid, lease_until timestamptz,
  CHECK (uid_validity IS NOT NULL OR through_uid = 0),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE TABLE control.inbound_receipt (
  mailbox varchar(254) NOT NULL REFERENCES control.mailbox_cursor(mailbox),
  provider_id varchar(255) NOT NULL CHECK (provider_id ~ '^[A-Za-z0-9_-]+$'),
  outcome varchar(10) NOT NULL CHECK (outcome IN ('accept','skip','quarantine')),
  reason varchar(64) NOT NULL CHECK (reason ~ '^[a-z][a-z-]*$'),
  omitted_attachments smallint NOT NULL DEFAULT 0 CHECK (omitted_attachments BETWEEN 0 AND 32),
  message_row_id uuid UNIQUE REFERENCES control.ticket_message(id),
  rfc_message_id varchar(254), verified_sender varchar(254),
  CHECK ((outcome = 'accept') = (message_row_id IS NOT NULL)),
  CHECK (outcome = 'accept' OR (rfc_message_id IS NULL AND verified_sender IS NULL)),
  PRIMARY KEY (mailbox, provider_id)
);
CREATE INDEX receipt_thread_idx ON control.inbound_receipt(mailbox, verified_sender, rfc_message_id);
CREATE TABLE control.mailbox_delivery (
  mailbox varchar(254) NOT NULL, uid_validity bigint NOT NULL CHECK (uid_validity BETWEEN 1 AND 4294967295),
  uid bigint NOT NULL CHECK (uid BETWEEN 1 AND 4294967295), provider_id varchar(255) NOT NULL,
  PRIMARY KEY (mailbox, uid_validity, uid),
  FOREIGN KEY (mailbox, provider_id) REFERENCES control.inbound_receipt(mailbox, provider_id)
);
REVOKE ALL ON control.mailbox_cursor, control.inbound_receipt, control.mailbox_delivery FROM PUBLIC, control_runtime;
COMMIT;
