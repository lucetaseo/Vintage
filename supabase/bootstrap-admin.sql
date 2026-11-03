-- =====================================================================
-- 총관리자(개발자) 지정 / 수동 관리자 연결
-- 총관리자는 앱 안에서 만들 수 없고, 이 SQL 로만 지정합니다.
-- Supabase 대시보드 > SQL Editor 에서 필요한 부분만 실행하세요.
-- =====================================================================

-- [A] 이미 있는 계정을 총관리자로 올리기  (예: 아이디 admin)
update public.profiles set role = 'super', store_id = null, active = true
where username = 'admin';

-- [B] (앱의 "최초 총관리자 만들기"를 쓰지 않을 때만)
--     1) Authentication > Users > Add user > Create new user
--        Email: dev@vintage.local / Password / "Auto Confirm User" 체크
--     2) 아래 실행
-- insert into public.profiles (id, username, name, role)
-- select id, 'dev', '총관리자', 'super' from auth.users where email = 'dev@vintage.local'
-- on conflict (id) do update set role = 'super', active = true;

-- [C] 이용기간 확인
-- select * from public.license;
