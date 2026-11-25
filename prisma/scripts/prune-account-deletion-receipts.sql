-- Run daily with the direct migration role after the environment target assertion.
DELETE FROM public.account_deletion_receipts WHERE expires_at <= CURRENT_TIMESTAMP;
