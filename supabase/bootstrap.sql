-- BJA Bot - full database bootstrap (fresh Supabase project)
-- Creates every table the bot uses. Run once in the SQL editor.

-- User navigation state
create table if not exists users (
    user_id bigint primary key,
    username text,
    first_name text,
    chat_mode text,
    created_at timestamptz default now()
);

-- Anonymous question moderation queue (+ crm updates)
create table if not exists queue (
    id bigserial primary key,
    type text,
    status text default 'pending',
    user_id bigint,
    username text,
    message text,
    approved_by bigint,
    approved_at timestamptz,
    created_at timestamptz default now()
);

-- Banned users
create table if not exists blacklist (
    user_id bigint primary key,
    created_at timestamptz default now()
);

-- Legacy message log (admin fetch/clean)
create table if not exists messages (
    id bigserial primary key,
    username text,
    message text,
    created_at timestamptz default now()
);

-- Bot config (on/off switch; also pinged by the keepalive workflow)
create table if not exists status (
    key text primary key,
    value text
);
insert into status (key, value) values ('enabled', 'true')
on conflict (key) do nothing;

-- Join-interview applicants
create table if not exists applicants (
    telegram_id bigint primary key,
    username text,
    tg_first_name text,
    chat_requested bigint,
    state text,
    answers jsonb default '{}'::jsonb,
    status text default 'in_progress',
        -- in_progress | submitted | approved | rejected | retro_pending
    needs_verification boolean default false,
    verification_reasons text[] default '{}',
    sheet_row integer,
    member_id integer,
    decided_by bigint,
    decided_at timestamptz,
    submitted_at timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create index if not exists applicants_status_idx on applicants (status);
