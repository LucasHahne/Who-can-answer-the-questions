-- =============================================================================
-- Template: one game with 10 dummy questions. Safe to commit: it contains NO game code.
--
-- How to use:
--   1. Copy this file to supabase/seed.sql (gitignored, stays on your computer).
--   2. In the copy, replace HIER_CODE_EINTRAGEN with your own game code and
--      put in your real questions.
--   3. Run the copy in the Supabase SQL editor.
--
-- Game codes are the key to a game: never write a real code into a file that gets committed.
-- Re-running the copy resets that game: the old game, its players and answers are deleted.
-- =============================================================================

do $$
declare
  v_code text := 'HIER_CODE_EINTRAGEN';
  v_game uuid;
begin
  if v_code = 'HIER_CODE_EINTRAGEN' or length(trim(v_code)) < 6 then
    raise exception 'Bitte zuerst einen eigenen Spielcode (mind. 6 Zeichen) eintragen – in der Kopie supabase/seed.sql, nicht in dieser Vorlage.';
  end if;

  delete from public.games where upper(code) = upper(trim(v_code));

  insert into public.games (code, title, status, reveal_mode, timer_seconds,
                            fifty_fifty_enabled, prize_ladder_enabled)
  values (upper(trim(v_code)), 'Testspiel', 'open', 'immediate', 30, true, true)
  returning id into v_game;

  insert into public.questions (game_id, position, text, answer_a, answer_b, answer_c, answer_d, correct)
  select v_game, v.position, v.text, v.a, v.b, v.c, v.d, v.correct
  from (values
    (1,  'Wie viele Beine hat eine Spinne?',                     '6',          '8',            '10',          '12',          'B'),
    (2,  'Welche Farbe entsteht aus Blau und Gelb?',             'Grün',       'Lila',         'Orange',      'Braun',       'A'),
    (3,  'Was ist die Hauptstadt von Österreich?',               'Graz',       'Salzburg',     'Wien',        'Innsbruck',   'C'),
    (4,  'Wie viele Minuten hat eine Stunde?',                   '30',         '100',          '50',          '60',          'D'),
    (5,  'Welches Tier ist das größte Säugetier der Welt?',      'Elefant',    'Blauwal',      'Giraffe',     'Nilpferd',    'B'),
    (6,  'Welcher Planet ist der Sonne am nächsten?',            'Merkur',     'Venus',        'Mars',        'Erde',        'A'),
    (7,  'Wie viele Spieler hat eine Fußballmannschaft auf dem Feld?', '9',    '10',           '11',          '12',          'C'),
    (8,  'In welchem Jahr fiel die Berliner Mauer?',             '1987',       '1991',         '1985',        '1989',        'D'),
    (9,  'Welches chemische Symbol hat Gold?',                   'Go',         'Au',           'Gd',          'Ag',          'B'),
    (10, 'Wie viele Knochen hat ein erwachsener Mensch etwa?',   '206',        '150',          '312',         '98',          'A')
  ) as v(position, text, a, b, c, d, correct);
end $$;
