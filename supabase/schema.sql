-- =====================================================================
-- 빈티지 매장 재고 공유 프로그램 - Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전하도록 작성되어 있습니다.
-- =====================================================================

-- ---------- 테이블 ----------
create table if not exists public.stores (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null unique,
  name       text not null,
  role       text not null check (role in ('super', 'admin', 'manager', 'cashier')),
  store_id   bigint references public.stores(id),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id            bigint generated always as identity primary key,
  code          text not null,
  name          text not null default '',
  price         integer,
  memo          text not null default '',
  photo_path    text,
  thumb_path    text,
  store_id      bigint not null references public.stores(id),
  status        text not null default 'available' check (status in ('available', 'sold')),
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  sold_at       timestamptz,
  sold_by       uuid references public.profiles(id),
  sold_store_id bigint references public.stores(id),
  sold_price    integer
);
create unique index if not exists products_code_upper_key on public.products (upper(code));
create index if not exists products_store_status_idx on public.products (store_id, status);
create index if not exists products_created_idx on public.products (created_at desc);
create index if not exists products_sold_idx on public.products (sold_at desc);

create table if not exists public.product_events (
  id         bigint generated always as identity primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  action     text not null,          -- created / updated / moved / sold / unsold
  detail     text not null default '',
  user_id    uuid references public.profiles(id),
  store_id   bigint references public.stores(id),
  created_at timestamptz not null default now()
);
create index if not exists product_events_product_idx on public.product_events (product_id, created_at);

-- 결제수단 (정산용): cash 현금 / card 카드 / transfer 계좌이체
alter table public.products add column if not exists sold_payment text;
alter table public.products drop constraint if exists products_sold_payment_check;
alter table public.products add constraint products_sold_payment_check check (sold_payment in ('cash', 'card', 'transfer'));
create index if not exists products_sold_store_idx on public.products (sold_store_id, sold_at desc);

-- 기존 설치본 업그레이드: 총관리자(super) 등급 허용
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('super', 'admin', 'manager', 'cashier'));

-- ---------- 이용기간 (총관리자가 매달 연장) ----------
create table if not exists public.license (
  id          int primary key default 1 check (id = 1),     -- 항상 한 줄
  paid_until  date not null,                                -- 이 날짜(한국시간)까지 사용 가능
  grace_days  int  not null default 3 check (grace_days between 0 and 60), -- 만료 후 유예일
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id)
);
insert into public.license (id, paid_until)
values (1, ((now() at time zone 'Asia/Seoul')::date + interval '1 month')::date)
on conflict (id) do nothing;

create table if not exists public.license_events (
  id         bigint generated always as identity primary key,
  from_date  date,
  to_date    date not null,
  grace_days int,
  memo       text not null default '',
  user_id    uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ---------- 권한 헬퍼 ----------
-- 이용기간이 남아 있는지 (유예기간 포함)
create or replace function public.license_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select (now() at time zone 'Asia/Seoul')::date <= paid_until + grace_days from license where id = 1),
    true);
$$;

-- 활성 계정 + (총관리자이거나 이용기간 안) 이어야 데이터 접근 가능
create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and (role = 'super' or public.license_ok())
  );
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active()
     and exists (select 1 from profiles where id = auth.uid() and role in ('admin', 'super'));
$$;

create or replace function public.is_super() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'super');
$$;

create or replace function public.current_profile() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare v profiles;
begin
  select * into v from profiles where id = auth.uid() and active;
  if not found then
    raise exception '로그인이 필요하거나 비활성화된 계정입니다' using errcode = '28000';
  end if;
  if v.role <> 'super' and not public.license_ok() then
    raise exception '이용 기간이 만료되었습니다. 총관리자(개발자)에게 문의하세요' using errcode = '28000';
  end if;
  return v;
end $$;

-- ---------- RLS: 로그인한(활성) 직원은 모두 조회 가능, 변경은 아래 함수로만 ----------
alter table public.stores         enable row level security;
alter table public.profiles       enable row level security;
alter table public.products       enable row level security;
alter table public.product_events enable row level security;
alter table public.license        enable row level security;  -- 직접 접근 불가, 아래 함수로만
alter table public.license_events enable row level security;

drop policy if exists "stores read"   on public.stores;
drop policy if exists "stores admin"  on public.stores;
drop policy if exists "profiles read" on public.profiles;
drop policy if exists "profiles read own" on public.profiles;
drop policy if exists "license events super" on public.license_events;
drop policy if exists "products read" on public.products;
drop policy if exists "events read"   on public.product_events;

create policy "stores read"   on public.stores         for select to authenticated using (public.is_active());
create policy "stores admin"  on public.stores         for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "profiles read" on public.profiles       for select to authenticated using (public.is_active());
create policy "profiles read own" on public.profiles   for select to authenticated using (id = auth.uid());
create policy "products read" on public.products       for select to authenticated using (public.is_active());
create policy "events read"   on public.product_events for select to authenticated using (public.is_active());
create policy "license events super" on public.license_events for select to authenticated using (public.is_super());
-- profiles 생성/수정은 관리자 전용 Edge Function(admin-users)이 service_role 로 처리합니다.

-- ---------- 상품 등록 ----------
create or replace function public.create_product(
  p_code text, p_name text, p_price integer, p_memo text,
  p_store_id bigint, p_photo_path text, p_thumb_path text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_me    profiles := current_profile();
  v_code  text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_store bigint;
  v_dup   record;
  v_id    bigint;
begin
  if v_me.role = 'cashier' then raise exception '캐셔 계정은 상품을 등록할 수 없습니다'; end if;
  if v_code = '' then raise exception '상품코드를 입력하세요'; end if;
  if length(v_code) > 40 then raise exception '상품코드가 너무 깁니다'; end if;
  v_store := case when v_me.role in ('admin', 'super') then p_store_id else v_me.store_id end;
  if v_store is null or not exists (select 1 from stores where id = v_store) then
    raise exception '매장을 선택하세요';
  end if;
  if p_photo_path is null or p_photo_path = '' then raise exception '상품 사진을 넣어주세요'; end if;

  select p.status, s.name as store_name into v_dup
    from products p join stores s on s.id = p.store_id where upper(p.code) = v_code;
  if found then
    raise exception '이미 등록된 상품코드입니다 (%, %)', v_dup.store_name,
      case when v_dup.status = 'sold' then '판매완료' else '판매중' end;
  end if;

  insert into products (code, name, price, memo, photo_path, thumb_path, store_id, created_by)
  values (v_code, trim(coalesce(p_name, '')), p_price, trim(coalesce(p_memo, '')),
          p_photo_path, coalesce(p_thumb_path, p_photo_path), v_store, v_me.id)
  returning id into v_id;

  insert into product_events (product_id, action, user_id, store_id) values (v_id, 'created', v_me.id, v_store);
  return v_id;
end $$;

-- ---------- 상품 수정 / 매장 이동 ----------
-- p_photo_path 가 null 이면 기존 사진 유지. 바뀐 경우 예전 사진 경로를 돌려줘서 앱이 파일을 지웁니다.
create or replace function public.update_product(
  p_id bigint, p_code text, p_name text, p_price integer, p_memo text,
  p_store_id bigint, p_photo_path text default null, p_thumb_path text default null
) returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_me   profiles := current_profile();
  v_p    products;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_store bigint;
  v_from text; v_to text;
  v_old  text[] := '{}';
begin
  if v_me.role = 'cashier' then raise exception '캐셔 계정은 상품을 수정할 수 없습니다'; end if;
  select * into v_p from products where id = p_id for update;
  if not found then raise exception '상품을 찾을 수 없습니다'; end if;
  if v_me.role not in ('admin', 'super') and v_me.store_id is distinct from v_p.store_id then
    raise exception '다른 매장 상품은 수정할 수 없습니다';
  end if;
  if v_code = '' then raise exception '상품코드를 입력하세요'; end if;
  if upper(v_p.code) <> v_code and exists (select 1 from products where upper(code) = v_code and id <> p_id) then
    raise exception '이미 등록된 상품코드입니다';
  end if;

  v_store := coalesce(p_store_id, v_p.store_id);
  if v_store <> v_p.store_id then
    if v_p.status = 'sold' then raise exception '판매완료 상품은 매장을 옮길 수 없습니다'; end if;
    if not exists (select 1 from stores where id = v_store) then raise exception '매장을 선택하세요'; end if;
  end if;

  if p_photo_path is not null and p_photo_path <> '' then
    v_old := array_remove(array[v_p.photo_path, v_p.thumb_path], null);
  end if;

  update products set
    code = v_code,
    name = trim(coalesce(p_name, '')),
    price = p_price,
    memo = trim(coalesce(p_memo, '')),
    store_id = v_store,
    photo_path = coalesce(nullif(p_photo_path, ''), photo_path),
    thumb_path = case when coalesce(p_photo_path, '') <> '' then coalesce(p_thumb_path, p_photo_path) else thumb_path end,
    updated_at = now()
  where id = p_id;

  if v_store <> v_p.store_id then
    select name into v_from from stores where id = v_p.store_id;
    select name into v_to   from stores where id = v_store;
    insert into product_events (product_id, action, detail, user_id, store_id)
    values (p_id, 'moved', v_from || ' → ' || v_to, v_me.id, v_store);
  end if;
  insert into product_events (product_id, action, detail, user_id, store_id)
  values (p_id, 'updated',
          case when upper(v_p.code) <> v_code then '코드 ' || v_p.code || ' → ' || v_code else '' end,
          v_me.id, v_store);
  return v_old;
end $$;

-- ---------- 판매 처리 ----------
-- 행 잠금(for update)으로 두 매장에서 동시에 눌러도 한 번만 성공합니다.
drop function if exists public.sell_product(bigint, integer);
create or replace function public.sell_product(p_id bigint, p_sold_price integer default null, p_payment text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me    profiles := current_profile();
  v_p     products;
  v_store text;
  v_who   text;
  v_price integer;
begin
  select * into v_p from products where id = p_id for update;
  if not found then raise exception '상품을 찾을 수 없습니다'; end if;
  select name into v_store from stores where id = v_p.store_id;
  if v_p.status = 'sold' then
    select name into v_who from profiles where id = v_p.sold_by;
    raise exception '이미 판매된 상품입니다 (%, %, %)', v_store, coalesce(v_who, '-'),
      to_char(v_p.sold_at at time zone 'Asia/Seoul', 'MM/DD HH24:MI');
  end if;
  if v_me.role not in ('admin', 'super') and v_me.store_id is distinct from v_p.store_id then
    raise exception '이 상품은 % 상품입니다. 해당 매장에서만 판매 처리할 수 있습니다', v_store;
  end if;
  if p_payment is not null and p_payment not in ('cash', 'card', 'transfer') then
    raise exception '결제수단이 올바르지 않습니다';
  end if;
  v_price := coalesce(p_sold_price, v_p.price);
  update products set status = 'sold', sold_at = now(), sold_by = v_me.id,
         sold_store_id = store_id, sold_price = v_price, sold_payment = p_payment, updated_at = now()
   where id = p_id;
  insert into product_events (product_id, action, detail, user_id, store_id)
  values (p_id, 'sold',
          concat_ws(' · ',
            case when v_price is null then null else to_char(v_price, 'FM999,999,999') || '원' end,
            case p_payment when 'cash' then '현금' when 'card' then '카드' when 'transfer' then '이체' end),
          v_me.id, v_p.store_id);
end $$;

-- ---------- 판매 취소 ----------
create or replace function public.unsell_product(p_id bigint, p_reason text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me profiles := current_profile();
  v_p  products;
begin
  select * into v_p from products where id = p_id for update;
  if not found then raise exception '상품을 찾을 수 없습니다'; end if;
  if v_p.status <> 'sold' then raise exception '판매완료 상태가 아닙니다'; end if;
  if v_me.role not in ('admin', 'super') and v_me.store_id is distinct from v_p.store_id then
    raise exception '판매한 매장 또는 관리자만 취소할 수 있습니다';
  end if;
  if v_me.role = 'cashier' and (v_p.sold_by is distinct from v_me.id
      or (v_p.sold_at at time zone 'Asia/Seoul')::date <> (now() at time zone 'Asia/Seoul')::date) then
    raise exception '캐셔는 본인이 오늘 판매한 건만 취소할 수 있습니다. 실장에게 요청하세요';
  end if;
  update products set status = 'available', sold_at = null, sold_by = null,
         sold_store_id = null, sold_price = null, sold_payment = null, updated_at = now()
   where id = p_id;
  insert into product_events (product_id, action, detail, user_id, store_id)
  values (p_id, 'unsold', trim(coalesce(p_reason, '')), v_me.id, v_p.store_id);
end $$;

-- ---------- 상품 삭제 (관리자) : 지울 사진 경로를 돌려줌 ----------
create or replace function public.delete_product(p_id bigint)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  v_me profiles := current_profile();
  v_p  products;
begin
  if v_me.role not in ('admin', 'super') then raise exception '관리자만 삭제할 수 있습니다'; end if;
  delete from products where id = p_id returning * into v_p;
  if not found then raise exception '상품을 찾을 수 없습니다'; end if;
  return array_remove(array[v_p.photo_path, v_p.thumb_path], null);
end $$;

-- ---------- 매장별 재고/오늘 판매 수 ----------
create or replace function public.store_summary()
returns table (id bigint, name text, available bigint, sold_today bigint)
language sql stable security invoker set search_path = public as $$
  select s.id, s.name,
    (select count(*) from products p where p.store_id = s.id and p.status = 'available'),
    (select count(*) from products p where p.sold_store_id = s.id
       and p.sold_at >= (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul'))
  from stores s order by s.id;
$$;

-- ---------- 상품코드 자동 제안 (V + 날짜 + 순번) ----------
create or replace function public.suggest_code()
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_prefix text := 'V' || to_char(now() at time zone 'Asia/Seoul', 'YYMMDD') || '-';
  n int;
begin
  perform current_profile();
  select count(*) + 1 into n from products where code like v_prefix || '%';
  while exists (select 1 from products where upper(code) = v_prefix || lpad(n::text, 3, '0')) loop
    n := n + 1;
  end loop;
  return v_prefix || lpad(n::text, 3, '0');
end $$;

-- ---------- 최초 관리자 설정 (관리자가 한 명도 없을 때만 동작) ----------
create or replace function public.needs_setup() returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles where role in ('admin', 'super'));
$$;

create or replace function public.claim_admin(p_username text, p_name text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_username text := lower(trim(coalesce(p_username, '')));
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  lock table profiles in share row exclusive mode;  -- 동시에 두 명이 시도해도 한 명만 성공
  if exists (select 1 from profiles where role in ('admin', 'super')) then
    raise exception '이미 관리자가 있습니다. 관리자에게 계정을 받으세요';
  end if;
  if v_username !~ '^[a-z0-9_.-]{3,30}$' then raise exception '아이디는 영문 소문자/숫자 3~30자로 입력하세요'; end if;
  insert into profiles (id, username, name, role)
  values (auth.uid(), v_username, coalesce(nullif(trim(p_name), ''), '총관리자'), 'super')
  on conflict (id) do update set role = 'super', active = true, username = excluded.username, name = excluded.name;
end $$;

revoke execute on function public.needs_setup() from public;
revoke execute on function public.claim_admin(text, text) from public, anon;
grant execute on function public.needs_setup() to anon, authenticated;
grant execute on function public.claim_admin(text, text) to authenticated;

-- ---------- 이용기간 조회 / 연장 ----------
-- 상태: ok(정상) / warning(7일 이내 만료) / grace(만료, 유예기간) / expired(사용 중지)
create or replace function public.license_status()
returns table (paid_until date, grace_days int, today date, days_left int, state text)
language plpgsql stable security definer set search_path = public as $$
declare
  l license;
  t date := (now() at time zone 'Asia/Seoul')::date;
begin
  if not exists (select 1 from profiles where id = auth.uid() and active) then
    raise exception '로그인이 필요합니다';
  end if;
  select * into l from license where id = 1;
  return query select l.paid_until, l.grace_days, t, (l.paid_until - t),
    case when t <= l.paid_until - 7 then 'ok'
         when t <= l.paid_until then 'warning'
         when t <= l.paid_until + l.grace_days then 'grace'
         else 'expired' end;
end $$;

-- 총관리자 전용: 사용 기한을 특정 날짜로 지정
create or replace function public.set_license(p_paid_until date, p_grace_days int default null, p_memo text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare l license;
begin
  if not public.is_super() then raise exception '총관리자만 이용기간을 바꿀 수 있습니다'; end if;
  if p_paid_until is null then raise exception '날짜를 입력하세요'; end if;
  select * into l from license where id = 1 for update;
  update license set paid_until = p_paid_until, grace_days = coalesce(p_grace_days, grace_days),
         updated_at = now(), updated_by = auth.uid()
   where id = 1;
  insert into license_events (from_date, to_date, grace_days, memo, user_id)
  values (l.paid_until, p_paid_until, coalesce(p_grace_days, l.grace_days), trim(coalesce(p_memo, '')), auth.uid());
end $$;

-- 총관리자 전용: N개월 연장 (남은 기간이 있으면 그 뒤로, 이미 지났으면 오늘부터)
create or replace function public.extend_license(p_months int, p_memo text default '')
returns date
language plpgsql security definer set search_path = public as $$
declare
  l license;
  v_new date;
begin
  if not public.is_super() then raise exception '총관리자만 이용기간을 바꿀 수 있습니다'; end if;
  if p_months is null or p_months < 1 or p_months > 36 then raise exception '연장 개월 수가 올바르지 않습니다'; end if;
  select * into l from license where id = 1 for update;
  v_new := (greatest(l.paid_until, (now() at time zone 'Asia/Seoul')::date) + make_interval(months => p_months))::date;
  perform public.set_license(v_new, null, p_memo);
  return v_new;
end $$;

revoke execute on function public.license_ok() from public, anon;
revoke execute on function public.license_status() from public, anon;
revoke execute on function public.set_license(date, int, text) from public, anon;
revoke execute on function public.extend_license(int, text) from public, anon;
grant execute on function public.license_ok() to authenticated, service_role;
grant execute on function public.license_status() to authenticated;
grant execute on function public.set_license(date, int, text) to authenticated;
grant execute on function public.extend_license(int, text) to authenticated;

-- 함수는 로그인한 사용자만 호출
revoke execute on function public.create_product(text, text, integer, text, bigint, text, text) from public, anon;
revoke execute on function public.update_product(bigint, text, text, integer, text, bigint, text, text) from public, anon;
revoke execute on function public.sell_product(bigint, integer, text) from public, anon;
revoke execute on function public.unsell_product(bigint, text) from public, anon;
revoke execute on function public.delete_product(bigint) from public, anon;
revoke execute on function public.suggest_code() from public, anon;
revoke execute on function public.store_summary() from public, anon;
grant execute on function public.create_product(text, text, integer, text, bigint, text, text) to authenticated;
grant execute on function public.update_product(bigint, text, text, integer, text, bigint, text, text) to authenticated;
grant execute on function public.sell_product(bigint, integer, text) to authenticated;
grant execute on function public.unsell_product(bigint, text) to authenticated;
grant execute on function public.delete_product(bigint) to authenticated;
grant execute on function public.suggest_code() to authenticated;
grant execute on function public.store_summary() to authenticated;

-- ---------- 실시간(Realtime): 다른 매장 화면에 바로 반영 ----------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'products') then
    alter publication supabase_realtime add table public.products;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'product_events') then
    alter publication supabase_realtime add table public.product_events;
  end if;
end $$;

-- ---------- 사진 저장소(Storage) ----------
-- public 버킷: 파일명이 무작위라 주소를 모르면 볼 수 없고, CDN 캐시가 되어 빠릅니다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "photos read" on storage.objects;
drop policy if exists "photos upload" on storage.objects;
drop policy if exists "photos delete orphan" on storage.objects;
create policy "photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_active());
create policy "photos upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_active());
-- 어떤 상품에도 연결되지 않은 사진만 지울 수 있음 (수정/삭제 후 정리용)
create policy "photos delete orphan" on storage.objects for delete to authenticated
  using (
    bucket_id = 'photos' and public.is_active()
    and not exists (
      select 1 from public.products p
      where p.photo_path = storage.objects.name or p.thumb_path = storage.objects.name
    )
  );

-- ---------- 기본 매장 ----------
insert into public.stores (name)
select n from (values ('1호점'), ('2호점'), ('3호점')) as v(n)
where not exists (select 1 from public.stores);

-- ---------- API 가 새 테이블/함수를 바로 인식하도록 새로고침 ----------
notify pgrst, 'reload schema';
