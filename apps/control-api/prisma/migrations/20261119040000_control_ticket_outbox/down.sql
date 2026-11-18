BEGIN;
LOCK TABLE control.ticket_reply_outbox,control.outbox_daily_quota IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT FROM control.ticket_reply_outbox) OR EXISTS (SELECT FROM control.outbox_daily_quota) THEN
    RAISE EXCEPTION 'Archive and remove outbound records before reverting outbox storage';
  END IF;
END $$;
DROP FUNCTION control.finish_ticket_reply(uuid,uuid,text),control.claim_ticket_reply(),
  control.enqueue_ticket_reply(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,boolean);
REVOKE SELECT (message_row_id,outcome,claimed_sender,verified_sender,rfc_message_id) ON control.inbound_receipt FROM control_runtime;
DROP TABLE control.ticket_reply_outbox, control.outbox_daily_quota;
ALTER TABLE control.ticket_message DROP CONSTRAINT message_kind, ADD CONSTRAINT message_kind CHECK (
  (direction = 'internal' AND visibility = 'staff' AND author_id IS NOT NULL AND request_key IS NOT NULL AND length(text) <= 4000)
  OR (direction = 'inbound' AND visibility = 'public' AND author_id IS NULL AND request_key IS NULL AND octet_length(text) <= 65536)
);
COMMIT;
