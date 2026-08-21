-- BJA join-interview applicants table
-- Run once in the Supabase SQL editor.

create table if not exists applicants (
    telegram_id bigint primary key,
    username text,
    tg_first_name text,
    chat_requested bigint,          -- group the join request came from
    state text,                     -- current interview question / wait state
    answers jsonb default '{}'::jsonb,
    status text default 'in_progress',
        -- in_progress | submitted | approved | rejected | retro_pending
    needs_verification boolean default false,
    verification_reasons text[] default '{}',
    sheet_row integer,              -- row in the Members tab (dedupe / updates)
    member_id integer,              -- ID column in the sheet (seniority)
    decided_by bigint,              -- admin telegram id
    decided_at timestamptz,
    submitted_at timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create index if not exists applicants_status_idx on applicants (status);
