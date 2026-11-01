-- 최초 관리자 계정 연결 (한 번만 실행)
-- 1) 먼저 Supabase 대시보드 > Authentication > Users > "Add user" > "Create new user"
--    Email: admin@vintage.local   Password: (원하는 비밀번호)   "Auto Confirm User" 체크
-- 2) 아래 SQL 을 SQL Editor 에서 실행 → 이제 앱에서 아이디 "admin" 으로 로그인 가능
insert into public.profiles (id, username, name, role)
select id, 'admin', '관리자', 'admin'
from auth.users
where email = 'admin@vintage.local'
on conflict (id) do update set role = 'admin', active = true;
