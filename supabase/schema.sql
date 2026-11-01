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
  role       text not null check (role in ('admin', 'manager')),
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

-- ---------- 권한 헬퍼 ----------
create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin');
$$;

create or replace function public.current_profile() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare v profiles;
begin
  select * into v from profiles where id = auth.uid() and active;
  if not found then
    raise exception '로그인이 필요하거나 비활성화된 계정입니다' using errcode = '28000';
  end if;
  return v;
end $$;

-- ---------- RLS: 로그인한(활성) 직원은 모두 조회 가능, 변경은 아래 함수로만 ----------
alter table public.stores         enable row level security;
alter table public.profiles       enable row level security;
alter table public.products       enable row level security;
alter table public.product_events enable row level security;

drop policy if exists "stores read"   on public.stores;
drop policy if exists "stores admin"  on public.stores;
drop policy if exists "profiles read" on public.profiles;
drop policy if exists "products read" on public.products;
drop policy if exists "events read"   on public.product_events;

create policy "stores read"   on public.stores         for select to authenticated using (public.is_active());
create policy "stores admin"  on public.stores         for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "profiles read" on public.profiles       for select to authenticated using (public.is_active());
create policy "products read" on public.products       for select to authenticated using (public.is_active());
create policy "events read"   on public.product_events for select to authenticated using (public.is_active());
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
  if v_code = '' then raise exception '상품코드를 입력하세요'; end if;
  if length(v_code) > 40 then raise exception '상품코드가 너무 깁니다'; end if;
  v_store := case when v_me.role = 'admin' then p_store_id else v_me.store_id end;
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
  select * into v_p from products where id = p_id for update;
  if not found then raise exception '상품을 찾을 수 없습니다'; end if;
  if v_me.role <> 'admin' and v_me.store_id is distinct from v_p.store_id then
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
create or replace function public.sell_product(p_id bigint, p_sold_price integer default null)
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
  if v_me.role <> 'admin' and v_me.store_id is distinct from v_p.store_id then
    raise exception '이 상품은 % 상품입니다. 해당 매장에서만 판매 처리할 수 있습니다', v_store;
  end if;
  v_price := coalesce(p_sold_price, v_p.price);
  update products set status = 'sold', sold_at = now(), sold_by = v_me.id,
         sold_store_id = store_id, sold_price = v_price, updated_at = now()
   where id = p_id;
  insert into product_events (product_id, action, detail, user_id, store_id)
  values (p_id, 'sold', case when v_price is null then '' else to_char(v_price, 'FM999,999,999') || '원' end,
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
  if v_me.role <> 'admin' and v_me.store_id is distinct from v_p.store_id then
    raise exception '판매한 매장 또는 관리자만 취소할 수 있습니다';
  end if;
  update products set status = 'available', sold_at = null, sold_by = null,
         sold_store_id = null, sold_price = null, updated_at = now()
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
  if v_me.role <> 'admin' then raise exception '관리자만 삭제할 수 있습니다'; end if;
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

-- 함수는 로그인한 사용자만 호출
revoke execute on function public.create_product(text, text, integer, text, bigint, text, text) from public, anon;
revoke execute on function public.update_product(bigint, text, text, integer, text, bigint, text, text) from public, anon;
revoke execute on function public.sell_product(bigint, integer) from public, anon;
revoke execute on function public.unsell_product(bigint, text) from public, anon;
revoke execute on function public.delete_product(bigint) from public, anon;
revoke execute on function public.suggest_code() from public, anon;
revoke execute on function public.store_summary() from public, anon;
grant execute on function public.create_product(text, text, integer, text, bigint, text, text) to authenticated;
grant execute on function public.update_product(bigint, text, text, integer, text, bigint, text, text) to authenticated;
grant execute on function public.sell_product(bigint, integer) to authenticated;
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
