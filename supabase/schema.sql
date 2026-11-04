-- =============================================================================
-- Wer wird Millionär – JGA Party Quiz: database schema
-- Tables, indexes, RLS, revokes/grants and all RPC functions (see PLAN.md §2–4).
-- Safe to re-run: tables/indexes use IF NOT EXISTS, functions are dropped and recreated.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------

create table if not exists public.games (
  id                   uuid        primary key default gen_random_uuid(),
  code                 text        not null,
  title                text,
  status               text        not null default 'open'
                                   check (status in ('open', 'closed')),
  reveal_mode          text        not null default 'end'
                                   check (reveal_mode in ('immediate', 'end')),
  timer_seconds        int         check (timer_seconds is null or timer_seconds between 5 and 300),
  fifty_fifty_enabled  boolean     not null default false,
  prize_ladder_enabled boolean     not null default false,
  max_players          int         not null default 50
                                   check (max_players between 1 and 500),
  created_at           timestamptz not null default now()
);

-- Added after the first deploy; keeps re-runs on an existing database working.
alter table public.games add column if not exists max_players int not null default 50
  check (max_players between 1 and 500);

create unique index if not exists games_code_upper_key on public.games (upper(code));

create table if not exists public.questions (
  id       uuid    primary key default gen_random_uuid(),
  game_id  uuid    not null references public.games (id) on delete cascade,
  position int     not null check (position between 1 and 10),
  text     text    not null,
  answer_a text    not null,
  answer_b text    not null,
  answer_c text    not null,
  answer_d text    not null,
  correct  char(1) not null check (correct in ('A', 'B', 'C', 'D')),
  constraint questions_game_position_key unique (game_id, position)
);

create table if not exists public.players (
  id               uuid        primary key default gen_random_uuid(),
  game_id          uuid        not null references public.games (id) on delete cascade,
  name             text        not null check (length(trim(name)) between 1 and 30),
  token            uuid        not null unique default gen_random_uuid(),
  used_fifty_fifty boolean     not null default false,
  joined_at        timestamptz not null default now(),
  finished_at      timestamptz
);

create unique index if not exists players_game_name_key
  on public.players (game_id, lower(trim(name)));

create table if not exists public.player_answers (
  id          uuid        primary key default gen_random_uuid(),
  player_id   uuid        not null references public.players (id) on delete cascade,
  question_id uuid        not null references public.questions (id) on delete cascade,
  shown_at    timestamptz not null default now(),
  removed     text        check (removed is null or removed ~ '^[ABCD]{2}$'),
  chosen      char(1)     check (chosen in ('A', 'B', 'C', 'D')),
  is_correct  boolean,
  answered_at timestamptz,               -- not null = finalized (answered or timed out)
  constraint player_answers_player_question_key unique (player_id, question_id)
);

create index if not exists player_answers_question_id_idx on public.player_answers (question_id);

-- -----------------------------------------------------------------------------
-- 2. Security: RLS on, no policies, no direct table access for API roles
-- RLS is not FORCEd on purpose: the security definer functions run as the table
-- owner (postgres) and must bypass RLS. Nobody else has any table privilege.
-- -----------------------------------------------------------------------------

alter table public.games          enable row level security;
alter table public.questions      enable row level security;
alter table public.players        enable row level security;
alter table public.player_answers enable row level security;

revoke all on public.games, public.questions, public.players, public.player_answers
  from anon, authenticated;
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Supabase's default privileges grant anon/authenticated full access to every NEW
-- table, sequence and function in public. Turn that off, so anything added later
-- (e.g. a quick table made in the dashboard) is private until granted explicitly.
alter default privileges for role postgres in schema public
  revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
-- PUBLIC's EXECUTE on new functions is a built-in *global* default, which a
-- per-schema statement cannot remove (anon is a member of PUBLIC).
alter default privileges for role postgres
  revoke execute on functions from public;

-- Supabase's "auto-enable RLS" event-trigger function. It cannot be called via the
-- API (it returns event_trigger), but no API role needs EXECUTE on it either.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Functions
-- -----------------------------------------------------------------------------

drop function if exists public._current_question_id(uuid);
drop function if exists public._sweep_timeout(uuid);
drop function if exists public.join_game(text, text);
drop function if exists public.get_current_question(uuid);
drop function if exists public.submit_answer(uuid, uuid, text);
drop function if exists public.use_fifty_fifty(uuid);
drop function if exists public.get_my_answers(uuid);
drop function if exists public.get_leaderboard(text);

-- Internal: the player's current question = lowest position without a finalized answer.
-- Returns null when every question is finalized.
create function public._current_question_id(p_player_id uuid)
returns uuid
language sql
security definer
set search_path = public
as $$
  select q.id
  from players p
  join questions q on q.game_id = p.game_id
  where p.id = p_player_id
    and not exists (
      select 1 from player_answers pa
      where pa.player_id = p_player_id
        and pa.question_id = q.id
        and pa.answered_at is not null
    )
  order by q.position
  limit 1;
$$;

-- Internal: finalize an expired open question as timed out (2 s grace),
-- then set players.finished_at once every question is finalized.
create function public._sweep_timeout(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timer int;
begin
  select g.timer_seconds into v_timer
  from players p
  join games g on g.id = p.game_id
  where p.id = p_player_id;

  if not found then
    return;
  end if;

  if v_timer is not null then
    update player_answers pa
       set chosen      = null,
           is_correct  = false,
           answered_at = pa.shown_at + v_timer * interval '1 second'
     where pa.player_id = p_player_id
       and pa.answered_at is null
       and now() > pa.shown_at + (v_timer + 2) * interval '1 second';
  end if;

  if _current_question_id(p_player_id) is null then
    update players p
       set finished_at = now()
     where p.id = p_player_id
       and p.finished_at is null;
  end if;
end;
$$;

-- 4.1 join_game
create function public.join_game(p_code text, p_name text)
returns table (
  token                uuid,
  game_title           text,
  reveal_mode          text,
  timer_seconds        int,
  fifty_fifty_enabled  boolean,
  prize_ladder_enabled boolean,
  total_questions      int
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_game  games%rowtype;
  v_code  text := upper(trim(coalesce(p_code, '')));
  v_name  text := trim(coalesce(p_name, ''));
  v_token uuid;
begin
  if length(v_code) not between 1 and 20 then
    return;  -- same answer as an unknown code
  end if;

  -- Lock the game row: serializes joins, so max_players cannot be overrun.
  select g.* into v_game
  from games g
  where upper(g.code) = v_code
    and g.status = 'open'
  for update;

  if not found then
    return;  -- unknown or closed code: zero rows, no error
  end if;

  if length(v_name) < 1 or length(v_name) > 30 or v_name ~ '[[:cntrl:]]' then
    raise exception 'NAME_INVALID';
  end if;

  if (select count(*) from players p where p.game_id = v_game.id) >= v_game.max_players then
    raise exception 'GAME_FULL';
  end if;

  begin
    insert into players (game_id, name)
    values (v_game.id, v_name)
    returning players.token into v_token;
  exception when unique_violation then
    raise exception 'NAME_TAKEN';
  end;

  return query
  select v_token,
         v_game.title,
         v_game.reveal_mode,
         v_game.timer_seconds,
         v_game.fifty_fifty_enabled,
         v_game.prize_ladder_enabled,
         (select count(*)::int from questions q where q.game_id = v_game.id);
end;
$$;

-- 4.2 get_current_question
create function public.get_current_question(p_token uuid)
returns table (
  state                text,
  question_id          uuid,
  "position"             int,
  total_questions      int,
  text                 text,
  answer_a             text,
  answer_b             text,
  answer_c             text,
  answer_d             text,
  removed              text,
  seconds_left         int,
  used_fifty_fifty     boolean,
  game_title           text,
  reveal_mode          text,
  timer_seconds        int,
  fifty_fifty_enabled  boolean,
  prize_ladder_enabled boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_player players%rowtype;
  v_game   games%rowtype;
  v_q      questions%rowtype;
  v_pa     player_answers%rowtype;
  v_qid    uuid;
  v_total  int;
begin
  -- Lock the player row: serializes concurrent calls of the same player.
  select p.* into v_player from players p where p.token = p_token for update;
  if not found then
    return;
  end if;

  select g.* into v_game from games g where g.id = v_player.game_id;
  select count(*)::int into v_total from questions q where q.game_id = v_game.id;

  perform _sweep_timeout(v_player.id);

  v_qid := _current_question_id(v_player.id);

  if v_qid is null then
    update players p set finished_at = now()
     where p.id = v_player.id and p.finished_at is null;

    return query
    select 'finished'::text, null::uuid, null::int, v_total,
           null::text, null::text, null::text, null::text, null::text,
           null::text, null::int, v_player.used_fifty_fifty,
           v_game.title, v_game.reveal_mode, v_game.timer_seconds,
           v_game.fifty_fifty_enabled, v_game.prize_ladder_enabled;
    return;
  end if;

  -- First serve sets shown_at; a refresh keeps it (timer does not restart).
  insert into player_answers (player_id, question_id)
  values (v_player.id, v_qid)
  on conflict on constraint player_answers_player_question_key do nothing;

  select q.* into v_q from questions q where q.id = v_qid;
  select pa.* into v_pa from player_answers pa
   where pa.player_id = v_player.id and pa.question_id = v_qid;

  return query
  select 'question'::text,
         v_q.id,
         v_q.position,
         v_total,
         v_q.text,
         v_q.answer_a, v_q.answer_b, v_q.answer_c, v_q.answer_d,
         v_pa.removed,
         case when v_game.timer_seconds is null then null
              else greatest(0, ceil(v_game.timer_seconds
                                    - extract(epoch from now() - v_pa.shown_at)))::int
         end,
         v_player.used_fifty_fifty,
         v_game.title, v_game.reveal_mode, v_game.timer_seconds,
         v_game.fifty_fifty_enabled, v_game.prize_ladder_enabled;
end;
$$;

-- 4.3 submit_answer
create function public.submit_answer(p_token uuid, p_question_id uuid, p_choice text)
returns table (
  accepted   boolean,
  timed_out  boolean,
  is_correct boolean,
  correct    text,
  finished   boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_player   players%rowtype;
  v_game     games%rowtype;
  v_pa       player_answers%rowtype;
  v_correct  text;
  v_choice   text := upper(trim(coalesce(p_choice, '')));
  v_timedout boolean := false;
  v_ok       boolean;
  v_finished boolean;
begin
  select p.* into v_player from players p where p.token = p_token for update;
  if not found then
    raise exception 'INVALID_TOKEN';
  end if;

  if v_choice not in ('A', 'B', 'C', 'D') then
    raise exception 'INVALID_CHOICE';
  end if;

  select g.* into v_game from games g where g.id = v_player.game_id;

  select pa.* into v_pa from player_answers pa
   where pa.player_id = v_player.id and pa.question_id = p_question_id
   for update;

  if not found then
    raise exception 'NOT_CURRENT_QUESTION';
  end if;
  if v_pa.answered_at is not null then
    raise exception 'ALREADY_ANSWERED';
  end if;
  if _current_question_id(v_player.id) is distinct from p_question_id then
    raise exception 'NOT_CURRENT_QUESTION';
  end if;
  if v_pa.removed is not null and strpos(v_pa.removed, v_choice) > 0 then
    raise exception 'INVALID_CHOICE';
  end if;

  select q.correct::text into v_correct from questions q where q.id = p_question_id;

  if v_game.timer_seconds is not null
     and now() > v_pa.shown_at + (v_game.timer_seconds + 2) * interval '1 second' then
    v_timedout := true;
    v_ok := false;
    update player_answers pa
       set chosen      = null,
           is_correct  = false,
           answered_at = pa.shown_at + v_game.timer_seconds * interval '1 second'
     where pa.id = v_pa.id;
  else
    v_ok := (v_choice = v_correct);
    update player_answers pa
       set chosen      = v_choice,
           is_correct  = v_ok,
           answered_at = now()
     where pa.id = v_pa.id;
  end if;

  -- Sets finished_at if this was the last question.
  perform _sweep_timeout(v_player.id);

  select (p.finished_at is not null) into v_finished from players p where p.id = v_player.id;

  return query
  select not v_timedout,
         v_timedout,
         case when v_game.reveal_mode = 'immediate' then v_ok end,
         case when v_game.reveal_mode = 'immediate' then v_correct end,
         v_finished;
end;
$$;

-- 4.4 use_fifty_fifty
create function public.use_fifty_fifty(p_token uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player  players%rowtype;
  v_game    games%rowtype;
  v_qid     uuid;
  v_pa_id   uuid;
  v_correct text;
  v_removed text;
begin
  select p.* into v_player from players p where p.token = p_token for update;
  if not found then
    raise exception 'INVALID_TOKEN';
  end if;

  select g.* into v_game from games g where g.id = v_player.game_id;

  if not v_game.fifty_fifty_enabled then
    raise exception 'FIFTY_FIFTY_DISABLED';
  end if;
  if v_player.used_fifty_fifty then
    raise exception 'FIFTY_FIFTY_USED';
  end if;

  perform _sweep_timeout(v_player.id);

  v_qid := _current_question_id(v_player.id);

  select pa.id into v_pa_id from player_answers pa
   where pa.player_id = v_player.id
     and pa.question_id = v_qid
     and pa.answered_at is null
   for update;

  if v_pa_id is null then
    raise exception 'NO_OPEN_QUESTION';
  end if;

  select q.correct::text into v_correct from questions q where q.id = v_qid;

  select string_agg(l, '' order by l) into v_removed
  from (
    select l
    from unnest(array['A', 'B', 'C', 'D']) as l
    where l <> v_correct
    order by random()
    limit 2
  ) s;

  update player_answers pa set removed = v_removed where pa.id = v_pa_id;
  update players p set used_fifty_fifty = true where p.id = v_player.id;

  return v_removed;
end;
$$;

-- 4.5 get_my_answers
create function public.get_my_answers(p_token uuid)
returns table (
  "position"   int,
  text       text,
  answer_a   text,
  answer_b   text,
  answer_c   text,
  answer_d   text,
  chosen     text,
  correct    text,
  is_correct boolean,
  removed    text,
  time_ms    int
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_player players%rowtype;
begin
  select p.* into v_player from players p where p.token = p_token;
  if not found then
    return;
  end if;

  if v_player.finished_at is null then
    raise exception 'NOT_FINISHED';
  end if;

  return query
  select q.position,
         q.text,
         q.answer_a, q.answer_b, q.answer_c, q.answer_d,
         pa.chosen::text,
         q.correct::text,
         pa.is_correct,
         pa.removed,
         round(extract(epoch from pa.answered_at - pa.shown_at) * 1000)::int
  from questions q
  left join player_answers pa
         on pa.question_id = q.id and pa.player_id = v_player.id
  where q.game_id = v_player.game_id
  order by q.position;
end;
$$;

-- 4.6 get_leaderboard
create function public.get_leaderboard(p_code text)
returns table (
  rank            int,
  name            text,
  correct_count   int,
  total_time_ms   bigint,
  answered_count  int,
  total_questions int,
  finished        boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_game_id uuid;
  v_total   int;
begin
  if length(trim(coalesce(p_code, ''))) not between 1 and 20 then
    return;
  end if;

  select g.id into v_game_id from games g where upper(g.code) = upper(trim(p_code));
  if not found then
    return;
  end if;

  select count(*)::int into v_total from questions q where q.game_id = v_game_id;

  return query
  with stats as (
    select p.name                                                     as s_name,
           (p.finished_at is not null)                                as s_finished,
           (count(pa.id) filter (where pa.answered_at is not null
                                   and pa.is_correct))::int           as s_correct,
           (count(pa.id) filter (where pa.answered_at is not null))::int as s_answered,
           coalesce(sum(round(extract(epoch from pa.answered_at - pa.shown_at) * 1000))
                      filter (where pa.answered_at is not null), 0)::bigint as s_time
    from players p
    left join player_answers pa on pa.player_id = p.id
    where p.game_id = v_game_id
    group by p.id, p.name, p.finished_at
  )
  select case when s.s_finished
              then (rank() over (partition by s.s_finished
                                 order by s.s_correct desc, s.s_time asc))::int
         end,
         s.s_name,
         s.s_correct,
         s.s_time,
         s.s_answered,
         v_total,
         s.s_finished
  from stats s
  order by s.s_finished desc, s.s_correct desc, s.s_time asc, s.s_name asc;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Function privileges
-- Revoke everything, then grant only the 6 game RPCs, and only to anon (the role of
-- the publishable key). The app has no logins, so authenticated gets nothing.
-- -----------------------------------------------------------------------------

revoke execute on function public._current_question_id(uuid)          from public, anon, authenticated;
revoke execute on function public._sweep_timeout(uuid)                from public, anon, authenticated;
revoke execute on function public.join_game(text, text)               from public, anon, authenticated;
revoke execute on function public.get_current_question(uuid)          from public, anon, authenticated;
revoke execute on function public.submit_answer(uuid, uuid, text)     from public, anon, authenticated;
revoke execute on function public.use_fifty_fifty(uuid)               from public, anon, authenticated;
revoke execute on function public.get_my_answers(uuid)                from public, anon, authenticated;
revoke execute on function public.get_leaderboard(text)               from public, anon, authenticated;

grant execute on function public.join_game(text, text)                to anon;
grant execute on function public.get_current_question(uuid)           to anon;
grant execute on function public.submit_answer(uuid, uuid, text)      to anon;
grant execute on function public.use_fifty_fifty(uuid)                to anon;
grant execute on function public.get_my_answers(uuid)                 to anon;
grant execute on function public.get_leaderboard(text)                to anon;
