-- Only invoked by mark-nonproduction.mjs after an independently supplied
-- nonproduction Neon endpoint matches the direct and pooled URLs.
INSERT INTO "database_identity" ("id", "tier")
VALUES (1, 'NON_PRODUCTION');
