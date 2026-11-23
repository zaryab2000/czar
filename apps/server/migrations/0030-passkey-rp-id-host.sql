-- PM-016 (SCR-170 §2, §7): the passkey RP ID is the host name of app.origin, so the
-- column may no longer be pinned to 'localhost'. Existing 'localhost' rows stay valid.
ALTER TABLE passkey_credentials DROP CONSTRAINT passkey_credentials_rp_id_check;
ALTER TABLE passkey_credentials ADD CONSTRAINT passkey_credentials_rp_id_host_check
  CHECK (rp_id ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$');
