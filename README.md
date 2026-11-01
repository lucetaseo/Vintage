# VINTAGE 재고관리

빈티지샵 여러 매장(1·2·3호점…)이 **상품 재고와 판매 상태를 실시간으로 공유**하는 내부 프로그램입니다.

- 실장이 **사진 + 상품코드**로 상품을 등록합니다.
- 판매되면 **[판매 처리]** 를 누릅니다. 다른 매장 화면에도 즉시 "판매완료"로 바뀌고 알림이 뜹니다.
- 상품코드로 검색하면 **어느 매장에 재고가 있는지 / 이미 팔렸는지** 바로 확인할 수 있습니다.
- 계정은 **관리자가 아이디를 만들어서** 실장에게 줍니다. 회원가입은 없습니다.
- 접속 방법은 두 가지입니다. **웹사이트(도메인)** 로 바로 열거나, 휴대폰/PC에 **앱처럼 설치(PWA)** 할 수 있습니다.

## 구성

| 역할 | 사용 기술 |
|---|---|
| DB · 로그인 · 사진 저장 · 실시간 동기화 | [Supabase](https://supabase.com) |
| 화면 (웹앱 / 설치형 앱) | `public/` 폴더의 정적 파일 (빌드 과정 없음) |
| 직원 계정 생성 | Supabase Edge Function `admin-users` |

```
public/                  ← 호스팅(도메인)에 올리는 폴더
  index.html, app.js, style.css
  config.js              ← Supabase 주소/키 입력
  manifest.webmanifest, sw.js, icons/   ← 앱 설치(PWA)용
  vendor/                ← supabase-js 라이브러리
supabase/
  schema.sql             ← 테이블·권한·판매처리 함수·사진저장소 (SQL Editor에서 실행)
  bootstrap-admin.sql    ← 최초 관리자 연결
  functions/admin-users/ ← 관리자 전용 계정 생성/수정 함수
```

## 권한

| | 관리자 | 실장 |
|---|---|---|
| 전체 매장 상품 조회 / 검색 | ✅ | ✅ |
| 상품 등록 | 모든 매장 | 자기 매장 |
| 판매 처리 / 판매 취소 / 수정 / 매장 이동 | 모든 매장 | 자기 매장 상품만 |
| 상품 삭제 | ✅ | ❌ |
| 직원 계정 · 매장 관리 | ✅ | ❌ |

- 두 매장에서 같은 상품을 동시에 판매 처리해도 **한 번만 성공**합니다. DB 행 잠금으로 막습니다.
- 모든 등록/판매/취소/이동은 **이력**으로 남습니다.
- 계정을 "정지"하면 즉시 로그인과 데이터 접근이 차단됩니다.

---

## 설치 방법

### 1. Supabase 프로젝트 만들기
1. https://supabase.com 에서 새 프로젝트를 만듭니다. Region은 **Northeast Asia (Seoul)** 을 고르세요.
2. **SQL Editor** 에 [`supabase/schema.sql`](supabase/schema.sql) 전체를 붙여넣고 **Run** 합니다.
   - 기본 매장 `1호점`, `2호점`, `3호점`과 사진 저장소 `photos`가 만들어집니다.

### 2. 로그인 설정
**Authentication → Sign In / Providers** 에서:
- **Allow new users to sign up → 끄기** (관리자만 계정을 만들 수 있도록)
- Email provider는 켜두고, **Confirm email → 끄기**

### 3. 최초 관리자 만들기
[`supabase/bootstrap-admin.sql`](supabase/bootstrap-admin.sql) 상단 설명대로 진행합니다.
1. Authentication → Users → **Add user** 에서 이메일 `admin@vintage.local`과 비밀번호를 입력하고, **Auto Confirm** 을 체크합니다.
2. SQL Editor에서 `bootstrap-admin.sql`을 실행합니다.

이제 앱에서 아이디 `admin`으로 로그인할 수 있습니다.
> 로그인 아이디는 내부적으로 `아이디@vintage.local` 이메일로 저장됩니다. 실제 메일은 발송되지 않습니다.

### 4. 계정 생성 함수(Edge Function) 배포
관리자 화면에서 실장 계정을 만들 때 쓰는 함수입니다.

**방법 A: 대시보드**
Edge Functions → **Deploy a new function** → **Via Editor**. 이름은 `admin-users`로 하고, [`supabase/functions/admin-users/index.ts`](supabase/functions/admin-users/index.ts) 내용을 붙여넣은 뒤 Deploy 합니다.

**방법 B: CLI**
```bash
npx supabase login
npx supabase functions deploy admin-users --project-ref <프로젝트ID>
```

### 5. 앱에 Supabase 연결
Project Settings → API (또는 API Keys) 에서 **Project URL** 과 **anon / publishable key** 를 복사합니다. 그 값을 [`public/config.js`](public/config.js)에 넣습니다.
> ⚠️ `service_role` / `secret` 키는 절대 넣지 마세요.

### 6. 도메인으로 배포 (무료 호스팅)
Vercel, Netlify, Cloudflare Pages 중 하나에서 이 GitHub 저장소를 연결합니다.
- Build command: **없음**
- Output / Publish directory: **`public`**

배포가 끝나면 호스팅 설정의 **Custom Domain** 에서 보유한 도메인을 연결합니다. 예: `stock.내도메인.com`.
GitHub에 push할 때마다 자동으로 다시 배포됩니다.

### 7. 앱으로 설치 (다운로드해서 쓰기)
배포된 주소로 접속한 뒤:
- **안드로이드(크롬)**: ⋮ → **앱 설치**
- **아이폰(사파리)**: 공유 □↑ → **홈 화면에 추가**
- **PC(크롬/엣지)**: 주소창 오른쪽 설치 아이콘 ⊕

로그인 후 **내정보** 화면에도 같은 안내가 있습니다.

### 로컬에서 미리보기
```bash
npx serve public
```

---

## 사진 용량 / 비용 참고
- 사진은 업로드 전에 휴대폰에서 자동으로 압축됩니다. **원본 ≈ 150~250KB (1280px)**, **썸네일 ≈ 20~40KB (480px)** 입니다.
- 목록 화면은 썸네일만 불러오므로 데이터 사용량(egress)이 적습니다.
- 상품 1개당 대략 **0.25MB** 를 씁니다.
  - Supabase 무료 플랜(Storage 1GB 기준): 약 **4,000개**
  - Pro 플랜(Storage 100GB 포함): 약 **40만 개**
- 상품을 수정하거나 삭제하면 예전 사진도 자동으로 지워집니다.
- 무료 플랜은 일정 기간 사용이 없으면 프로젝트가 일시정지될 수 있습니다. 매장에서 매일 쓴다면 문제없지만, 운영용이라면 Pro 플랜을 권장합니다.
- 요금과 한도는 바뀔 수 있으니 https://supabase.com/pricing 에서 확인하세요.

## 앞으로 확장할 수 있는 것
- **바코드/QR 라벨 출력**: 상품코드로 라벨 생성 및 인쇄
- **카메라 스캔 판매**: 앱에서 카메라로 라벨을 찍으면 바로 판매 처리
- **재고조사 모드**: 매장 상품을 쭉 스캔한 뒤 "DB엔 있는데 매장에 없는 상품" 목록 자동 생성
- 매출 통계(매장별/기간별), 엑셀 내보내기
