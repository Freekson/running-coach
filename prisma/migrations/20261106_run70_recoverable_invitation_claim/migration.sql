ALTER TABLE "auth_invitations"
  ADD COLUMN "claimed_at" TIMESTAMPTZ(6),
  ADD COLUMN "claimed_email" VARCHAR(320);
