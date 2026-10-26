ALTER TABLE payer_freeze_autolimit_cursors
ADD COLUMN scan_target_block numeric(78, 0) NOT NULL DEFAULT 0
CHECK (scan_target_block >= 0);
