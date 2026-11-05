-- UX-01 (SCR-181 §1): a user's browser tasks belong to one device row with platform 'web'. Its
-- token_hash is 32 random bytes that are never issued, so no request can authenticate as it.
ALTER TABLE devices DROP CONSTRAINT devices_platform_check;
ALTER TABLE devices ADD CONSTRAINT devices_platform_check
  CHECK (platform IN ('macos','linux','windows','web'));
CREATE UNIQUE INDEX devices_one_web_device_per_user ON devices(user_id) WHERE platform = 'web';
-- GET /v1/app/objectives pages one user's objectives across all of their devices.
CREATE INDEX objectives_user_page ON objectives(user_id, created_at DESC, objective_id DESC);
