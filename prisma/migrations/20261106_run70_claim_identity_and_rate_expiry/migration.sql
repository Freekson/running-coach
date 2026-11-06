ALTER TABLE "auth_users"
  ADD COLUMN "invitation_claim_nonce" UUID;

ALTER TABLE "auth_invitations"
  ADD COLUMN "claimed_nonce" UUID;

CREATE UNIQUE INDEX "auth_users_invitation_claim_nonce_key"
  ON "auth_users"("invitation_claim_nonce");

CREATE UNIQUE INDEX "auth_invitations_claimed_nonce_key"
  ON "auth_invitations"("claimed_nonce");

CREATE INDEX "auth_rate_limits_lastRequest_idx"
  ON "auth_rate_limits"("lastRequest");
