// Supabase 대시보드 > Project Settings > API Keys 에서 복사한 값
// publishable(anon) key 는 브라우저에 공개되어도 되는 키입니다. (secret / service_role 키는 절대 넣지 마세요!)
window.APP_CONFIG = {
  SUPABASE_URL: 'https://yxnvpaludjsrbxvxtlbq.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_SH4AinvZJ8DBDtqVqERtqg_6K2WmPCk',
  LOGIN_EMAIL_DOMAIN: 'vintage.local', // Edge Function 의 LOGIN_EMAIL_DOMAIN 과 같아야 함
  ADMIN_FUNCTION: 'bright-api',        // 계정 생성 Edge Function 이름 (대시보드에 배포된 이름)
};
