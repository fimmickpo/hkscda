-- Rate limiting in Postgres, so the public forms need no separate Redis service.
--
-- A sliding-window counter per bucket, with the arithmetic of @upstash/ratelimit's
-- slidingWindow that it replaces: time is cut into fixed windows of p_window_ms, and a
-- request is allowed while
--   (the share of the previous window still inside the sliding window)
--   + (the hits so far in the current window)
-- is below the limit. A refused request is not counted.
--
-- The caller is server code on the service role. It passes an opaque bucket name: the
-- route's prefix plus a keyed hash of the client identifier, so this table never holds an
-- IP address or an email address. A row lives for two windows (it is the current window,
-- then the previous one) and is purged in small batches by the writes themselves, so no
-- scheduled job is needed.

create table public.rate_limit_window (
  bucket text not null check (char_length(bucket) between 1 and 200),
  -- Start of the fixed window, in milliseconds since the Unix epoch.
  window_start bigint not null check (window_start >= 0),
  hits integer not null default 0 check (hits >= 0),
  expires_at timestamptz not null,
  primary key (bucket, window_start)
);

create index rate_limit_window_expires_at_idx on public.rate_limit_window (expires_at);

-- RLS on with no policies: the table is reachable only through the two functions below
-- (owner privileges) and the service role.
alter table public.rate_limit_window enable row level security;

revoke all on table public.rate_limit_window from public, anon, authenticated;
grant select, insert, update, delete on table public.rate_limit_window to service_role;

-- Deletes up to 500 expired rows, oldest first, and returns how many it deleted.
create or replace function public.purge_rate_limit_windows()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.rate_limit_window w
  using (
    select e.bucket, e.window_start
    from public.rate_limit_window e
    where e.expires_at < now()
    order by e.expires_at
    limit 500
  ) expired
  where w.bucket = expired.bucket
    and w.window_start = expired.window_start;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_rate_limit_windows() from public, anon, authenticated;
grant execute on function public.purge_rate_limit_windows() to service_role;

-- Counts one request for p_bucket and says whether it is allowed. Returns
--   {"success": boolean, "limit": p_limit, "remaining": integer, "reset": epoch milliseconds}
-- where "reset" is the end of the current window, the same answer the Upstash limiter gave
-- for a Retry-After header.
create or replace function public.rate_limit_hit(
  p_bucket text,
  p_limit integer,
  p_window_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_window_start bigint;
  v_reset_ms bigint;
  v_previous integer;
  v_current integer;
  v_weighted integer;
begin
  if p_bucket is null or char_length(p_bucket) not between 1 and 200 then
    raise exception 'p_bucket must be 1 to 200 characters' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception 'p_limit must be between 1 and 100000' using errcode = '22023';
  end if;
  if p_window_ms is null or p_window_ms < 1000 or p_window_ms > 86400000 then
    raise exception 'p_window_ms must be between 1000 and 86400000' using errcode = '22023';
  end if;

  v_window_start := v_now_ms - (v_now_ms % p_window_ms);
  v_reset_ms := v_window_start + p_window_ms;

  -- About one request in a hundred clears a batch of expired rows, so the table stays
  -- bounded without a scheduled job.
  if random() < 0.01 then
    perform public.purge_rate_limit_windows();
  end if;

  -- Make sure this window's row exists, then lock it. Concurrent requests for one bucket
  -- queue here, so the count below is never read stale.
  insert into public.rate_limit_window (bucket, window_start, hits, expires_at)
  values (
    p_bucket,
    v_window_start,
    0,
    to_timestamp((v_window_start + 2 * p_window_ms) / 1000.0)
  )
  on conflict (bucket, window_start) do nothing;

  select w.hits into v_current
  from public.rate_limit_window w
  where w.bucket = p_bucket and w.window_start = v_window_start
  for update;

  select w.hits into v_previous
  from public.rate_limit_window w
  where w.bucket = p_bucket and w.window_start = v_window_start - p_window_ms;

  -- The share of the previous window that is still inside the sliding window, rounded down.
  v_weighted := floor(
    coalesce(v_previous, 0) * (1 - (v_now_ms - v_window_start)::numeric / p_window_ms)
  )::integer;
  v_current := coalesce(v_current, 0);

  if v_weighted + v_current >= p_limit then
    return jsonb_build_object(
      'success', false,
      'limit', p_limit,
      'remaining', 0,
      'reset', v_reset_ms
    );
  end if;

  update public.rate_limit_window w
  set hits = w.hits + 1
  where w.bucket = p_bucket and w.window_start = v_window_start;

  return jsonb_build_object(
    'success', true,
    'limit', p_limit,
    'remaining', p_limit - (v_weighted + v_current + 1),
    'reset', v_reset_ms
  );
end;
$$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
