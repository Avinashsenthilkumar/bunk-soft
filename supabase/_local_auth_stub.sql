-- ============================================================================
--  Test-only stand-in for the parts of Supabase's `auth` schema that BunkSoft
--  touches. Supabase creates all of this for you; a plain Postgres does not,
--  so the tests need it to run anywhere.
--
--  The column list mirrors GoTrue's real auth.users closely enough that
--  admin.sql's account-provisioning code is exercised honestly. Never run
--  this against a Supabase project — `create table if not exists` would do
--  nothing there, but there is no reason to take the chance.
-- ============================================================================
create schema if not exists auth;
create extension if not exists pgcrypto;

create table if not exists auth.users(
  instance_id            uuid,
  id                     uuid primary key default gen_random_uuid(),
  aud                    varchar(255),
  role                   varchar(255),
  email                  text unique,
  encrypted_password     varchar(255),
  email_confirmed_at     timestamptz,
  invited_at             timestamptz,
  confirmation_token     varchar(255),
  confirmation_sent_at   timestamptz,
  recovery_token         varchar(255),
  recovery_sent_at       timestamptz,
  email_change_token_new varchar(255),
  email_change           varchar(255),
  email_change_sent_at   timestamptz,
  last_sign_in_at        timestamptz,
  raw_app_meta_data      jsonb default '{}'::jsonb,
  raw_user_meta_data     jsonb default '{}'::jsonb,
  is_super_admin         boolean,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now(),
  phone                  text unique,
  banned_until           timestamptz,
  deleted_at             timestamptz
);

create table if not exists auth.identities(
  provider_id     text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  identity_data   jsonb not null,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  id              uuid primary key default gen_random_uuid(),
  unique (provider_id, provider)
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid;
$$;

do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role anon;          exception when duplicate_object then null; end $$;
