# 토스플레이스 연동 준비 문서

> 아직 연동하지 않았습니다. 토스플레이스를 쓰기로 결정하면 바로 작업할 수 있도록 미리 준비해 둔 것입니다.
> 토스플레이스 공식 문서: https://docs.tossplace.com (연동 시 최신 내용으로 다시 확인)

## 목표 흐름 (POS 플러그인 방식)

```
[계산대]  바코드 스캔 ─▶ 토스 POS (플러그인)
                          │ ① 상품코드로 우리 DB 조회 (이름/가격/판매 가능 여부)
                          │ ② 토스 주문에 상품 추가
                          ▼
                       토스 단말기 결제 (카드/현금/간편결제)
                          │ ③ 결제 완료 이벤트 (Payment API: paid)
                          ▼
                 우리 Edge Function ─▶ checkout(..., p_external) ─▶ 영수증 생성 + 상품 "판매완료"
                                                                  ─▶ 전 매장 실시간 반영
                          │ ④ 결제 취소 이벤트 (cancel)
                          ▼
                 우리 Edge Function ─▶ cancel_sale(영수증)
```

## 이미 준비된 것 (DB)

| 항목 | 위치 | 설명 |
|---|---|---|
| 매장별 토스 가맹점 ID | `stores.toss_merchant_id` | 토스 Open API 의 merchantId 와 매장을 연결 |
| 외부 결제 정보 | `sales.ext_provider`, `ext_payment_id`, `ext_order_id`, `ext_data` | 토스 결제번호를 영수증에 저장 |
| 중복 방지 | `sales_ext_payment_key` 유니크 인덱스 | 같은 결제가 두 번 들어와도(웹훅 재전송) 영수증 1장만 생성 |
| 결제 함수 | `checkout(p_items, p_discount, p_payment, p_received_cash, p_memo, p_external)` | `p_external = {"provider":"tossplace","payment_id":"...","order_id":"...","data":{...}}` 로 호출. 이미 처리된 결제면 `duplicate: true` 와 기존 영수증을 반환 |
| 취소 함수 | `cancel_sale(p_sale_id, p_reason)` | 토스 결제 취소 시 호출 |

## 연동할 때 할 일

1. **토스플레이스 준비**
   - 토스 프론트 단말기 (VAN 대리점 또는 토스플레이스 문의)
   - 토스플레이스 개발자센터 가입 → 앱 생성 → 테스트 단말기 등록 (시리얼번호)
2. **Edge Function `tossplace`** (새로 작성)
   - `GET /product?code=...` : 플러그인이 상품 조회 (판매 가능 여부, 이름, 가격)
   - `POST /paid` : 결제 완료 → `checkout(..., p_external)` 호출
   - `POST /cancel` : 결제 취소 → `ext_payment_id` 로 영수증 찾아 `cancel_sale`
   - 인증: 플러그인 전용 비밀키(Edge Function Secret) + 토스 웹훅 서명/ID 확인
   - 판매자 계정: 매장별 "토스 연동" 전용 캐셔 계정을 만들어 그 권한으로 처리
3. **토스 POS 플러그인** (토스 Plugin SDK)
   - Barcode API 로 스캔값 수신 → 우리 `/product` 조회 → 주문에 추가
   - Payment API 의 paid / cancel 이벤트 구독 → 우리 `/paid`, `/cancel` 호출
   - HTTP API 사용 시 우리 Supabase 도메인을 ACL(허용 도메인)에 등록
4. **테스트** → 토스 검수 → 라이브 배포

## 연동 후에도 그대로 쓰는 것
- 우리 앱의 [상품 판매] 화면은 그대로 사용 가능합니다. 토스 단말기가 없는 매장이나 계좌이체 판매 등에 사용합니다.
- 정산 화면은 토스 결제 건과 앱에서 직접 판매한 건을 합쳐서 보여줍니다. 토스 결제 건은 `ext_provider = 'tossplace'` 로 구분됩니다.
