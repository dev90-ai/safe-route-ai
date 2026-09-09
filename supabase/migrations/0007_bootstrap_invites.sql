-- =============================================================================
-- 0007  Bootstrap invites
-- =============================================================================
-- `invited_by` becomes nullable to represent a genuine case the original model
-- missed: the first admin of a new organisation has nobody to invite them.
-- A null issuer means "issued during provisioning", and the RLS insert policy
-- still requires `invited_by = auth.uid()`, so a client can never create one.
-- =============================================================================

alter table public.invites alter column invited_by drop not null;

comment on column public.invites.invited_by is
  'Admin who issued the invite. Null only for bootstrap invites created during provisioning; clients cannot create these (see invites_insert policy).';
