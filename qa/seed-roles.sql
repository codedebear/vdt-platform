-- Promote the QA test users to their roles after they have been registered
-- (registration always creates an OPERATION user). Run AFTER the smoke script's
-- registration step and BEFORE its login step. Idempotent.
UPDATE "User" SET role = 'SUPER_ADMIN'   WHERE email = 'super@codedebear.com';
UPDATE "User" SET role = 'PROJECT_OWNER' WHERE email = 'owner@codedebear.com';
UPDATE "User" SET role = 'PROJECT_OWNER' WHERE email = 'owner2@codedebear.com';
UPDATE "User" SET role = 'BA'            WHERE email = 'ba@codedebear.com';
UPDATE "User" SET role = 'SA'            WHERE email = 'sa@codedebear.com';
UPDATE "User" SET role = 'QA'            WHERE email = 'qa@codedebear.com';
-- op@codedebear.com intentionally left as the default OPERATION role.
