-- OFFLINE RESTORE ONLY, with the direct migration role.
-- First merge the latest protected receipt copy, including post-backup deletions.
BEGIN;

CREATE TEMP TABLE run51_deleted_auth_ids ON COMMIT DROP AS
SELECT a.id, a.email, a.invitation_claim_nonce
FROM public.auth_users a
JOIN public.account_deletion_receipts r
  ON encode(sha256(convert_to(a.id, 'UTF8')), 'hex') = r.auth_subject_hash
WHERE r.expires_at > CURRENT_TIMESTAMP;

DELETE FROM public.auth_verifications v
USING run51_deleted_auth_ids a WHERE v.identifier = a.email;
DELETE FROM public.auth_invitations i
USING run51_deleted_auth_ids a WHERE i.claimed_nonce = a.invitation_claim_nonce;

DELETE FROM public.users u
USING public.account_deletion_receipts r
WHERE u.id = r.user_id
  AND encode(sha256(convert_to(u.auth_subject, 'UTF8')), 'hex') = r.auth_subject_hash
  AND r.expires_at > CURRENT_TIMESTAMP;

DELETE FROM public.auth_users a
USING run51_deleted_auth_ids d WHERE a.id = d.id;

COMMIT;
