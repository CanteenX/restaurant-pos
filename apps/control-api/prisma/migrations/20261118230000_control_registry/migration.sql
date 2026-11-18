BEGIN;
CREATE TABLE control.business (
  id uuid PRIMARY KEY,
  legal_name varchar(160) NOT NULL CHECK (btrim(legal_name) <> ''),
  display_name varchar(160) NOT NULL CHECK (btrim(display_name) <> ''),
  archived boolean NOT NULL DEFAULT false
);
CREATE TABLE control.outlet (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES control.business(id) ON DELETE RESTRICT,
  display_name varchar(160) NOT NULL CHECK (btrim(display_name) <> ''),
  time_zone varchar(64) NOT NULL CHECK (btrim(time_zone) <> ''),
  archived boolean NOT NULL DEFAULT false,
  UNIQUE (business_id, id)
);
CREATE FUNCTION control.check_outlet_parent() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE parent_archived boolean;
BEGIN
  SELECT archived INTO parent_archived FROM control.business WHERE id = NEW.business_id FOR SHARE;
  IF parent_archived THEN
    RAISE EXCEPTION 'Business is archived' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_outlet_parent BEFORE INSERT OR UPDATE ON control.outlet FOR EACH ROW EXECUTE FUNCTION control.check_outlet_parent();
REVOKE ALL ON FUNCTION control.check_outlet_parent() FROM PUBLIC, control_runtime;
REVOKE ALL ON control.business, control.outlet FROM PUBLIC, control_runtime;
GRANT SELECT, INSERT, UPDATE (legal_name, display_name, archived) ON control.business TO control_runtime;
GRANT SELECT, INSERT, UPDATE (display_name, time_zone, archived) ON control.outlet TO control_runtime;
COMMIT;
