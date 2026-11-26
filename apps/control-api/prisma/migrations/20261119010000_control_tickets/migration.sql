BEGIN;
CREATE TABLE control.ticket (
  id uuid PRIMARY KEY,
  subject varchar(240) NOT NULL CHECK (btrim(subject) <> ''),
  business_id uuid REFERENCES control.business(id) ON DELETE RESTRICT,
  outlet_id uuid,
  owner_id uuid REFERENCES control.staff(id) ON DELETE RESTRICT,
  status varchar(8) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  priority varchar(6) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id, outlet_id) REFERENCES control.outlet(business_id, id) ON DELETE RESTRICT,
  CHECK (outlet_id IS NULL OR business_id IS NOT NULL)
);
CREATE INDEX ticket_status_id_idx ON control.ticket (status, id);

CREATE TABLE control.ticket_message (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES control.ticket(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  request_key uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES control.staff(id) ON DELETE RESTRICT,
  text varchar(4000) NOT NULL CHECK (btrim(text) <> ''),
  direction varchar(8) NOT NULL DEFAULT 'internal' CHECK (direction = 'internal'),
  visibility varchar(5) NOT NULL DEFAULT 'staff' CHECK (visibility = 'staff'),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (ticket_id, sequence),
  UNIQUE (ticket_id, request_key)
);
REVOKE ALL ON control.ticket, control.ticket_message FROM PUBLIC, control_runtime;
GRANT SELECT ON control.ticket, control.ticket_message TO control_runtime;
GRANT UPDATE (business_id, outlet_id, owner_id, status, priority, updated_at) ON control.ticket TO control_runtime;
GRANT INSERT (id, ticket_id, sequence, request_key, author_id, text) ON control.ticket_message TO control_runtime;
COMMIT;
