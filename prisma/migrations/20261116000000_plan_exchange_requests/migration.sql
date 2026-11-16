CREATE UNIQUE INDEX "plan_drafts_user_id_goal_id_id_key" ON "plan_drafts"("user_id", "goal_id", "id");

CREATE TABLE "plan_exchange_requests" (
  "id" UUID NOT NULL,
  "issuance_sequence" BIGSERIAL NOT NULL,
  "user_id" UUID NOT NULL,
  "goal_id" UUID NOT NULL,
  "draft_id" UUID NOT NULL,
  "draft_version" INTEGER NOT NULL CHECK ("draft_version" >= 0),
  "schema_version" INTEGER NOT NULL CHECK ("schema_version" = 1),
  "generated_at" TIMESTAMPTZ(6) NOT NULL,
  "snapshot" JSONB NOT NULL,
  CONSTRAINT "plan_exchange_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_exchange_requests_draft_owner_fkey" FOREIGN KEY ("user_id", "goal_id", "draft_id")
    REFERENCES "plan_drafts"("user_id", "goal_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "plan_exchange_requests_issuance_sequence_key"
  ON "plan_exchange_requests"("issuance_sequence");
CREATE INDEX "plan_exchange_requests_user_id_draft_id_issuance_sequence_idx"
  ON "plan_exchange_requests"("user_id", "draft_id", "issuance_sequence" DESC);

CREATE FUNCTION reject_plan_exchange_request_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Issued plan exchange requests are immutable';
END;
$$;
CREATE TRIGGER plan_exchange_requests_immutable BEFORE UPDATE ON "plan_exchange_requests"
  FOR EACH ROW EXECUTE FUNCTION reject_plan_exchange_request_update();
