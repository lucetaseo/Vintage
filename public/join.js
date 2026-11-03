// 손님용 QR 회원가입 페이지 (로그인 없음)
(() => {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const box = document.getElementById('join');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const token = new URLSearchParams(location.search).get('s') || '';
  const fail = (msg) => {
    box.innerHTML = `<h1>VINTAGE</h1><p class="sub" style="color:var(--sold)">${esc(msg)}</p>`;
  };
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return fail('설정이 필요합니다');
  if (!token) return fail('잘못된 가입 주소입니다. 매장의 QR코드를 다시 찍어주세요');

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const errText = (e) => {
    const m = String(e?.message || e || '');
    if (/Failed to fetch|NetworkError/i.test(m)) return '인터넷 연결을 확인해 주세요';
    return m || '오류가 발생했습니다';
  };

  const PRIVACY = `
    <b>수집 항목</b>: 이름, 휴대폰 번호<br>
    <b>이용 목적</b>: 회원 확인, 포인트 적립·사용, 구매 내역 관리<br>
    <b>보유 기간</b>: 회원 탈퇴 요청 시까지 (탈퇴는 매장 직원에게 요청)<br>
    동의를 거부할 수 있으며, 거부 시 회원 가입과 포인트 적립이 제한됩니다.`;

  (async () => {
    const { data: info, error } = await sb.rpc('join_info', { p_token: token });
    if (error) return fail(errText(error));
    document.title = `${info.store_name} 회원가입`;
    const perks = [
      info.join_points > 0 ? `가입하면 <b>${Number(info.join_points).toLocaleString('ko-KR')}P</b> 바로 적립` : '',
      Number(info.point_rate) > 0 ? `구매 금액의 <b>${Number(info.point_rate)}%</b> 포인트 적립` : '',
    ].filter(Boolean);
    box.innerHTML = `
      <h1>${esc(info.store_name)}</h1>
      <p class="sub">회원가입</p>
      ${perks.length ? `<div class="join-perks">${perks.map((p) => `<div>🎁 ${p}</div>`).join('')}</div>` : ''}
      <form id="jForm" autocomplete="on">
        <label class="field"><span>이름</span><input type="text" name="name" autocomplete="name" required maxlength="30"></label>
        <label class="field"><span>휴대폰 번호</span><input type="tel" name="phone" autocomplete="tel" inputmode="tel" placeholder="010-0000-0000" required></label>
        <div class="consent">
          <label><input type="checkbox" name="privacy"> <b>[필수]</b> 개인정보 수집·이용 동의</label>
          <details><summary class="hint">내용 보기</summary><p class="hint">${PRIVACY}</p></details>
          <label><input type="checkbox" name="marketing"> [선택] 할인·신상품 소식 문자 받기</label>
        </div>
        <div class="err" id="jErr"></div>
        <button class="btn primary block">가입하기</button>
      </form>`;
    const f = document.getElementById('jForm');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = document.getElementById('jErr');
      err.textContent = '';
      if (!f.privacy.checked) return (err.textContent = '개인정보 수집·이용에 동의해 주세요');
      const btn = f.querySelector('button');
      btn.disabled = true;
      btn.textContent = '가입 중…';
      const { data, error: e2 } = await sb.rpc('public_join', {
        p_token: token,
        p_name: f.name.value,
        p_phone: f.phone.value,
        p_privacy: f.privacy.checked,
        p_marketing: f.marketing.checked,
      });
      btn.disabled = false;
      btn.textContent = '가입하기';
      if (e2) return (err.textContent = errText(e2));
      box.innerHTML =
        data.status === 'exists'
          ? `<h1>${esc(info.store_name)}</h1><div class="join-done">이미 가입된 번호예요 🙂<br><span class="hint">계산할 때 휴대폰 번호를 말씀해 주세요.</span></div>`
          : `<h1>${esc(info.store_name)}</h1><div class="join-done">🎉 가입 완료!<br>${
              data.points ? `<b>${Number(data.points).toLocaleString('ko-KR')}P</b>가 적립되었어요.<br>` : ''
            }<span class="hint">계산할 때 휴대폰 번호를 말씀해 주세요.</span></div>`;
    };
  })();
})();
