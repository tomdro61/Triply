-- Chat sessions table for AI chat conversation logging
-- Stores all AI chat conversations for analytics and support

create table chat_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  user_id uuid references auth.users(id),
  ip_address text,
  messages jsonb not null default '[]',
  converted_to_booking boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_chat_sessions_session_id on chat_sessions(session_id);
create index idx_chat_sessions_created_at on chat_sessions(created_at);

-- RLS: Users can read their own sessions, admins can read all
alter table chat_sessions enable row level security;

create policy "Users can read own chat sessions"
  on chat_sessions for select
  using (auth.uid() = user_id);

create policy "Service role can manage all chat sessions"
  on chat_sessions for all
  using (true)
  with check (true);
