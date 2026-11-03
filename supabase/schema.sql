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

-- 계정 삭제 표시 (판매 기록이 있는 계정은 기록용 이름만 남기고 삭제 처리)
alter table public.profiles add column if not exists deleted_at timestamptz;

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

-- ---------- 매장 영수증 정보 ----------
alter table public.stores add column if not exists biz_name       text not null default '';  -- 상호 (비우면 매장 이름)
alter table public.stores add column if not exists biz_no         text not null default '';  -- 사업자등록번호
alter table public.stores add column if not exists owner_name     text not null default '';  -- 대표자
alter table public.stores add column if not exists address        text not null default '';
alter table public.stores add column if not exists phone          text not null default '';
alter table public.stores add column if not exists toss_merchant_id text not null default '';  -- 토스플레이스 연동 준비
-- QR 회원가입용 매장별 비밀 코드 (QR 주소에 들어감, 유출 시 관리자가 새로 발급)
alter table public.stores add column if not exists join_token text not null default replace(gen_random_uuid()::text, '-', '');
create unique index if not exists stores_join_token_key on public.stores (join_token);
alter table public.stores add column if not exists join_poster jsonb not null default '{}'::jsonb;  -- 가입 안내문 디자인 (테마·문구)
alter table public.stores add column if not exists receipt_footer text not null default '빈티지 상품 특성상 교환·환불이 어려울 수 있습니다. 감사합니다.';

-- ---------- 회원 / 포인트 / 쿠폰 (구조만 준비, 화면은 나중에) ----------
create table if not exists public.members (
  id         bigint generated always as identity primary key,
  name       text not null default '',
  phone      text unique,                       -- 숫자만 저장 (01012345678)
  points     integer not null default 0,
  memo       text not null default '',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create table if not exists public.coupons (
  id         bigint generated always as identity primary key,
  code       text not null unique,
  name       text not null,
  kind       text not null check (kind in ('amount', 'percent')),  -- 정액(원) / 정률(%)
  value      integer not null check (value > 0),
  min_total  integer not null default 0,        -- 최소 결제금액
  starts_on  date,
  ends_on    date,
  max_uses   integer,                           -- null = 무제한
  used_count integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- 포인트 설정 (한 줄)
create table if not exists public.app_settings (
  id              int primary key default 1 check (id = 1),
  points_enabled  boolean not null default true,
  point_rate      numeric(5, 2) not null default 1 check (point_rate >= 0 and point_rate <= 100),  -- 결제금액의 % 적립
  point_min_use   integer not null default 1000 check (point_min_use >= 0),                       -- 최소 사용 포인트
  updated_at      timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;
alter table public.app_settings add column if not exists join_points integer not null default 0;   -- 가입 축하 포인트

-- 쿠폰 발급 (회원 계정에 쿠폰 넣어주기)
alter table public.coupons add column if not exists member_only boolean not null default false;  -- true: 발급받은 회원만 사용 (코드 입력 불가)

-- 회원: 가입 경로 / 개인정보·광고 동의
alter table public.members add column if not exists join_source       text not null default 'staff';  -- staff 직원 등록 / qr 손님 직접
alter table public.members add column if not exists join_store_id     bigint references public.stores(id);
alter table public.members add column if not exists privacy_agreed_at timestamptz;                     -- 개인정보 수집·이용 동의 시각
alter table public.members add column if not exists marketing_agreed  boolean not null default false;   -- 광고(문자) 수신 동의
alter table public.members add column if not exists marketing_agreed_at timestamptz;                   -- 수신 동의한 시각 (해제 시 비움)
create index if not exists members_marketing_idx on public.members (marketing_agreed) where marketing_agreed;
create index if not exists members_created_idx on public.members (created_at desc);

-- ---------- 시재 (영업 시작 ~ 마감 현금 관리) ----------
create table if not exists public.cash_sessions (
  id           bigint generated always as identity primary key,
  store_id     bigint not null references public.stores(id),
  status       text not null default 'open' check (status in ('open', 'closed')),
  opened_at    timestamptz not null default now(),
  opened_by    uuid references public.profiles(id),
  opening_cash integer not null default 0,      -- 시작 시재
  closed_at    timestamptz,
  closed_by    uuid references public.profiles(id),
  counted_cash integer,                         -- 마감 때 실제로 센 현금
  expected_cash integer,                        -- 계산상 있어야 할 현금
  difference   integer,                         -- counted - expected (과부족)
  memo         text not null default ''
);
create unique index if not exists cash_sessions_one_open on public.cash_sessions (store_id) where status = 'open';
create table if not exists public.cash_moves (
  id         bigint generated always as identity primary key,
  session_id bigint not null references public.cash_sessions(id) on delete cascade,
  kind       text not null check (kind in ('in', 'out')),   -- 입금(거스름돈 보충 등) / 출금(지출 등)
  amount     integer not null check (amount > 0),
  memo       text not null default '',
  user_id    uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ---------- 영수증(결제) : 한 번 결제에 여러 상품 ----------
create table if not exists public.sales (
  id              bigint generated always as identity primary key,
  receipt_no      text not null unique,                     -- 매장-YYMMDD-순번
  store_id        bigint not null references public.stores(id),
  session_id      bigint references public.cash_sessions(id),
  kind            text not null default 'sale' check (kind in ('sale', 'refund', 'exchange')),  -- 교환/환불용 준비
  original_sale_id bigint references public.sales(id),     -- 교환/환불 시 원래 영수증
  status          text not null default 'completed' check (status in ('completed', 'cancelled')),
  item_count      integer not null default 0,
  subtotal        integer not null default 0,               -- 상품 합계
  discount        integer not null default 0,               -- 추가 할인
  total           integer not null default 0,               -- 결제 금액
  payment         text check (payment in ('cash', 'card', 'transfer', 'mixed')),
  cash_amount     integer not null default 0,
  card_amount     integer not null default 0,
  transfer_amount integer not null default 0,
  received_cash   integer,                                  -- 현금 받은 돈
  change_cash     integer,                                  -- 거스름돈
  refunded_amount integer not null default 0,               -- 부분환불 합계
  member_id       bigint references public.members(id),     -- 회원/포인트/쿠폰 (준비)
  points_used     integer not null default 0,
  points_earned   integer not null default 0,
  coupon_id       bigint references public.coupons(id),
  coupon_discount integer not null default 0,
  memo            text not null default '',
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  cancelled_at    timestamptz,
  cancelled_by    uuid references public.profiles(id),
  cancel_reason   text
);
create index if not exists sales_store_created_idx on public.sales (store_id, created_at desc);
-- 외부 결제(토스플레이스 등) 연동 준비: 단말기 결제번호를 영수증에 연결
alter table public.sales add column if not exists ext_provider   text;   -- 예: 'tossplace'
alter table public.sales add column if not exists ext_payment_id text;   -- 외부 결제 고유번호 (중복 처리 방지)
alter table public.sales add column if not exists ext_order_id   text;
alter table public.sales add column if not exists ext_data       jsonb;  -- 원본 응답 보관
create unique index if not exists sales_ext_payment_key on public.sales (ext_provider, ext_payment_id) where ext_payment_id is not null;
create index if not exists sales_session_idx on public.sales (session_id);

create table if not exists public.sale_items (
  id            bigint generated always as identity primary key,
  sale_id       bigint not null references public.sales(id) on delete cascade,
  product_id    bigint references public.products(id) on delete set null,
  code          text not null,
  name          text not null default '',
  list_price    integer,                                    -- 등록 가격
  price         integer not null default 0,                 -- 실제 판매 가격 (개별 할인 반영)
  status        text not null default 'sold' check (status in ('sold', 'refunded')),
  refunded_at   timestamptz,
  refund_reason text
);
create index if not exists sale_items_sale_idx on public.sale_items (sale_id);
create index if not exists sale_items_product_idx on public.sale_items (product_id);

alter table public.products add column if not exists sale_id bigint references public.sales(id) on delete set null;

create table if not exists public.member_coupons (
  id           bigint generated always as identity primary key,
  coupon_id    bigint not null references public.coupons(id) on delete cascade,
  member_id    bigint not null references public.members(id) on delete cascade,
  status       text not null default 'issued' check (status in ('issued', 'used', 'revoked')),
  issued_at    timestamptz not null default now(),
  issued_by    uuid references public.profiles(id),
  expires_on   date,                                   -- 이 날까지 사용 (한국시간)
  used_at      timestamptz,
  used_sale_id bigint references public.sales(id) on delete set null
);
create index if not exists member_coupons_member_idx on public.member_coupons (member_id, status);
create index if not exists member_coupons_coupon_idx on public.member_coupons (coupon_id);
alter table public.sales add column if not exists member_coupon_id bigint references public.member_coupons(id) on delete set null;

create table if not exists public.point_ledger (
  id         bigint generated always as identity primary key,
  member_id  bigint not null references public.members(id) on delete cascade,
  sale_id    bigint references public.sales(id) on delete set null,
  delta      integer not null,
  reason     text not null default '',
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
alter table public.sales          enable row level security;
alter table public.sale_items     enable row level security;
alter table public.cash_sessions  enable row level security;
alter table public.cash_moves     enable row level security;
alter table public.members        enable row level security;
alter table public.coupons        enable row level security;
alter table public.point_ledger   enable row level security;
alter table public.member_coupons enable row level security;
alter table public.app_settings   enable row level security;

drop policy if exists "stores read"   on public.stores;
drop policy if exists "stores admin"  on public.stores;
drop policy if exists "profiles read" on public.profiles;
drop policy if exists "profiles read own" on public.profiles;
drop policy if exists "license events super" on public.license_events;
drop policy if exists "sales read"        on public.sales;
drop policy if exists "sale items read"   on public.sale_items;
drop policy if exists "cash sessions read" on public.cash_sessions;
drop policy if exists "cash moves read"   on public.cash_moves;
drop policy if exists "members read"      on public.members;
drop policy if exists "coupons read"      on public.coupons;
drop policy if exists "point ledger read" on public.point_ledger;
drop policy if exists "member coupons read" on public.member_coupons;
drop policy if exists "settings read"     on public.app_settings;
drop policy if exists "products read" on public.products;
drop policy if exists "events read"   on public.product_events;

create policy "stores read"   on public.stores         for select to authenticated using (public.is_active());
create policy "stores admin"  on public.stores         for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "profiles read" on public.profiles       for select to authenticated using (public.is_active());
create policy "profiles read own" on public.profiles   for select to authenticated using (id = auth.uid());
create policy "products read" on public.products       for select to authenticated using (public.is_active());
create policy "events read"   on public.product_events for select to authenticated using (public.is_active());
create policy "license events super" on public.license_events for select to authenticated using (public.is_super());
create policy "sales read"         on public.sales         for select to authenticated using (public.is_active());
create policy "sale items read"    on public.sale_items    for select to authenticated using (public.is_active());
create policy "cash sessions read" on public.cash_sessions for select to authenticated using (public.is_active());
create policy "cash moves read"    on public.cash_moves    for select to authenticated using (public.is_active());
create policy "members read"       on public.members       for select to authenticated using (public.is_active());
create policy "coupons read"       on public.coupons       for select to authenticated using (public.is_active());
create policy "point ledger read"  on public.point_ledger  for select to authenticated using (public.is_active());
create policy "member coupons read" on public.member_coupons for select to authenticated using (public.is_active());
create policy "settings read"      on public.app_settings  for select to authenticated using (public.is_active());
-- 매장 영수증 정보(상호 등)는 관리자가 stores 테이블에서 직접 수정 ("stores admin" 정책)
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

-- ---------- 결제 (여러 상품 한 번에) ----------
-- p_items: [{"id": 상품ID, "price": 판매가(생략 시 등록가)}, ...]
-- 상품 행을 잠그고(for update) 확인하므로 두 매장에서 동시에 결제해도 한 곳만 성공합니다.
drop function if exists public.checkout(jsonb, integer, text, integer, text);
drop function if exists public.checkout(jsonb, integer, text, integer, text, jsonb);
drop function if exists public.checkout(jsonb, integer, text, integer, text, jsonb, bigint, integer, text);
-- p_external (선택): 토스플레이스 등 외부 결제 정보 {"provider":"tossplace","payment_id":"...","order_id":"...","data":{...}}
-- p_member_id / p_points_used / p_coupon_code (선택): 회원 적립·포인트 사용·쿠폰
-- 계산 순서: 상품 합계 - 추가 할인 - 쿠폰 할인 - 포인트 사용 = 결제 금액 → 결제 금액의 n% 적립
create or replace function public.checkout(
  p_items jsonb, p_discount integer default 0, p_payment text default null,
  p_received_cash integer default null, p_memo text default '', p_external jsonb default null,
  p_member_id bigint default null, p_points_used integer default 0, p_coupon_code text default null,
  p_member_coupon_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      profiles := current_profile();
  v_ids     bigint[];
  v_p       products;
  v_e       jsonb;
  v_store   bigint;
  v_sname   text;
  v_who     text;
  v_price   integer;
  v_sub     integer := 0;
  v_disc    integer := coalesce(p_discount, 0);
  v_total   integer;
  v_change  integer;
  v_day     text := to_char(now() at time zone 'Asia/Seoul', 'YYMMDD');
  v_seq     integer;
  v_no      text;
  v_session bigint;
  v_sale    bigint;
  v_paylbl  text;
  v_member  members;
  v_coupon  coupons;
  v_mc      member_coupons;
  v_cdisc   integer := 0;
  v_pused   integer := coalesce(p_points_used, 0);
  v_pearn   integer := 0;
  v_set     app_settings;
  v_today   date := (now() at time zone 'Asia/Seoul')::date;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception '결제할 상품이 없습니다';
  end if;
  if jsonb_array_length(p_items) > 200 then raise exception '한 번에 결제할 수 있는 상품은 200개까지입니다'; end if;
  if p_payment is not null and p_payment not in ('cash', 'card', 'transfer') then raise exception '결제수단이 올바르지 않습니다'; end if;
  if v_disc < 0 then raise exception '할인 금액이 올바르지 않습니다'; end if;
  -- 같은 외부 결제가 두 번 들어오면(웹훅 재전송 등) 기존 영수증을 그대로 돌려줌
  if p_external ? 'payment_id' then
    select id, receipt_no, total, change_cash into v_sale, v_no, v_total, v_change
      from sales where ext_provider = p_external->>'provider' and ext_payment_id = p_external->>'payment_id';
    if found then
      return jsonb_build_object('sale_id', v_sale, 'receipt_no', v_no, 'total', v_total, 'change', v_change, 'duplicate', true);
    end if;
  end if;

  select array_agg((e->>'id')::bigint) into v_ids from jsonb_array_elements(p_items) e;
  if (select count(distinct x) from unnest(v_ids) x) <> array_length(v_ids, 1) then
    raise exception '같은 상품이 두 번 담겼습니다';
  end if;

  -- 잠금 (id 순서로 잠가서 교착 방지)
  perform 1 from products where id = any(v_ids) order by id for update;
  if (select count(*) from products where id = any(v_ids)) <> array_length(v_ids, 1) then
    raise exception '찾을 수 없는 상품이 있습니다 (삭제되었을 수 있음)';
  end if;

  for v_e in select * from jsonb_array_elements(p_items) loop
    select * into v_p from products where id = (v_e->>'id')::bigint;
    select name into v_sname from stores where id = v_p.store_id;
    if v_p.status = 'sold' then
      select name into v_who from profiles where id = v_p.sold_by;
      raise exception '이미 판매된 상품입니다: % (%, %, %)', v_p.code, v_sname, coalesce(v_who, '-'),
        to_char(v_p.sold_at at time zone 'Asia/Seoul', 'MM/DD HH24:MI');
    end if;
    if v_me.role not in ('admin', 'super') and v_me.store_id is distinct from v_p.store_id then
      raise exception '이 상품은 % 상품입니다: %. 해당 매장에서만 판매 처리할 수 있습니다', v_sname, v_p.code;
    end if;
    if v_store is null then v_store := v_p.store_id;
    elsif v_store <> v_p.store_id then raise exception '다른 매장 상품은 한 영수증으로 결제할 수 없습니다: %', v_p.code;
    end if;
    v_price := coalesce(nullif(v_e->>'price', '')::integer, v_p.price, 0);
    if v_price < 0 then raise exception '가격이 올바르지 않습니다: %', v_p.code; end if;
    v_sub := v_sub + v_price;
  end loop;

  v_total := v_sub - v_disc;
  if v_total < 0 then raise exception '할인이 상품 합계보다 큽니다'; end if;

  -- 쿠폰: ① 회원에게 발급된 쿠폰  ② 쿠폰 코드 입력
  if p_member_coupon_id is not null then
    select * into v_mc from member_coupons where id = p_member_coupon_id for update;
    if not found or v_mc.status <> 'issued' then raise exception '사용할 수 없는 쿠폰입니다 (이미 사용했거나 회수됨)'; end if;
    if p_member_id is distinct from v_mc.member_id then raise exception '이 회원에게 발급된 쿠폰이 아닙니다'; end if;
    if v_mc.expires_on is not null and v_today > v_mc.expires_on then raise exception '사용 기간이 지난 쿠폰입니다'; end if;
    select * into v_coupon from coupons where id = v_mc.coupon_id for update;
    if not v_coupon.active then raise exception '사용이 중지된 쿠폰입니다'; end if;
    if v_coupon.starts_on is not null and v_today < v_coupon.starts_on then raise exception '아직 사용 기간이 아닌 쿠폰입니다'; end if;
  elsif nullif(trim(coalesce(p_coupon_code, '')), '') is not null then
    select * into v_coupon from coupons where upper(code) = upper(trim(p_coupon_code)) for update;
    if not found then raise exception '없는 쿠폰 코드입니다'; end if;
    if v_coupon.member_only then raise exception '회원 전용 쿠폰입니다. 회원을 선택하고 보유 쿠폰에서 적용하세요'; end if;
    if not v_coupon.active then raise exception '사용이 중지된 쿠폰입니다'; end if;
    if v_coupon.starts_on is not null and v_today < v_coupon.starts_on then raise exception '아직 사용 기간이 아닌 쿠폰입니다'; end if;
    if v_coupon.ends_on is not null and v_today > v_coupon.ends_on then raise exception '사용 기간이 지난 쿠폰입니다'; end if;
    if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then raise exception '사용 횟수가 모두 끝난 쿠폰입니다'; end if;
  end if;
  if v_coupon.id is not null then
    if v_total < v_coupon.min_total then
      raise exception '쿠폰 최소 결제금액(%원) 이상부터 사용할 수 있습니다', to_char(v_coupon.min_total, 'FM999,999,999');
    end if;
    v_cdisc := case when v_coupon.kind = 'amount' then least(v_coupon.value, v_total)
                    else floor(v_total * least(v_coupon.value, 100) / 100.0)::integer end;
    v_total := v_total - v_cdisc;
    update coupons set used_count = used_count + 1 where id = v_coupon.id;
  end if;

  -- 회원 / 포인트
  select * into v_set from app_settings where id = 1;
  if p_member_id is not null then
    select * into v_member from members where id = p_member_id for update;
    if not found then raise exception '회원을 찾을 수 없습니다'; end if;
  end if;
  if v_pused < 0 then raise exception '포인트가 올바르지 않습니다'; end if;
  if v_pused > 0 then
    if v_member.id is null then raise exception '포인트를 쓰려면 회원을 선택하세요'; end if;
    if not coalesce(v_set.points_enabled, true) then raise exception '포인트 사용이 꺼져 있습니다'; end if;
    if v_pused < coalesce(v_set.point_min_use, 0) then
      raise exception '포인트는 %P 이상부터 사용할 수 있습니다', to_char(v_set.point_min_use, 'FM999,999,999');
    end if;
    if v_pused > v_member.points then raise exception '보유 포인트(%P)보다 많이 쓸 수 없습니다', to_char(v_member.points, 'FM999,999,999'); end if;
    if v_pused > v_total then raise exception '포인트는 결제 금액까지만 쓸 수 있습니다'; end if;
    v_total := v_total - v_pused;
  end if;
  if v_member.id is not null and coalesce(v_set.points_enabled, true) then
    v_pearn := floor(v_total * coalesce(v_set.point_rate, 0) / 100.0)::integer;
  end if;
  if p_payment = 'cash' then
    if p_received_cash is not null and p_received_cash < v_total then
      raise exception '받은 금액이 결제 금액보다 적습니다';
    end if;
    v_change := coalesce(p_received_cash, v_total) - v_total;
  end if;

  -- 영수증 번호: 매장-YYMMDD-0001
  perform pg_advisory_xact_lock(hashtext('receipt:' || v_store || ':' || v_day));
  select count(*) + 1 into v_seq from sales where store_id = v_store and receipt_no like v_store || '-' || v_day || '-%';
  v_no := v_store || '-' || v_day || '-' || lpad(v_seq::text, 4, '0');
  select id into v_session from cash_sessions where store_id = v_store and status = 'open';

  insert into sales (receipt_no, store_id, session_id, item_count, subtotal, discount, total, payment,
                     cash_amount, card_amount, transfer_amount, received_cash, change_cash, memo, created_by,
                     ext_provider, ext_payment_id, ext_order_id, ext_data,
                     member_id, points_used, points_earned, coupon_id, coupon_discount, member_coupon_id)
  values (v_no, v_store, v_session, array_length(v_ids, 1), v_sub, v_disc, v_total, p_payment,
          case when p_payment = 'cash' then v_total else 0 end,
          case when p_payment = 'card' then v_total else 0 end,
          case when p_payment = 'transfer' then v_total else 0 end,
          case when p_payment = 'cash' then coalesce(p_received_cash, v_total) end, v_change,
          trim(coalesce(p_memo, '')), v_me.id,
          p_external->>'provider', p_external->>'payment_id', p_external->>'order_id', p_external->'data',
          v_member.id, v_pused, v_pearn, v_coupon.id, v_cdisc, v_mc.id)
  returning id into v_sale;
  if v_mc.id is not null then
    update member_coupons set status = 'used', used_at = now(), used_sale_id = v_sale where id = v_mc.id;
  end if;

  if v_member.id is not null and (v_pused > 0 or v_pearn > 0) then
    update members set points = points - v_pused + v_pearn where id = v_member.id;
    if v_pused > 0 then
      insert into point_ledger (member_id, sale_id, delta, reason, user_id) values (v_member.id, v_sale, -v_pused, '사용 · 영수증 ' || v_no, v_me.id);
    end if;
    if v_pearn > 0 then
      insert into point_ledger (member_id, sale_id, delta, reason, user_id) values (v_member.id, v_sale, v_pearn, '적립 · 영수증 ' || v_no, v_me.id);
    end if;
  end if;

  v_paylbl := case p_payment when 'cash' then '현금' when 'card' then '카드' when 'transfer' then '이체' end;
  for v_e in select * from jsonb_array_elements(p_items) loop
    select * into v_p from products where id = (v_e->>'id')::bigint;
    v_price := coalesce(nullif(v_e->>'price', '')::integer, v_p.price, 0);
    insert into sale_items (sale_id, product_id, code, name, list_price, price)
    values (v_sale, v_p.id, v_p.code, v_p.name, v_p.price, v_price);
    update products set status = 'sold', sold_at = now(), sold_by = v_me.id, sold_store_id = store_id,
           sold_price = v_price, sold_payment = p_payment, sale_id = v_sale, updated_at = now()
     where id = v_p.id;
    insert into product_events (product_id, action, detail, user_id, store_id)
    values (v_p.id, 'sold', concat_ws(' · ', to_char(v_price, 'FM999,999,999') || '원', v_paylbl, '영수증 ' || v_no),
            v_me.id, v_store);
  end loop;

  return jsonb_build_object('sale_id', v_sale, 'receipt_no', v_no, 'total', v_total, 'change', v_change,
                            'points_earned', v_pearn, 'points_used', v_pused, 'coupon_discount', v_cdisc);
end $$;

-- 상품 1개 판매 (상품 상세 화면용) → 영수증 1장으로 처리
drop function if exists public.sell_product(bigint, integer);
create or replace function public.sell_product(p_id bigint, p_sold_price integer default null, p_payment text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.checkout(p_items => jsonb_build_array(jsonb_build_object('id', p_id, 'price', p_sold_price)), p_payment => p_payment);
end $$;

-- ---------- 영수증 취소 (전체) ----------
create or replace function public.cancel_sale(p_sale_id bigint, p_reason text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me profiles := current_profile();
  v_s  sales;
  v_i  sale_items;
begin
  select * into v_s from sales where id = p_sale_id for update;
  if not found then raise exception '영수증을 찾을 수 없습니다'; end if;
  if v_s.status = 'cancelled' then raise exception '이미 취소된 영수증입니다'; end if;
  if v_me.role not in ('admin', 'super') and v_me.store_id is distinct from v_s.store_id then
    raise exception '판매한 매장 또는 관리자만 취소할 수 있습니다';
  end if;
  if v_me.role = 'cashier' and (v_s.created_by is distinct from v_me.id
      or (v_s.created_at at time zone 'Asia/Seoul')::date <> (now() at time zone 'Asia/Seoul')::date) then
    raise exception '캐셔는 본인이 오늘 판매한 건만 취소할 수 있습니다. 실장에게 요청하세요';
  end if;

  perform 1 from products where sale_id = p_sale_id order by id for update;
  update sales set status = 'cancelled', cancelled_at = now(), cancelled_by = v_me.id,
         cancel_reason = trim(coalesce(p_reason, ''))
   where id = p_sale_id;
  -- 포인트: 사용한 것은 돌려주고, 적립한 것은 회수 / 쿠폰: 사용 횟수 되돌림
  if v_s.member_id is not null and (v_s.points_used > 0 or v_s.points_earned > 0) then
    update members set points = points + v_s.points_used - v_s.points_earned where id = v_s.member_id;
    if v_s.points_used > 0 then
      insert into point_ledger (member_id, sale_id, delta, reason, user_id) values (v_s.member_id, p_sale_id, v_s.points_used, '사용 취소 · 영수증 ' || v_s.receipt_no, v_me.id);
    end if;
    if v_s.points_earned > 0 then
      insert into point_ledger (member_id, sale_id, delta, reason, user_id) values (v_s.member_id, p_sale_id, -v_s.points_earned, '적립 취소 · 영수증 ' || v_s.receipt_no, v_me.id);
    end if;
  end if;
  if v_s.coupon_id is not null then
    update coupons set used_count = greatest(0, used_count - 1) where id = v_s.coupon_id;
  end if;
  if v_s.member_coupon_id is not null then
    update member_coupons set status = 'issued', used_at = null, used_sale_id = null
     where id = v_s.member_coupon_id and used_sale_id = p_sale_id;
  end if;
  for v_i in select * from sale_items where sale_id = p_sale_id and status = 'sold' and product_id is not null loop
    update products set status = 'available', sold_at = null, sold_by = null, sold_store_id = null,
           sold_price = null, sold_payment = null, sale_id = null, updated_at = now()
     where id = v_i.product_id and sale_id = p_sale_id;
    insert into product_events (product_id, action, detail, user_id, store_id)
    values (v_i.product_id, 'unsold',
            concat_ws(' · ', '영수증 ' || v_s.receipt_no || ' 취소', nullif(trim(coalesce(p_reason, '')), '')),
            v_me.id, v_s.store_id);
  end loop;
end $$;

-- ---------- 판매 취소 (상품 상세 화면) ----------
-- 혼자 결제된 상품이면 그 영수증을 취소. 여러 상품과 함께 결제된 경우 영수증 전체 취소를 안내.
create or replace function public.unsell_product(p_id bigint, p_reason text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me profiles := current_profile();
  v_p  products;
  v_no text;
begin
  select * into v_p from products where id = p_id;
  if not found then raise exception '상품을 찾을 수 없습니다'; end if;
  if v_p.status <> 'sold' then raise exception '판매완료 상태가 아닙니다'; end if;
  if v_p.sale_id is not null then
    if (select count(*) from sale_items where sale_id = v_p.sale_id and status = 'sold') > 1 then
      select receipt_no into v_no from sales where id = v_p.sale_id;
      raise exception '여러 상품을 함께 결제한 영수증(%)입니다. 정산 화면에서 영수증을 취소하세요', v_no;
    end if;
    perform public.cancel_sale(v_p.sale_id, p_reason);
    return;
  end if;
  -- (영수증 없이 판매된 예전 기록)
  if v_me.role not in ('admin', 'super') and v_me.store_id is distinct from v_p.store_id then
    raise exception '판매한 매장 또는 관리자만 취소할 수 있습니다';
  end if;
  if v_me.role = 'cashier' then raise exception '캐셔는 본인이 오늘 판매한 건만 취소할 수 있습니다. 실장에게 요청하세요'; end if;
  update products set status = 'available', sold_at = null, sold_by = null, sold_store_id = null,
         sold_price = null, sold_payment = null, updated_at = now()
   where id = p_id;
  insert into product_events (product_id, action, detail, user_id, store_id)
  values (p_id, 'unsold', trim(coalesce(p_reason, '')), v_me.id, v_p.store_id);
end $$;

-- ---------- 회원 ----------
-- 등록/수정: 직원 누구나 (계산대에서 바로 가입). 전화번호는 숫자만 저장
drop function if exists public.save_member(bigint, text, text, text);
-- p_marketing: null = 그대로, true = 문자 수신 동의(고객에게 받은 경우), false = 수신 거부
create or replace function public.save_member(p_id bigint, p_name text, p_phone text, p_memo text default '', p_marketing boolean default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_me    profiles := current_profile();
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_id    bigint;
begin
  if length(v_phone) < 9 or length(v_phone) > 12 then raise exception '전화번호를 정확히 입력하세요'; end if;
  if exists (select 1 from members where phone = v_phone and id is distinct from p_id) then
    raise exception '이미 등록된 전화번호입니다';
  end if;
  if p_id is null then
    insert into members (name, phone, memo, created_by, marketing_agreed, marketing_agreed_at)
    values (trim(coalesce(p_name, '')), v_phone, trim(coalesce(p_memo, '')), v_me.id,
            coalesce(p_marketing, false), case when p_marketing then now() end)
    returning id into v_id;
  else
    if v_me.role = 'cashier' then raise exception '캐셔 계정은 회원 정보를 수정할 수 없습니다'; end if;
    update members set name = trim(coalesce(p_name, '')), phone = v_phone, memo = trim(coalesce(p_memo, '')),
           marketing_agreed = coalesce(p_marketing, marketing_agreed),
           marketing_agreed_at = case
             when p_marketing is null then marketing_agreed_at
             when p_marketing and not marketing_agreed then now()
             when p_marketing then marketing_agreed_at
             else null end
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception '회원을 찾을 수 없습니다'; end if;
  end if;
  return v_id;
end $$;

-- 포인트 직접 조정 (관리자/실장)
create or replace function public.adjust_points(p_member_id bigint, p_delta integer, p_reason text)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_me profiles := current_profile();
  v_m  members;
begin
  if v_me.role not in ('admin', 'super', 'manager') then raise exception '관리자/실장만 포인트를 조정할 수 있습니다'; end if;
  if coalesce(p_delta, 0) = 0 then raise exception '조정할 포인트를 입력하세요'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception '조정 사유를 입력하세요'; end if;
  select * into v_m from members where id = p_member_id for update;
  if not found then raise exception '회원을 찾을 수 없습니다'; end if;
  if v_m.points + p_delta < 0 then raise exception '포인트가 0보다 작아질 수 없습니다'; end if;
  update members set points = points + p_delta where id = p_member_id;
  insert into point_ledger (member_id, delta, reason, user_id) values (p_member_id, p_delta, '조정 · ' || trim(p_reason), v_me.id);
  return v_m.points + p_delta;
end $$;

-- 회원 삭제 (관리자). 구매 기록은 남고 회원 연결만 끊김
create or replace function public.delete_member(p_member_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare v_me profiles := current_profile();
begin
  if v_me.role not in ('admin', 'super') then raise exception '관리자만 회원을 삭제할 수 있습니다'; end if;
  update sales set member_id = null where member_id = p_member_id;
  delete from members where id = p_member_id;
end $$;

-- ---------- 쿠폰 ----------
drop function if exists public.save_coupon(bigint, text, text, text, integer, integer, date, date, integer, boolean);
create or replace function public.save_coupon(
  p_id bigint, p_code text, p_name text, p_kind text, p_value integer, p_min_total integer default 0,
  p_starts_on date default null, p_ends_on date default null, p_max_uses integer default null, p_active boolean default true,
  p_member_only boolean default false
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_me   profiles := current_profile();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_id   bigint;
begin
  if v_me.role not in ('admin', 'super') then raise exception '관리자만 쿠폰을 관리할 수 있습니다'; end if;
  if v_code = '' then raise exception '쿠폰 코드를 입력하세요'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception '쿠폰 이름을 입력하세요'; end if;
  if p_kind not in ('amount', 'percent') then raise exception '할인 방식을 선택하세요'; end if;
  if coalesce(p_value, 0) <= 0 or (p_kind = 'percent' and p_value > 100) then raise exception '할인 값이 올바르지 않습니다'; end if;
  if p_starts_on is not null and p_ends_on is not null and p_ends_on < p_starts_on then raise exception '기간이 올바르지 않습니다'; end if;
  if exists (select 1 from coupons where upper(code) = v_code and id is distinct from p_id) then raise exception '이미 있는 쿠폰 코드입니다'; end if;
  if p_id is null then
    insert into coupons (code, name, kind, value, min_total, starts_on, ends_on, max_uses, active, member_only)
    values (v_code, trim(p_name), p_kind, p_value, coalesce(p_min_total, 0), p_starts_on, p_ends_on, p_max_uses, coalesce(p_active, true),
            coalesce(p_member_only, false))
    returning id into v_id;
  else
    update coupons set code = v_code, name = trim(p_name), kind = p_kind, value = p_value, min_total = coalesce(p_min_total, 0),
           starts_on = p_starts_on, ends_on = p_ends_on, max_uses = p_max_uses, active = coalesce(p_active, true),
           member_only = coalesce(p_member_only, false)
     where id = p_id returning id into v_id;
    if v_id is null then raise exception '쿠폰을 찾을 수 없습니다'; end if;
  end if;
  return v_id;
end $$;

-- 계산대에서 쿠폰 미리 확인 (실제 차감은 checkout 에서 다시 검사)
create or replace function public.coupon_quote(p_code text, p_amount integer)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me    profiles := current_profile();
  v_c     coupons;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
begin
  select * into v_c from coupons where upper(code) = upper(trim(coalesce(p_code, '')));
  if not found then raise exception '없는 쿠폰 코드입니다'; end if;
  if v_c.member_only then raise exception '회원 전용 쿠폰입니다. 회원을 선택하고 보유 쿠폰에서 적용하세요'; end if;
  if not v_c.active then raise exception '사용이 중지된 쿠폰입니다'; end if;
  if v_c.starts_on is not null and v_today < v_c.starts_on then raise exception '아직 사용 기간이 아닌 쿠폰입니다'; end if;
  if v_c.ends_on is not null and v_today > v_c.ends_on then raise exception '사용 기간이 지난 쿠폰입니다'; end if;
  if v_c.max_uses is not null and v_c.used_count >= v_c.max_uses then raise exception '사용 횟수가 모두 끝난 쿠폰입니다'; end if;
  return jsonb_build_object('id', v_c.id, 'code', v_c.code, 'name', v_c.name, 'kind', v_c.kind, 'value', v_c.value, 'min_total', v_c.min_total,
    'discount', case when coalesce(p_amount, 0) < v_c.min_total then 0
                     when v_c.kind = 'amount' then least(v_c.value, coalesce(p_amount, 0))
                     else floor(coalesce(p_amount, 0) * v_c.value / 100.0)::integer end);
end $$;

-- 쿠폰 발급 (관리자): p_target = 'marketing'(문자 수신 동의 회원) / 'all'(전체 회원) / 'selected'(p_member_ids)
-- 같은 쿠폰을 아직 안 쓰고 갖고 있는 회원은 건너뜀
create or replace function public.issue_coupons(p_coupon_id bigint, p_target text, p_member_ids bigint[] default null, p_expires_on date default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     profiles := current_profile();
  v_c      coupons;
  v_exp    date;
  v_issued integer;
  v_target integer;
begin
  if v_me.role not in ('admin', 'super') then raise exception '관리자만 쿠폰을 발급할 수 있습니다'; end if;
  select * into v_c from coupons where id = p_coupon_id;
  if not found then raise exception '쿠폰을 찾을 수 없습니다'; end if;
  if not v_c.active then raise exception '사용이 중지된 쿠폰은 발급할 수 없습니다'; end if;
  if p_target not in ('marketing', 'all', 'selected') then raise exception '발급 대상을 선택하세요'; end if;
  v_exp := coalesce(p_expires_on, v_c.ends_on);
  if v_exp is not null and v_exp < (now() at time zone 'Asia/Seoul')::date then raise exception '유효기간이 이미 지났습니다'; end if;

  create temp table _targets on commit drop as
    select m.id from members m
     where (p_target = 'all')
        or (p_target = 'marketing' and m.marketing_agreed)
        or (p_target = 'selected' and m.id = any(coalesce(p_member_ids, '{}')));
  select count(*) into v_target from _targets;
  insert into member_coupons (coupon_id, member_id, issued_by, expires_on)
  select p_coupon_id, t.id, v_me.id, v_exp from _targets t
   where not exists (select 1 from member_coupons mc where mc.coupon_id = p_coupon_id and mc.member_id = t.id and mc.status = 'issued');
  get diagnostics v_issued = row_count;
  return jsonb_build_object('issued', v_issued, 'skipped', v_target - v_issued, 'expires_on', v_exp);
end $$;

-- 발급한 쿠폰 회수 (관리자)
create or replace function public.revoke_member_coupon(p_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare v_me profiles := current_profile();
begin
  if v_me.role not in ('admin', 'super') then raise exception '관리자만 쿠폰을 회수할 수 있습니다'; end if;
  update member_coupons set status = 'revoked' where id = p_id and status = 'issued';
  if not found then raise exception '회수할 수 있는 쿠폰이 아닙니다'; end if;
end $$;

-- 포인트 설정 (관리자)
drop function if exists public.set_point_settings(boolean, numeric, integer);
create or replace function public.set_point_settings(p_enabled boolean, p_rate numeric, p_min_use integer, p_join_points integer default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_me profiles := current_profile();
begin
  if v_me.role not in ('admin', 'super') then raise exception '관리자만 포인트 설정을 바꿀 수 있습니다'; end if;
  if p_rate is null or p_rate < 0 or p_rate > 100 then raise exception '적립률은 0~100%% 사이로 입력하세요'; end if;
  if p_min_use is null or p_min_use < 0 then raise exception '최소 사용 포인트가 올바르지 않습니다'; end if;
  if p_join_points is not null and (p_join_points < 0 or p_join_points > 1000000) then raise exception '가입 축하 포인트가 올바르지 않습니다'; end if;
  update app_settings set points_enabled = coalesce(p_enabled, true), point_rate = p_rate, point_min_use = p_min_use,
         join_points = coalesce(p_join_points, join_points), updated_at = now() where id = 1;
end $$;

-- ---------- QR 회원가입 (손님 직접, 로그인 없이) ----------
-- 가입 페이지가 매장 이름/축하 포인트를 보여주기 위한 조회. 비밀 코드가 맞아야만 응답
create or replace function public.join_info(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_s   stores;
  v_set app_settings;
begin
  select * into v_s from stores where join_token = coalesce(p_token, '') and length(coalesce(p_token, '')) >= 16;
  if not found then raise exception '잘못된 가입 QR입니다. 매장에 문의해 주세요'; end if;
  select * into v_set from app_settings where id = 1;
  return jsonb_build_object('store_name', coalesce(nullif(v_s.biz_name, ''), v_s.name),
                            'join_points', case when coalesce(v_set.points_enabled, true) then coalesce(v_set.join_points, 0) else 0 end,
                            'point_rate', case when coalesce(v_set.points_enabled, true) then v_set.point_rate else 0 end);
end $$;

create or replace function public.public_join(p_token text, p_name text, p_phone text, p_privacy boolean, p_marketing boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_s     stores;
  v_set   app_settings;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_name  text := left(trim(coalesce(p_name, '')), 30);
  v_id    bigint;
  v_pts   integer := 0;
begin
  select * into v_s from stores where join_token = coalesce(p_token, '') and length(coalesce(p_token, '')) >= 16;
  if not found then raise exception '잘못된 가입 QR입니다. 매장에 문의해 주세요'; end if;
  if not coalesce(p_privacy, false) then raise exception '개인정보 수집·이용에 동의해야 가입할 수 있습니다'; end if;
  if v_phone !~ '^01[016789][0-9]{7,8}$' then raise exception '휴대폰 번호를 정확히 입력해 주세요'; end if;
  if v_name = '' then raise exception '이름을 입력해 주세요'; end if;
  -- 이미 가입한 번호면 정보를 알려주지 않고 '이미 가입됨'만 응답
  if exists (select 1 from members where phone = v_phone) then
    return jsonb_build_object('status', 'exists');
  end if;
  -- 장난 가입 방지: 매장별 최근 10분 QR 가입 30건 초과 시 잠시 중지
  if (select count(*) from members where join_store_id = v_s.id and join_source = 'qr' and created_at > now() - interval '10 minutes') >= 30 then
    raise exception '가입 요청이 많습니다. 잠시 후 다시 시도해 주세요';
  end if;
  select * into v_set from app_settings where id = 1;
  if coalesce(v_set.points_enabled, true) then v_pts := coalesce(v_set.join_points, 0); end if;
  insert into members (name, phone, points, join_source, join_store_id, privacy_agreed_at, marketing_agreed, marketing_agreed_at)
  values (v_name, v_phone, v_pts, 'qr', v_s.id, now(), coalesce(p_marketing, false), case when p_marketing then now() end)
  on conflict (phone) do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('status', 'exists'); end if;
  if v_pts > 0 then
    insert into point_ledger (member_id, delta, reason) values (v_id, v_pts, '가입 축하 (QR 가입)');
  end if;
  return jsonb_build_object('status', 'joined', 'points', v_pts, 'store_name', coalesce(nullif(v_s.biz_name, ''), v_s.name));
end $$;

-- QR 새로 발급 (기존 QR 은 더 이상 사용 불가)
create or replace function public.rotate_join_token(p_store_id bigint)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_me profiles := current_profile();
  v_t  text := replace(gen_random_uuid()::text, '-', '');
begin
  if v_me.role not in ('admin', 'super') then raise exception '관리자만 QR을 새로 만들 수 있습니다'; end if;
  update stores set join_token = v_t where id = p_store_id;
  if not found then raise exception '매장을 찾을 수 없습니다'; end if;
  return v_t;
end $$;

-- ---------- 부분환불 (준비: 화면 없음, 관리자/실장용) ----------
-- 영수증 중 일부 상품만 환불 → 상품은 판매중으로, 영수증 refunded_amount 증가
-- 교환 = 부분환불 + 새 결제(checkout) 로 처리
create or replace function public.refund_sale_items(p_sale_id bigint, p_item_ids bigint[], p_reason text default '')
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_me  profiles := current_profile();
  v_s   sales;
  v_i   sale_items;
  v_sum integer := 0;
begin
  if v_me.role = 'cashier' then raise exception '캐셔 계정은 환불할 수 없습니다'; end if;
  select * into v_s from sales where id = p_sale_id for update;
  if not found or v_s.status <> 'completed' then raise exception '환불할 수 있는 영수증이 아닙니다'; end if;
  if v_me.role not in ('admin', 'super') and v_me.store_id is distinct from v_s.store_id then
    raise exception '판매한 매장 또는 관리자만 환불할 수 있습니다';
  end if;
  for v_i in select * from sale_items where sale_id = p_sale_id and id = any(p_item_ids) and status = 'sold' for update loop
    update sale_items set status = 'refunded', refunded_at = now(), refund_reason = trim(coalesce(p_reason, '')) where id = v_i.id;
    if v_i.product_id is not null then
      update products set status = 'available', sold_at = null, sold_by = null, sold_store_id = null,
             sold_price = null, sold_payment = null, sale_id = null, updated_at = now()
       where id = v_i.product_id and sale_id = p_sale_id;
      insert into product_events (product_id, action, detail, user_id, store_id)
      values (v_i.product_id, 'unsold', concat_ws(' · ', '부분환불 ' || v_s.receipt_no, nullif(trim(coalesce(p_reason, '')), '')),
              v_me.id, v_s.store_id);
    end if;
    v_sum := v_sum + v_i.price;
  end loop;
  if v_sum = 0 then raise exception '환불할 상품을 선택하세요'; end if;
  v_sum := least(v_sum, v_s.total - v_s.refunded_amount);
  update sales set refunded_amount = refunded_amount + v_sum where id = p_sale_id;
  return v_sum;
end $$;

-- ---------- 시재 ----------
-- 예상 현금 = 시작 시재 + 현금 매출(취소 제외, 현금 환불 차감) + 입금 - 출금
create or replace function public.cash_expected(p_session_id bigint) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select opening_cash from cash_sessions where id = p_session_id), 0)
       + coalesce((select sum(cash_amount - case when payment = 'cash' then refunded_amount else 0 end)
                     from sales where session_id = p_session_id and status = 'completed'), 0)
       + coalesce((select sum(case when kind = 'in' then amount else -amount end)
                     from cash_moves where session_id = p_session_id), 0);
$$;

create or replace function public.cash_status(p_store_id bigint default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me    profiles := current_profile();
  v_store bigint := case when v_me.role in ('admin', 'super') then coalesce(p_store_id, v_me.store_id) else v_me.store_id end;
  v_s     cash_sessions;
begin
  if v_store is null then return null; end if;
  select * into v_s from cash_sessions where store_id = v_store and status = 'open';
  if not found then return jsonb_build_object('store_id', v_store, 'open', false); end if;
  return jsonb_build_object(
    'store_id', v_store, 'open', true, 'session_id', v_s.id, 'opened_at', v_s.opened_at,
    'opened_by', v_s.opened_by, 'opening_cash', v_s.opening_cash,
    'cash_sales', coalesce((select sum(cash_amount - case when payment = 'cash' then refunded_amount else 0 end)
                              from sales where session_id = v_s.id and status = 'completed'), 0),
    'moves_in',  coalesce((select sum(amount) from cash_moves where session_id = v_s.id and kind = 'in'), 0),
    'moves_out', coalesce((select sum(amount) from cash_moves where session_id = v_s.id and kind = 'out'), 0),
    'expected', public.cash_expected(v_s.id));
end $$;

create or replace function public.open_cash(p_store_id bigint, p_opening integer, p_memo text default '')
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_me    profiles := current_profile();
  v_store bigint := case when v_me.role in ('admin', 'super') then coalesce(p_store_id, v_me.store_id) else v_me.store_id end;
  v_id    bigint;
begin
  if v_store is null or not exists (select 1 from stores where id = v_store) then raise exception '매장을 선택하세요'; end if;
  if coalesce(p_opening, 0) < 0 then raise exception '시작 시재가 올바르지 않습니다'; end if;
  if exists (select 1 from cash_sessions where store_id = v_store and status = 'open') then
    raise exception '이미 영업이 시작되었습니다. 먼저 마감하세요';
  end if;
  insert into cash_sessions (store_id, opened_by, opening_cash, memo)
  values (v_store, v_me.id, coalesce(p_opening, 0), trim(coalesce(p_memo, '')))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.cash_move(p_session_id bigint, p_kind text, p_amount integer, p_memo text default '')
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me profiles := current_profile();
  v_s  cash_sessions;
begin
  select * into v_s from cash_sessions where id = p_session_id;
  if not found or v_s.status <> 'open' then raise exception '영업 중인 시재가 아닙니다'; end if;
  if v_me.role not in ('admin', 'super') and v_me.store_id is distinct from v_s.store_id then raise exception '다른 매장 시재입니다'; end if;
  if p_kind not in ('in', 'out') then raise exception '입금/출금을 선택하세요'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception '금액을 입력하세요'; end if;
  insert into cash_moves (session_id, kind, amount, memo, user_id) values (p_session_id, p_kind, p_amount, trim(coalesce(p_memo, '')), v_me.id);
end $$;

create or replace function public.close_cash(p_session_id bigint, p_counted integer, p_memo text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me  profiles := current_profile();
  v_s   cash_sessions;
  v_exp integer;
begin
  select * into v_s from cash_sessions where id = p_session_id for update;
  if not found or v_s.status <> 'open' then raise exception '영업 중인 시재가 아닙니다'; end if;
  if v_me.role not in ('admin', 'super') and v_me.store_id is distinct from v_s.store_id then raise exception '다른 매장 시재입니다'; end if;
  if p_counted is null or p_counted < 0 then raise exception '실제 현금을 입력하세요'; end if;
  v_exp := public.cash_expected(p_session_id);
  update cash_sessions set status = 'closed', closed_at = now(), closed_by = v_me.id, counted_cash = p_counted,
         expected_cash = v_exp, difference = p_counted - v_exp,
         memo = trim(concat_ws(' / ', nullif(memo, ''), nullif(trim(coalesce(p_memo, '')), '')))
   where id = p_session_id;
  return jsonb_build_object('expected', v_exp, 'counted', p_counted, 'difference', p_counted - v_exp);
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

-- ---------- 계정에 남은 기록이 있는지 (계정 삭제 Edge Function 전용) ----------
create or replace function public.profile_in_use(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from products where created_by = p_id or sold_by = p_id)
      or exists (select 1 from product_events where user_id = p_id)
      or exists (select 1 from sales where created_by = p_id or cancelled_by = p_id)
      or exists (select 1 from cash_sessions where opened_by = p_id or closed_by = p_id)
      or exists (select 1 from cash_moves where user_id = p_id)
      or exists (select 1 from license where updated_by = p_id)
      or exists (select 1 from license_events where user_id = p_id)
      or exists (select 1 from members where created_by = p_id)
      or exists (select 1 from point_ledger where user_id = p_id);
$$;
revoke execute on function public.profile_in_use(uuid) from public, anon, authenticated;
grant execute on function public.profile_in_use(uuid) to service_role;

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
revoke execute on function public.checkout(jsonb, integer, text, integer, text, jsonb, bigint, integer, text, bigint) from public, anon;
revoke execute on function public.save_member(bigint, text, text, text, boolean) from public, anon;
revoke execute on function public.adjust_points(bigint, integer, text) from public, anon;
revoke execute on function public.delete_member(bigint) from public, anon;
revoke execute on function public.save_coupon(bigint, text, text, text, integer, integer, date, date, integer, boolean, boolean) from public, anon;
revoke execute on function public.coupon_quote(text, integer) from public, anon;
revoke execute on function public.set_point_settings(boolean, numeric, integer, integer) from public, anon;
revoke execute on function public.join_info(text) from public;
revoke execute on function public.public_join(text, text, text, boolean, boolean) from public;
revoke execute on function public.rotate_join_token(bigint) from public, anon;
revoke execute on function public.issue_coupons(bigint, text, bigint[], date) from public, anon;
revoke execute on function public.revoke_member_coupon(bigint) from public, anon;
revoke execute on function public.cancel_sale(bigint, text) from public, anon;
revoke execute on function public.refund_sale_items(bigint, bigint[], text) from public, anon;
revoke execute on function public.cash_expected(bigint) from public, anon;
revoke execute on function public.cash_status(bigint) from public, anon;
revoke execute on function public.open_cash(bigint, integer, text) from public, anon;
revoke execute on function public.cash_move(bigint, text, integer, text) from public, anon;
revoke execute on function public.close_cash(bigint, integer, text) from public, anon;
revoke execute on function public.unsell_product(bigint, text) from public, anon;
revoke execute on function public.delete_product(bigint) from public, anon;
revoke execute on function public.suggest_code() from public, anon;
revoke execute on function public.store_summary() from public, anon;
grant execute on function public.create_product(text, text, integer, text, bigint, text, text) to authenticated;
grant execute on function public.update_product(bigint, text, text, integer, text, bigint, text, text) to authenticated;
grant execute on function public.sell_product(bigint, integer, text) to authenticated;
grant execute on function public.checkout(jsonb, integer, text, integer, text, jsonb, bigint, integer, text, bigint) to authenticated;
grant execute on function public.save_member(bigint, text, text, text, boolean) to authenticated;
grant execute on function public.adjust_points(bigint, integer, text) to authenticated;
grant execute on function public.delete_member(bigint) to authenticated;
grant execute on function public.save_coupon(bigint, text, text, text, integer, integer, date, date, integer, boolean, boolean) to authenticated;
grant execute on function public.coupon_quote(text, integer) to authenticated;
grant execute on function public.set_point_settings(boolean, numeric, integer, integer) to authenticated;
grant execute on function public.join_info(text) to anon, authenticated;            -- 로그인 없이 가입 페이지에서 호출
grant execute on function public.public_join(text, text, text, boolean, boolean) to anon, authenticated;
grant execute on function public.rotate_join_token(bigint) to authenticated;
grant execute on function public.issue_coupons(bigint, text, bigint[], date) to authenticated;
grant execute on function public.revoke_member_coupon(bigint) to authenticated;
grant execute on function public.cancel_sale(bigint, text) to authenticated;
grant execute on function public.refund_sale_items(bigint, bigint[], text) to authenticated;
grant execute on function public.cash_expected(bigint) to authenticated;
grant execute on function public.cash_status(bigint) to authenticated;
grant execute on function public.open_cash(bigint, integer, text) to authenticated;
grant execute on function public.cash_move(bigint, text, integer, text) to authenticated;
grant execute on function public.close_cash(bigint, integer, text) to authenticated;
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
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'sales') then
    alter publication supabase_realtime add table public.sales;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'cash_sessions') then
    alter publication supabase_realtime add table public.cash_sessions;
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

-- ---------- 영수증 기능 이전에 판매된 기록을 영수증으로 변환 (한 번만, 여러 번 실행해도 안전) ----------
do $$
declare r record; v_id bigint;
begin
  for r in select * from public.products where status = 'sold' and sale_id is null loop
    insert into public.sales (receipt_no, store_id, item_count, subtotal, total, payment,
                              cash_amount, card_amount, transfer_amount, created_by, created_at)
    values ('OLD-' || r.id, coalesce(r.sold_store_id, r.store_id), 1, coalesce(r.sold_price, 0), coalesce(r.sold_price, 0), r.sold_payment,
            case when r.sold_payment = 'cash' then coalesce(r.sold_price, 0) else 0 end,
            case when r.sold_payment = 'card' then coalesce(r.sold_price, 0) else 0 end,
            case when r.sold_payment = 'transfer' then coalesce(r.sold_price, 0) else 0 end,
            r.sold_by, coalesce(r.sold_at, now()))
    on conflict (receipt_no) do nothing
    returning id into v_id;
    if v_id is not null then
      insert into public.sale_items (sale_id, product_id, code, name, list_price, price)
      values (v_id, r.id, r.code, r.name, r.price, coalesce(r.sold_price, 0));
      update public.products set sale_id = v_id where id = r.id;
    end if;
  end loop;
end $$;

-- 동의일이 비어 있는 기존 동의 회원은 가입일로 채움
update public.members set marketing_agreed_at = created_at where marketing_agreed and marketing_agreed_at is null;

-- ---------- API 가 새 테이블/함수를 바로 인식하도록 새로고침 ----------
notify pgrst, 'reload schema';
