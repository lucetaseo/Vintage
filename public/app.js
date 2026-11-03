(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const root = document.getElementById('app');
  const BUCKET = 'photos';
  const PAGE = 60;
  const DOMAIN = CFG.LOGIN_EMAIL_DOMAIN || 'vintage.local';

  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
    root.innerHTML = `<div class="login-wrap"><div class="card login"><h1>설정 필요</h1>
      <p><code>public/config.js</code> 파일에 Supabase 주소(URL)와 anon key를 입력하세요.<br>자세한 방법은 README를 참고하세요.</p></div></div>`;
    return;
  }

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  const state = {
    me: null,
    stores: [],
    storeMap: {},
    people: {},
    filter: { q: '', store: '', status: 'available' },
    list: [],
    hasMore: false,
    live: false,
    channel: null,
    view: null,
    detailId: null,
  };

  // ---------------- 공통 유틸 ----------------
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const won = (n) => (n == null || n === '' ? '-' : `${Number(n).toLocaleString('ko-KR')}원`);
  const fmt = (t) =>
    t ? new Date(t).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
  const storeName = (id) => state.storeMap[id]?.name || '-';
  const personName = (id) => state.people[id]?.name || '-';
  const photoUrl = (path) => (path ? sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : '');
  const ROLE_LABEL = { super: '총관리자', admin: '관리자', manager: '실장', cashier: '캐셔' };
  const PAY_LABEL = { cash: '현금', card: '카드', transfer: '이체' };
  const isCashier = () => state.me?.role === 'cashier';
  const needsStore = (role) => role === 'manager' || role === 'cashier';
  const kstToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const shiftDate = (ymdStr, n) => {
    const [y, m, d] = ymdStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
  };
  const kstStart = (ymdStr) => `${ymdStr}T00:00:00+09:00`;
  const hhmm = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const isAdmin = () => ['admin', 'super'].includes(state.me?.role);
  const isSuper = () => state.me?.role === 'super';
  const canManage = (storeId) => state.me && (isAdmin() || state.me.store_id === storeId);
  const ymd = (s) => {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const fmtDate = (s) => {
    if (!s) return '-';
    const d = typeof s === 'string' ? ymd(s) : s;
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  };
  const addDays = (s, n) => {
    const d = ymd(s);
    d.setDate(d.getDate() + n);
    return d;
  };
  const licenseBlocked = () => state.license?.state === 'expired' && !isSuper();
  const normCode = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');

  function errText(error) {
    const m = String(error?.message || error || '오류가 발생했습니다');
    if (/Invalid login credentials/i.test(m)) return '아이디 또는 비밀번호가 올바르지 않습니다';
    if (/banned/i.test(m)) return '비활성화된 계정입니다. 관리자에게 문의하세요';
    if (/Failed to fetch|NetworkError/i.test(m)) return '인터넷 연결을 확인하세요';
    if (/JWT expired/i.test(m)) return '로그인이 만료되었습니다. 다시 로그인하세요';
    return m;
  }

  function toast(msg, kind = '', onClick) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    el.onclick = () => {
      el.remove();
      onClick?.();
    };
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'sold' ? 7000 : 4000);
  }

  function modal(html, onReady) {
    return new Promise((resolve) => {
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.innerHTML = `<div class="modal">${html}</div>`;
      const close = (v) => {
        bg.remove();
        resolve(v);
      };
      bg.addEventListener('click', (e) => {
        if (e.target === bg) close(null);
      });
      document.body.appendChild(bg);
      onReady(bg, close);
    });
  }

  function confirmBox(title, body, okLabel = '확인', okClass = 'primary') {
    return modal(
      `<h3>${esc(title)}</h3><div>${body}</div>
       <div class="row"><button class="btn" data-x>취소</button><button class="btn ${okClass}" data-ok>${esc(okLabel)}</button></div>`,
      (bg, close) => {
        $('[data-x]', bg).onclick = () => close(false);
        $('[data-ok]', bg).onclick = () => close(true);
      }
    );
  }

  function promptBox(title, label, value = '', okLabel = '확인', okClass = 'primary', inputmode = 'text') {
    return modal(
      `<h3>${esc(title)}</h3>
       <label class="field"><span>${esc(label)}</span><input type="text" inputmode="${inputmode}" value="${esc(value)}"></label>
       <div class="row"><button class="btn" data-x>취소</button><button class="btn ${okClass}" data-ok>${esc(okLabel)}</button></div>`,
      (bg, close) => {
        const input = $('input', bg);
        input.focus();
        input.select();
        $('[data-x]', bg).onclick = () => close(null);
        $('[data-ok]', bg).onclick = () => close(input.value);
        input.onkeydown = (e) => {
          if (e.key === 'Enter') close(input.value);
        };
      }
    );
  }

  async function busy(btn, fn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '처리 중…';
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------------- 사진 처리 (업로드 전 휴대폰에서 압축) ----------------
  async function loadImage(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('사진을 읽을 수 없습니다'));
        img.src = URL.createObjectURL(file);
      });
    }
  }
  function toJpeg(img, max, quality) {
    const w0 = img.width;
    const h0 = img.height;
    const r = Math.min(1, max / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * r);
    c.height = Math.round(h0 * r);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
  }
  async function preparePhoto(file) {
    const img = await loadImage(file);
    const [full, thumb] = await Promise.all([toJpeg(img, 1280, 0.82), toJpeg(img, 480, 0.75)]);
    return { full, thumb };
  }
  async function uploadPhoto({ full, thumb }) {
    const d = new Date();
    const base = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}`;
    const opts = { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false };
    const store = sb.storage.from(BUCKET);
    const [a, b] = await Promise.all([store.upload(`${base}.jpg`, full, opts), store.upload(`${base}_t.jpg`, thumb, opts)]);
    if (a.error || b.error) {
      await removePhotos([`${base}.jpg`, `${base}_t.jpg`]);
      throw new Error(`사진 업로드 실패: ${errText(a.error || b.error)}`);
    }
    return { photo_path: `${base}.jpg`, thumb_path: `${base}_t.jpg` };
  }
  async function removePhotos(paths) {
    const list = (paths || []).filter(Boolean);
    if (list.length) await sb.storage.from(BUCKET).remove(list);
  }

  // ---------------- 데이터 ----------------
  async function loadMe() {
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return false;
    const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (!data || !data.active) return false;
    state.me = data;
    return true;
  }
  async function loadStores() {
    const { data, error } = await sb.rpc('store_summary');
    if (error) throw error;
    state.stores = data || [];
    state.storeMap = Object.fromEntries(state.stores.map((s) => [s.id, s]));
  }
  async function loadPeople() {
    const { data } = await sb.from('profiles').select('id, username, name, role, store_id, active, deleted_at');
    state.people = Object.fromEntries((data || []).map((p) => [p.id, p]));
  }

  // ---------------- 실시간 ----------------
  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try {
        if (!state.me || state.view === 'expired' || state.view === 'login' || state.view === 'setup') return;
        await loadLicense();
        if (licenseBlocked()) return renderExpired();
        await loadStores();
        if (state.view === 'list') {
          renderChips();
          await loadList(true, Math.max(state.list.length, PAGE));
        } else if (state.view === 'sell') {
          await Promise.all([loadToday(), loadCash()]);
        } else if (state.view === 'settle') {
          await loadSettle();
        } else if (state.view === 'detail' && state.detailId) {
          await viewDetail(state.detailId, true);
        }
      } catch (e) {
        console.warn(e);
      }
    }, 400);
  }

  async function onEvent(payload) {
    const e = payload.new;
    scheduleRefresh();
    if (!state.me || e.user_id === state.me.id) return;
    if (!['sold', 'created', 'unsold', 'moved'].includes(e.action)) return;
    if (!state.people[e.user_id]) await loadPeople();
    const { data: p } = await sb.from('products').select('code').eq('id', e.product_id).maybeSingle();
    const code = p?.code || `#${e.product_id}`;
    const who = `${storeName(e.store_id)} ${personName(e.user_id)}`;
    const open = () => (location.hash = `#/p/${e.product_id}`);
    if (e.action === 'sold') toast(`🔴 ${code} 판매완료 (${who})`, 'sold', open);
    else if (e.action === 'created') toast(`🆕 ${code} 등록됨 (${who})`, '', open);
    else if (e.action === 'unsold') toast(`↩ ${code} 판매취소 (${who})`, '', open);
    else if (e.action === 'moved') toast(`🚚 ${code} 매장이동 ${e.detail}`, '', open);
  }

  function startRealtime() {
    stopRealtime();
    state.channel = sb
      .channel('inventory')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, (payload) => {
        if (payload.eventType === 'DELETE' && state.view === 'detail' && state.detailId === payload.old?.id) {
          toast('이 상품이 삭제되었습니다');
          location.hash = '#/';
          return;
        }
        const n = payload.new;
        if (n && n.status === 'sold' && cart.items.some((c) => c.id === n.id) && !cart.paying) {
          const c = cart.items.find((x) => x.id === n.id);
          c.soldElsewhere = true;
          saveCart();
          if (state.view === 'sell') renderCart();
        }
        scheduleRefresh();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'product_events' }, onEvent)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => scheduleRefresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_sessions' }, () => scheduleRefresh())
      .subscribe((status) => {
        const was = state.live;
        state.live = status === 'SUBSCRIBED';
        updateLive();
        if (state.live && !was) scheduleRefresh(); // 재연결 시 놓친 변경 반영
      });
  }
  function stopRealtime() {
    if (state.channel) sb.removeChannel(state.channel);
    state.channel = null;
    state.live = false;
  }
  function updateLive() {
    const dot = $('#live');
    if (dot) {
      dot.classList.toggle('on', state.live);
      dot.title = state.live ? '실시간 연결됨' : '연결 끊김 - 재연결 중';
    }
  }
  setInterval(() => state.me && scheduleRefresh(), 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.me) scheduleRefresh();
  });

  // ---------------- PWA 설치 ----------------
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    const b = $('#installBtn');
    if (b && !isAdmin()) b.hidden = false; // 관리자·총관리자는 내정보에서만 설치
    const b2 = $('#install2');
    if (b2) b2.hidden = false;
  });
  async function doInstall() {
    if (!installPrompt) return location.assign('#/account');
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    const b = $('#installBtn');
    if (b) b.hidden = true;
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }

  // ---------------- 이용기간 ----------------
  async function loadLicense() {
    const { data, error } = await sb.rpc('license_status');
    if (!error) state.license = (data && data[0]) || null;
    return state.license;
  }

  function licenseBanner() {
    const l = state.license;
    if (!l) return '';
    const until = fmtDate(l.paid_until);
    const go = isSuper() ? ' · <a href="#/license">연장하기</a>' : '';
    if (l.state === 'warning' && isAdmin()) {
      return `<div class="lic warn">이용기간이 ${l.days_left === 0 ? '오늘' : `${l.days_left}일 후`} 만료됩니다 (${until}까지)${
        go || ' · 총관리자에게 연장을 요청하세요'
      }</div>`;
    }
    if (l.state === 'grace') {
      return `<div class="lic grace">이용기간이 ${until}에 끝났습니다. ${fmtDate(addDays(l.paid_until, l.grace_days))}까지 연장되지 않으면 사용이 중지됩니다${go}</div>`;
    }
    if (l.state === 'expired' && isSuper()) {
      return `<div class="lic grace">이용기간 만료 상태입니다. 총관리자 외 직원은 사용할 수 없습니다${go}</div>`;
    }
    return '';
  }

  function renderExpired() {
    state.view = 'expired';
    stopRealtime();
    const l = state.license;
    root.innerHTML = `
      <div class="login-wrap"><div class="card login" style="text-align:center">
        <h1>VINTAGE</h1>
        <p style="font-size:17px;font-weight:700;margin:18px 0 8px">이용 기간이 만료되었습니다</p>
        <p class="hint" style="font-size:14px;line-height:1.7">${l ? `${fmtDate(l.paid_until)}까지 이용 가능했습니다.<br>` : ''}
          총관리자(개발자)에게 연장을 요청하세요.<br>데이터는 그대로 보관되어 있고, 연장되면 바로 다시 사용할 수 있습니다.</p>
        <div class="actions"><button class="btn primary block" id="recheck">다시 확인</button><button class="btn" id="out">로그아웃</button></div>
      </div></div>`;
    $('#recheck').onclick = (e) => busy(e.target, () => afterLogin());
    $('#out').onclick = () => sb.auth.signOut();
  }

  // ---------------- 레이아웃 ----------------
  function shell(active, html) {
    const me = state.me;
    const link = (href, key, label) => `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
    root.innerHTML = `
      <header class="topbar">
        <a class="brand" href="#/">VINTAGE<span id="live" class="live ${state.live ? 'on' : ''}"></span></a>
        <nav class="nav">
          ${isCashier() ? '' : link('#/', 'list', '상품목록')}
          ${link('#/sell', 'sell', '상품 판매')}
          ${link('#/settle', 'settle', '정산')}
          ${isCashier() ? '' : link('#/members', 'members', '회원')}
          ${isAdmin() ? link('#/admin', 'admin', '관리자') : ''}
          ${isSuper() ? link('#/license', 'license', '이용관리') : ''}
          ${link('#/account', 'account', '내정보')}
          <a href="#" id="installBtn" ${installPrompt && !isAdmin() ? '' : 'hidden'}>앱 설치</a>
        </nav>
        <div class="who">${esc(me.name)} · ${ROLE_LABEL[me.role]}${me.store_id ? ` · ${esc(storeName(me.store_id))}` : ''}</div>
      </header>
      ${licenseBanner()}
      <main>${html}</main>`;
    $('#installBtn').onclick = (e) => {
      e.preventDefault();
      doInstall();
    };
    window.scrollTo(0, 0);
  }

  // ---------------- 로그인 ----------------
  function renderLogin(message = '') {
    state.view = 'login';
    root.innerHTML = `
      <div class="login-wrap"><form class="card login" id="loginForm">
        <h1>VINTAGE</h1><p class="sub">매장 재고 관리</p>
        <label class="field"><span>아이디</span><input type="text" name="username" autocomplete="username" autocapitalize="none" required></label>
        <label class="field"><span>비밀번호</span><input type="password" name="password" autocomplete="current-password" required></label>
        <div class="err" id="loginErr">${esc(message)}</div>
        <button class="btn primary block">로그인</button>
        <p class="hint" style="text-align:center;margin-top:14px">계정은 관리자에게 받으세요</p>
      </form></div>`;
    $('#loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = $('button', f);
      await busy(btn, async () => {
        const username = f.username.value.trim().toLowerCase();
        const { error } = await sb.auth.signInWithPassword({ email: `${username}@${DOMAIN}`, password: f.password.value });
        if (error) return ($('#loginErr').textContent = errText(error));
        if (!(await loadMe())) {
          await sb.auth.signOut();
          return ($('#loginErr').textContent = '등록되지 않았거나 비활성화된 계정입니다');
        }
        goHome();
        await afterLogin();
      });
    };
    checkSetup();
  }

  // 관리자가 아직 한 명도 없으면 "최초 관리자 만들기" 화면으로 전환
  async function checkSetup() {
    const { data, error } = await sb.rpc('needs_setup');
    if (state.view !== 'login') return;
    if (data === true) return renderSetup();
    if (error) {
      const el = $('#loginErr');
      if (el && !el.textContent) {
        el.textContent = /function|schema cache|not find|does not exist/i.test(error.message)
          ? 'DB가 아직 준비되지 않았습니다. Supabase SQL Editor 에서 schema.sql 을 실행하세요'
          : `서버 연결 확인 실패: ${errText(error)}`;
      }
    }
  }

  function renderSetup() {
    state.view = 'setup';
    root.innerHTML = `
      <div class="login-wrap"><form class="card login" id="setupForm" autocomplete="off">
        <h1>VINTAGE</h1><p class="sub">처음 오셨네요! 총관리자(개발자) 계정을 만드세요</p>
        <label class="field"><span>총관리자 아이디 (영문/숫자)</span><input type="text" name="username" value="admin" autocapitalize="none" required></label>
        <label class="field"><span>이름</span><input type="text" name="name" value="총관리자" required></label>
        <label class="field"><span>비밀번호 (6자 이상)</span><input type="password" name="password" autocomplete="new-password" minlength="6" required></label>
        <label class="field"><span>비밀번호 확인</span><input type="password" name="password2" autocomplete="new-password" minlength="6" required></label>
        <div class="err" id="setupErr"></div>
        <button class="btn primary block">총관리자 만들기</button>
        <p class="hint" style="text-align:center;margin-top:14px">매장 관리자/실장 계정은 로그인 후 [관리자] 메뉴에서 만듭니다</p>
      </form></div>`;
    const f = $('#setupForm');
    const showErr = (m) => ($('#setupErr').textContent = m);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const username = f.username.value.trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,30}$/.test(username)) return showErr('아이디는 영문 소문자/숫자 3~30자로 입력하세요');
      if (f.password.value !== f.password2.value) return showErr('비밀번호가 서로 다릅니다');
      await busy($('button', f), async () => {
        const email = `${username}@${DOMAIN}`;
        const password = f.password.value;
        let { data, error } = await sb.auth.signUp({ email, password });
        if (error && /already (registered|exists)/i.test(error.message)) {
          ({ data, error } = await sb.auth.signInWithPassword({ email, password }));
        }
        if (error) {
          if (/sign ?ups? (are )?(not allowed|disabled)/i.test(error.message)) {
            return showErr("Supabase > Authentication > Sign In / Providers 에서 'Allow new users to sign up'을 잠깐 켠 뒤 다시 누르세요");
          }
          return showErr(errText(error));
        }
        if (!data.session) {
          return showErr("Supabase > Authentication > Sign In / Providers > Email 에서 'Confirm email'을 끈 뒤 다시 누르세요");
        }
        const { error: e2 } = await sb.rpc('claim_admin', { p_username: username, p_name: f.name.value });
        if (e2) {
          await sb.auth.signOut();
          return renderLogin(errText(e2));
        }
        if (!(await loadMe())) return showErr('관리자 설정에 실패했습니다. 다시 시도하세요');
        goHome();
        await afterLogin();
        toast(`총관리자 계정(${username})이 만들어졌습니다`);
      });
    };
  }

  async function loadSettings() {
    const { data } = await sb.from('app_settings').select('*').eq('id', 1).maybeSingle();
    state.settings = data || { points_enabled: true, point_rate: 1, point_min_use: 1000 };
  }

  // 로그인/로그아웃 시 이전 화면(예: 내정보)으로 가지 않고 기본 화면으로 (캐셔는 자동으로 상품 판매)
  function goHome() {
    if (location.hash && location.hash !== '#/') history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  }

  async function afterLogin() {
    await loadLicense();
    if (licenseBlocked()) return renderExpired();
    await Promise.all([loadStores(), loadPeople(), loadSettings()]);
    startRealtime();
    route();
  }

  // ---------------- 상품 목록 ----------------
  function renderChips() {
    const el = $('#chips');
    if (!el) return;
    const f = state.filter;
    const total = state.stores.reduce((a, s) => a + Number(s.available), 0);
    el.innerHTML =
      `<button class="chip ${f.store === '' ? 'active' : ''}" data-store="">전체 <small>재고 ${total}</small></button>` +
      state.stores
        .map(
          (s) =>
            `<button class="chip ${String(f.store) === String(s.id) ? 'active' : ''}" data-store="${s.id}">
              <b>${esc(s.name)}</b> <small>재고 ${s.available} · 오늘판매 ${s.sold_today}</small></button>`
        )
        .join('');
    el.querySelectorAll('.chip').forEach(
      (b) =>
        (b.onclick = () => {
          state.filter.store = b.dataset.store;
          renderChips();
          loadList(true);
        })
    );
  }

  function card(p) {
    const sold = p.status === 'sold';
    return `<a class="item ${sold ? 'sold' : ''}" href="#/p/${p.id}">
      <img class="ph" loading="lazy" src="${esc(photoUrl(p.thumb_path || p.photo_path))}" alt="">
      <span class="badge ${p.status}">${sold ? '판매완료' : '판매중'}</span>
      <span class="storetag">${esc(storeName(p.store_id))}</span>
      <div class="meta">
        <div class="code">${esc(p.code)}</div>
        <div class="name">${esc(p.name) || '&nbsp;'}</div>
        <div class="price">${sold ? `<s style="color:var(--muted);font-weight:400">${won(p.price)}</s>` : won(p.price)}</div>
      </div></a>`;
  }

  function viewList() {
    state.view = 'list';
    const f = state.filter;
    const seg = (v, label) => `<button data-status="${v}" class="${f.status === v ? 'active' : ''}">${label}</button>`;
    shell(
      'list',
      `<div class="chips" id="chips"></div>
       <div class="toolbar">
         <input type="search" class="search" id="q" placeholder="상품코드 / 이름 검색 (다른 매장 재고 확인)" value="${esc(f.q)}" autocomplete="off" enterkeyhint="search">
         <div class="seg" id="seg">${seg('available', '판매중')}${seg('sold', '판매완료')}${seg('all', '전체')}</div>
         <a class="btn primary addbtn" href="#/new">+ 상품 등록</a>
         <a class="btn addbtn" href="#/sell">💳 상품 판매</a>
         <a class="btn addbtn" href="#/labels">🏷 라벨</a>
       </div>
       <div id="lookup"></div>
       <div class="grid" id="grid"></div>
       <div class="more" id="more"></div>`
    );
    renderChips();
    let t;
    const q = $('#q');
    q.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.filter.q = q.value.trim();
        loadList(true);
      }, 300);
    };
    q.onkeydown = (e) => {
      if (e.key === 'Enter') {
        clearTimeout(t);
        state.filter.q = q.value.trim();
        // 바코드 스캐너로 찍으면(코드 + Enter) 해당 상품 화면으로 바로 이동
        const code = normCode(q.value);
        if (code) {
          sb.from('products').select('id').eq('code', code).maybeSingle().then(({ data }) => {
            if (data) location.hash = `#/p/${data.id}`;
            else loadList(true);
          });
        } else loadList(true);
        q.blur();
      }
    };
    $('#seg').querySelectorAll('button').forEach(
      (b) =>
        (b.onclick = () => {
          state.filter.status = b.dataset.status;
          $('#seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
          loadList(true);
        })
    );
    loadList(true);
  }

  let listSeq = 0;
  async function loadList(reset, size = PAGE) {
    const seq = ++listSeq;
    const f = state.filter;
    const from = reset ? 0 : state.list.length;
    let qb = sb.from('products').select('*');
    const term = f.q.replace(/[,()%*\\]/g, ' ').trim();
    if (term) qb = qb.or(`code.ilike.%${term}%,name.ilike.%${term}%,memo.ilike.%${term}%`);
    if (f.store) qb = qb.eq('store_id', Number(f.store));
    if (f.status !== 'all') qb = qb.eq('status', f.status);
    qb =
      f.status === 'sold'
        ? qb.order('sold_at', { ascending: false })
        : qb.order('created_at', { ascending: false });
    qb = qb.order('id', { ascending: false }).range(from, from + size);

    const exactQ = f.q ? sb.from('products').select('*').eq('code', normCode(f.q)).maybeSingle() : null;
    const [{ data, error }, exact] = await Promise.all([qb, exactQ]);
    if (seq !== listSeq || state.view !== 'list') return;
    if (error) return toast(errText(error), 'error');

    const rows = data || [];
    state.hasMore = rows.length > size;
    state.list = reset ? rows.slice(0, size) : state.list.concat(rows.slice(0, size));

    renderLookup(exact?.data || null, f.q, state.list.length);
    const grid = $('#grid');
    grid.innerHTML = state.list.length ? state.list.map(card).join('') : '';
    $('#more').innerHTML = !state.list.length
      ? `<div class="empty">상품이 없습니다<br><br><a class="btn primary" href="#/new" style="display:inline-block;text-decoration:none">+ 상품 등록하기</a></div>`
      : state.hasMore
        ? `<button class="btn" id="moreBtn">더 보기</button>`
        : '';
    const mb = $('#moreBtn');
    if (mb) mb.onclick = () => busy(mb, () => loadList(false));
  }

  function renderLookup(p, q, count) {
    const el = $('#lookup');
    if (!el) return;
    if (!q) return (el.innerHTML = '');
    if (p) {
      const sold = p.status === 'sold';
      el.innerHTML = `<div class="lookup ${sold ? 'sold' : 'ok'}" id="lk">
        <img src="${esc(photoUrl(p.thumb_path || p.photo_path))}" alt="">
        <div><strong>${esc(p.code)} · ${
          sold
            ? `판매완료 (${esc(storeName(p.sold_store_id || p.store_id))}, ${fmt(p.sold_at)})`
            : `${esc(storeName(p.store_id))}에 재고 있음`
        }</strong>${esc(p.name)} ${p.price != null ? '· ' + won(p.price) : ''}</div></div>`;
      $('#lk').onclick = () => (location.hash = `#/p/${p.id}`);
    } else if (!count) {
      el.innerHTML = `<div class="lookup none"><div><strong>"${esc(q)}" 상품 없음</strong>등록되지 않은 코드이거나 검색 조건(매장/상태)을 확인하세요</div></div>`;
    } else {
      el.innerHTML = '';
    }
  }

  // ---------------- 상품 상세 ----------------
  const ACTION_LABEL = { created: '등록', updated: '정보 수정', moved: '매장 이동', sold: '판매완료', unsold: '판매 취소' };

  async function viewDetail(id, silent = false) {
    state.view = 'detail';
    state.detailId = id;
    if (!silent) shell('list', `<div class="empty">불러오는 중…</div>`);
    const [{ data: p, error }, { data: events }] = await Promise.all([
      sb.from('products').select('*').eq('id', id).maybeSingle(),
      sb.from('product_events').select('*').eq('product_id', id).order('created_at').order('id'),
    ]);
    if (state.view !== 'detail' || state.detailId !== id) return;
    if (error) return toast(errText(error), 'error');
    if (!p) return shell('list', `<div class="empty">상품을 찾을 수 없습니다 (삭제되었을 수 있음)<br><br><a href="#/">목록으로</a></div>`);
    if ((events || []).some((e) => e.user_id && !state.people[e.user_id])) await loadPeople();

    const sold = p.status === 'sold';
    const manage = canManage(p.store_id);
    const html = `
      <p><a href="#/">← 목록</a></p>
      <div class="detail">
        <a href="${esc(photoUrl(p.photo_path))}" target="_blank" rel="noopener">
          <img class="photo ${sold ? 'sold' : ''}" src="${esc(photoUrl(p.photo_path))}" alt=""></a>
        <div>
          <div class="card">
            <span class="badge ${p.status}">${sold ? '판매완료' : '판매중'}</span>
            <div class="bigcode" style="margin-top:8px">${esc(p.code)}</div>
            <div>${esc(p.name)}</div>
            <dl class="kv">
              <dt>매장</dt><dd>${esc(storeName(p.store_id))}</dd>
              <dt>가격</dt><dd>${won(p.price)}</dd>
              ${p.memo ? `<dt>메모</dt><dd style="white-space:pre-wrap;font-weight:400">${esc(p.memo)}</dd>` : ''}
              <dt>등록</dt><dd>${fmt(p.created_at)} · ${esc(personName(p.created_by))}</dd>
            </dl>
            ${
              sold
                ? `<div class="soldbox">${fmt(p.sold_at)} ${esc(storeName(p.sold_store_id))}에서 판매 · ${esc(personName(p.sold_by))}
                   ${p.sold_price != null ? `<br>판매가 ${won(p.sold_price)}` : ''}${p.sold_payment ? ` · ${PAY_LABEL[p.sold_payment]}` : ''}</div>`
                : ''
            }
            ${
              !manage && !sold
                ? `<p class="hint">이 상품은 <b>${esc(storeName(p.store_id))}</b> 상품입니다. 판매 처리는 해당 매장에서 합니다.</p>`
                : ''
            }
            <div class="actions">
              ${manage && !sold ? `<button class="btn sell block" id="sellBtn">판매 처리</button>` : ''}
              ${sold && p.sale_id ? `<button class="btn block" id="receiptBtn">🧾 영수증 보기 / 출력</button>` : ''}
              ${manage && sold ? `<button class="btn block" id="unsellBtn">판매 취소 (되돌리기)</button>` : ''}
              <a class="btn" href="#/labels?ids=${p.id}" style="text-align:center;text-decoration:none">🏷 라벨 출력 / 저장 (QR · 바코드)</a>
              ${manage ? `<button class="btn" id="editBtn">수정 / 매장 이동</button>` : ''}
              ${isAdmin() ? `<button class="btn danger" id="delBtn">삭제</button>` : ''}
            </div>
          </div>
          <h2>이력</h2>
          <ul class="timeline">${(events || [])
            .map(
              (e) => `<li class="${e.action}">${ACTION_LABEL[e.action] || e.action}${e.detail ? ` · ${esc(e.detail)}` : ''}
                <time>${fmt(e.created_at)} · ${esc(storeName(e.store_id))} ${esc(personName(e.user_id))}</time></li>`
            )
            .join('')}</ul>
        </div>
      </div>`;
    shell('list', html);

    const sellBtn = $('#sellBtn');
    if (sellBtn)
      sellBtn.onclick = async () => {
        const r = await sellDialog(p);
        if (!r) return;
        await busy(sellBtn, async () => {
          const { error: e } = await sb.rpc('sell_product', { p_id: p.id, p_sold_price: r.price, p_payment: r.payment });
          if (e) return toast(errText(e), 'error');
          toast(`${p.code} 판매완료 처리됨 - 모든 매장에 반영됩니다`);
          viewDetail(p.id, true);
        });
      };
    const receiptBtn = $('#receiptBtn');
    if (receiptBtn) receiptBtn.onclick = () => openReceipt(p.sale_id, () => viewDetail(p.id, true));
    const unsellBtn = $('#unsellBtn');
    if (unsellBtn)
      unsellBtn.onclick = async () => {
        const reason = await promptBox('판매 취소', '사유 (예: 환불, 잘못 누름)', '', '판매 취소');
        if (reason === null) return;
        await busy(unsellBtn, async () => {
          const { error: e } = await sb.rpc('unsell_product', { p_id: p.id, p_reason: reason });
          if (e) return toast(errText(e), 'error');
          toast('판매중으로 되돌렸습니다');
          viewDetail(p.id, true);
        });
      };
    const editBtn = $('#editBtn');
    if (editBtn) editBtn.onclick = () => (location.hash = `#/p/${p.id}/edit`);
    const delBtn = $('#delBtn');
    if (delBtn)
      delBtn.onclick = async () => {
        if (!(await confirmBox('상품 삭제', `<b>${esc(p.code)}</b> 상품과 사진, 이력을 완전히 삭제합니다.`, '삭제', 'sell'))) return;
        await busy(delBtn, async () => {
          const { data: paths, error: e } = await sb.rpc('delete_product', { p_id: p.id });
          if (e) return toast(errText(e), 'error');
          await removePhotos(paths);
          toast('삭제했습니다');
          location.hash = '#/';
        });
      };
  }

  // ---------------- 상품 등록 / 수정 ----------------
  async function viewForm(id, presetCode = '') {
    state.view = 'form';
    let p = null;
    if (id) {
      const { data } = await sb.from('products').select('*').eq('id', id).maybeSingle();
      p = data;
      if (!p) return shell('list', `<div class="empty">상품을 찾을 수 없습니다</div>`);
      if (!canManage(p.store_id)) return shell('list', `<div class="empty">다른 매장 상품은 수정할 수 없습니다</div>`);
    }
    const me = state.me;
    const storeLocked = !p && !isAdmin();
    const curStore = p ? p.store_id : me.store_id || state.stores[0]?.id;
    const storeOptions = state.stores
      .map((s) => `<option value="${s.id}" ${s.id === curStore ? 'selected' : ''}>${esc(s.name)}</option>`)
      .join('');
    const soldLock = p && p.status === 'sold';

    shell(
      p ? 'list' : 'new',
      `<h1>${p ? '상품 수정' : '상품 등록'}</h1>
      <form class="form" id="pform" autocomplete="off">
        <label class="photo-pick ${p ? 'has' : ''}" id="pick" style="${p ? `background-image:url('${esc(photoUrl(p.photo_path))}')` : ''}">
          <input type="file" accept="image/*" capture="environment" id="file">
          <span id="pickLabel">${p ? '' : '📷 사진 찍기 / 선택'}</span>
        </label>
        <label class="field"><span>상품코드 *</span>
          <div class="row"><input type="text" name="code" required value="${esc(p?.code || presetCode)}" autocapitalize="characters">
          ${p ? '' : '<button type="button" class="btn" id="autoCode">자동</button>'}</div>
          <div class="hint">태그에 붙인 코드를 입력하거나 [자동]을 누르세요. 바코드 스캐너도 됩니다.</div>
        </label>
        <label class="field"><span>상품명</span><input type="text" name="name" value="${esc(p?.name || '')}" placeholder="예: 리바이스 501 32인치"></label>
        <label class="field"><span>가격 (원)</span><input type="text" inputmode="numeric" name="price" value="${p?.price ?? ''}"></label>
        <label class="field"><span>매장</span>
          <select name="store_id" ${storeLocked || soldLock ? 'disabled' : ''}>${storeOptions}</select>
          ${soldLock ? '<div class="hint">판매완료 상품은 매장을 옮길 수 없습니다</div>' : ''}
        </label>
        <label class="field"><span>메모</span><textarea name="memo" placeholder="사이즈, 상태, 위치 등">${esc(p?.memo || '')}</textarea></label>
        <div class="err" id="ferr"></div>
        <button class="btn primary block" id="saveBtn">${p ? '저장' : '등록하기'}</button>
        ${p ? `<p style="text-align:center"><a href="#/p/${p.id}">취소</a></p>` : ''}
      </form>`
    );

    const form = $('#pform');
    let photo = null;
    $('#file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $('#pickLabel').textContent = '사진 처리 중…';
      try {
        photo = await preparePhoto(file);
        const pick = $('#pick');
        pick.style.backgroundImage = `url('${URL.createObjectURL(photo.thumb)}')`;
        pick.classList.add('has');
        $('#pickLabel').textContent = '';
      } catch (err) {
        $('#pickLabel').textContent = errText(err);
      }
    };
    const auto = $('#autoCode');
    const fillCode = async () => {
      const { data, error } = await sb.rpc('suggest_code');
      if (!error) form.code.value = data;
    };
    if (auto) {
      auto.onclick = fillCode;
      if (!presetCode) fillCode();
    }

    form.onsubmit = async (e) => {
      e.preventDefault();
      $('#ferr').textContent = '';
      if (!p && !photo) return ($('#ferr').textContent = '상품 사진을 넣어주세요');
      const price = form.price.value.replace(/[^0-9]/g, '');
      const fields = {
        p_code: form.code.value,
        p_name: form.name.value,
        p_price: price === '' ? null : Number(price),
        p_memo: form.memo.value,
        p_store_id: Number(form.store_id.value),
      };
      await busy($('#saveBtn'), async () => {
        let uploaded = null;
        try {
          if (photo) uploaded = await uploadPhoto(photo);
          if (p) {
            const { data: oldPaths, error } = await sb.rpc('update_product', {
              p_id: p.id,
              ...fields,
              p_photo_path: uploaded?.photo_path ?? null,
              p_thumb_path: uploaded?.thumb_path ?? null,
            });
            if (error) throw error;
            await removePhotos(oldPaths);
            toast('저장했습니다');
            location.hash = `#/p/${p.id}`;
          } else {
            const { data: newId, error } = await sb.rpc('create_product', {
              ...fields,
              p_photo_path: uploaded.photo_path,
              p_thumb_path: uploaded.thumb_path,
            });
            if (error) throw error;
            toast(`${normCode(fields.p_code)} 등록 완료 · 상세 화면에서 [라벨 출력] 가능`);
            location.hash = `#/p/${newId}`;
          }
        } catch (err) {
          if (uploaded) await removePhotos([uploaded.photo_path, uploaded.thumb_path]);
          $('#ferr').textContent = errText(err);
        }
      });
    };
  }

  // ---------------- 관리자 ----------------
  async function invokeAdmin(body) {
    const { data, error } = await sb.functions.invoke(CFG.ADMIN_FUNCTION || 'admin-users', { body });
    if (error) {
      let msg = error.message;
      try {
        const j = await error.context.json();
        if (j?.error) msg = j.error;
      } catch {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function viewAdmin() {
    state.view = 'admin';
    if (!isAdmin()) return shell('admin', `<div class="empty">관리자만 볼 수 있습니다</div>`);
    await Promise.all([loadStores(), loadPeople()]);
    const users = Object.values(state.people).filter((u) => !u.deleted_at).sort(
      (a, b) => {
        const order = { super: 0, admin: 1, manager: 2, cashier: 3 };
        return order[a.role] - order[b.role] || a.username.localeCompare(b.username);
      }
    );
    const storeOpts = (sel) =>
      state.stores.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

    shell(
      'admin',
      `<h1>관리자</h1>
      <h2>직원 계정</h2>
      <div class="table-wrap"><table>
        <tr><th>아이디</th><th>이름</th><th>권한</th><th>매장</th><th>상태</th><th></th></tr>
        ${users
          .map(
            (u) => `<tr class="${u.active ? '' : 'inactive'}">
            <td>${esc(u.username)}</td><td>${esc(u.name)}</td>
            <td>${ROLE_LABEL[u.role] || u.role}</td>
            <td>${needsStore(u.role) ? esc(storeName(u.store_id)) : '전체'}</td>
            <td>${u.active ? '사용중' : '정지'}</td>
            <td>${u.role === 'super' && !isSuper() ? '' : `<button class="btn small" data-edit="${u.id}">수정</button>`}</td></tr>`
          )
          .join('')}
      </table></div>

      <h2>새 계정 만들기</h2>
      <form class="card form" id="newUser" autocomplete="off">
        <div class="row">
          <label class="field"><span>아이디 (영문/숫자)</span><input type="text" name="username" autocapitalize="none" required></label>
          <label class="field"><span>이름</span><input type="text" name="name" required placeholder="예: 김실장"></label>
        </div>
        <div class="row">
          <label class="field"><span>권한</span><select name="role"><option value="manager">실장</option><option value="cashier">캐셔 (판매·정산만)</option><option value="admin">관리자</option></select></label>
          <label class="field"><span>소속 매장</span><select name="store_id">${storeOpts(state.stores[0]?.id)}</select></label>
        </div>
        <label class="field"><span>초기 비밀번호 (6자 이상)</span><input type="text" name="password" required minlength="6"></label>
        <div class="err" id="uerr"></div>
        <button class="btn primary">계정 만들기</button>
      </form>

      <div id="adminPromo"></div>

      <h2>매장</h2>
      <div class="card">
        ${state.stores
          .map(
            (s) => `<div class="row" style="margin-bottom:8px"><span>${esc(s.name)} <small class="hint">재고 ${s.available}</small></span>
            <span style="flex:none;display:flex;gap:6px"><button class="btn small" data-joinqr="${s.id}">📱 회원가입 QR</button>
            <button class="btn small" data-rename="${s.id}">매장 정보 / 영수증 설정</button></span></div>`
          )
          .join('')}
        <button class="btn" id="addStore" style="margin-top:6px">+ 매장 추가</button>
      </div>`
    );

    const nf = $('#newUser');
    nf.role.onchange = () => (nf.store_id.disabled = !needsStore(nf.role.value));
    nf.onsubmit = async (e) => {
      e.preventDefault();
      $('#uerr').textContent = '';
      await busy($('button', nf), async () => {
        try {
          await invokeAdmin({
            action: 'create',
            username: nf.username.value,
            name: nf.name.value,
            role: nf.role.value,
            store_id: Number(nf.store_id.value),
            password: nf.password.value,
          });
          toast(`${nf.username.value} 계정을 만들었습니다`);
          viewAdmin();
        } catch (err) {
          $('#uerr').textContent = errText(err);
        }
      });
    };

    root.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editUser(state.people[b.dataset.edit], storeOpts)));
    root.querySelectorAll('[data-rename]').forEach(
      (b) =>
        (b.onclick = () => editStore(Number(b.dataset.rename)))
    );
    renderAdminPromo();
    root.querySelectorAll('[data-joinqr]').forEach((b) => (b.onclick = () => showJoinQr(Number(b.dataset.joinqr))));
    $('#addStore').onclick = async () => {
      const name = await promptBox('매장 추가', '매장 이름', `${state.stores.length + 1}호점`);
      if (!name || !name.trim()) return;
      const { error } = await sb.from('stores').insert({ name: name.trim() });
      if (error) return toast(/duplicate/i.test(error.message) ? '이미 있는 매장 이름입니다' : errText(error), 'error');
      viewAdmin();
    };
  }

  // ---------------- 관리자: 포인트 설정 · 쿠폰 ----------------
  async function renderAdminPromo() {
    const box = $('#adminPromo');
    if (!box) return;
    await loadSettings();
    const st = state.settings;
    const { data: coupons } = await sb.from('coupons').select('*').order('created_at', { ascending: false });
    const today = kstToday();
    const couponState = (c) =>
      !c.active
        ? '중지'
        : c.ends_on && today > c.ends_on
          ? '기간 끝'
          : c.starts_on && today < c.starts_on
            ? '시작 전'
            : c.max_uses != null && c.used_count >= c.max_uses
              ? '소진'
              : '사용 가능';
    box.innerHTML = `
      <h2>포인트 설정</h2>
      <div class="card form">
        <label style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><input type="checkbox" id="psOn" ${st.points_enabled ? 'checked' : ''}> 포인트 사용 (회원 적립·사용)</label>
        <div class="row">
          <label class="field"><span>적립률 (결제금액의 %, 소수점 가능)</span><input type="text" inputmode="decimal" id="psRate" value="${Number(st.point_rate)}" placeholder="예: 0.5, 1, 2.5">
            <span class="rate-quick">${[0.5, 1, 2, 2.5, 3, 5].map((r) => `<button type="button" class="btn small" data-rate="${r}">${r}%</button>`).join('')}</span></label>
          <label class="field"><span>최소 사용 포인트</span><input type="text" inputmode="numeric" id="psMin" value="${st.point_min_use}"></label>
          <label class="field"><span>가입 축하 포인트 (QR 가입)</span><input type="text" inputmode="numeric" id="psJoin" value="${st.join_points ?? 0}"></label>
        </div>
        <p class="hint" style="margin-top:0">1P = 1원. 쿠폰·할인을 뺀 실제 결제 금액 기준으로 적립됩니다. 영수증을 취소하면 적립은 회수되고 사용한 포인트는 돌려줍니다.</p>
        <button class="btn" id="psSave">저장</button>
      </div>

      <div class="row" style="margin:22px 0 10px"><h2 style="margin:0">쿠폰</h2><span></span><button class="btn small primary" id="cpNew">+ 새 쿠폰</button></div>
      ${
        (coupons || []).length
          ? `<div class="table-wrap"><table>
          <tr><th>코드</th><th>이름</th><th>할인</th><th>최소 결제</th><th>기간</th><th>사용</th><th>상태</th><th></th></tr>
          ${coupons
            .map(
              (c) => `<tr class="${couponState(c) === '사용 가능' ? '' : 'muted'}"><td><b>${esc(c.code)}</b></td><td>${esc(c.name)}${
                c.member_only ? ' <span class="pay card">회원전용</span>' : ''
              }</td>
              <td>${c.kind === 'amount' ? won(c.value) : `${c.value}%`}</td><td>${c.min_total ? won(c.min_total) : '-'}</td>
              <td>${c.starts_on || c.ends_on ? `${c.starts_on ? fmtDate(c.starts_on) : ''} ~ ${c.ends_on ? fmtDate(c.ends_on) : ''}` : '제한 없음'}</td>
              <td>${c.used_count}${c.max_uses != null ? ` / ${c.max_uses}` : '회'}</td><td>${couponState(c)}</td>
              <td style="display:flex;gap:4px"><button class="btn small" data-cp="${c.id}">수정</button>${
                couponState(c) === '사용 가능' || couponState(c) === '시작 전' ? `<button class="btn small primary" data-send="${c.id}">회원에게 보내기</button>` : ''
              }</td></tr>`
            )
            .join('')}</table></div>`
          : '<div class="card hint">아직 쿠폰이 없습니다. [+ 새 쿠폰]으로 만들면 계산대에서 코드를 입력해 쓸 수 있습니다.</div>'
      }`;
    $('#psSave').onclick = (e) =>
      busy(e.target, async () => {
        const { error } = await sb.rpc('set_point_settings', {
          p_enabled: $('#psOn').checked,
          p_rate: Math.round((Number(String($('#psRate').value).replace(',', '.').replace(/[^0-9.]/g, '')) || 0) * 100) / 100,
          p_min_use: numVal($('#psMin').value) ?? 0,
          p_join_points: numVal($('#psJoin').value) ?? 0,
        });
        if (error) return toast(errText(error), 'error');
        toast('포인트 설정을 저장했습니다');
        loadSettings();
      });
    box.querySelectorAll('[data-rate]').forEach((b) => (b.onclick = () => ($('#psRate').value = b.dataset.rate)));
    $('#cpNew').onclick = () => editCoupon(null);
    box.querySelectorAll('[data-cp]').forEach((b) => (b.onclick = () => editCoupon(coupons.find((c) => c.id === Number(b.dataset.cp)))));
    box.querySelectorAll('[data-send]').forEach((b) => (b.onclick = () => sendCouponDialog(coupons.find((c) => c.id === Number(b.dataset.send)))));
  }

  function editCoupon(c) {
    const v = (k, d = '') => esc(c?.[k] ?? d);
    modal(
      `<h3>${c ? '쿠폰 수정' : '새 쿠폰'}</h3>
      <div class="row">
        <label class="field"><span>쿠폰 코드 *</span><input type="text" name="code" value="${v('code')}" placeholder="예: WELCOME5" autocapitalize="characters"></label>
        <label class="field"><span>이름 *</span><input type="text" name="name" value="${v('name')}" placeholder="예: 신규가입 5천원"></label>
      </div>
      <div class="row">
        <label class="field"><span>할인 방식</span><select name="kind">
          <option value="amount" ${c?.kind !== 'percent' ? 'selected' : ''}>정액 (원)</option>
          <option value="percent" ${c?.kind === 'percent' ? 'selected' : ''}>정률 (%)</option></select></label>
        <label class="field"><span>할인 값 *</span><input type="text" inputmode="numeric" name="value" value="${v('value')}" placeholder="5000 또는 10"></label>
      </div>
      <label class="field"><span>최소 결제 금액 (원)</span><input type="text" inputmode="numeric" name="min_total" value="${v('min_total', 0)}"></label>
      <div class="row">
        <label class="field"><span>시작일 (비우면 바로)</span><input type="date" name="starts_on" value="${v('starts_on')}"></label>
        <label class="field"><span>종료일 (비우면 무기한)</span><input type="date" name="ends_on" value="${v('ends_on')}"></label>
      </div>
      <label class="field"><span>최대 사용 횟수 (비우면 무제한)</span><input type="text" inputmode="numeric" name="max_uses" value="${v('max_uses')}"></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${c?.active === false ? '' : 'checked'}> 사용 가능</label>
      <label style="display:flex;gap:8px;align-items:flex-start;margin-top:8px"><input type="checkbox" name="member_only" ${c?.member_only ? 'checked' : ''} style="margin-top:3px">
        <span>회원 전용 (발급받은 회원만 사용)<br><small class="hint">켜면 코드를 입력해도 쓸 수 없고, [회원에게 보내기]로 발급받은 회원만 계산대에서 쓸 수 있습니다. 코드가 퍼져도 남용되지 않습니다.</small></span></label>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>닫기</button><button class="btn primary" data-ok>저장</button></div>`,
      (bg, close) => {
        const g = (n) => $(`[name=${n}]`, bg);
        $('[data-x]', bg).onclick = () => close();
        $('[data-ok]', bg).onclick = (e) =>
          busy(e.target, async () => {
            const { error } = await sb.rpc('save_coupon', {
              p_id: c?.id ?? null,
              p_code: g('code').value,
              p_name: g('name').value,
              p_kind: g('kind').value,
              p_value: numVal(g('value').value) ?? 0,
              p_min_total: numVal(g('min_total').value) ?? 0,
              p_starts_on: g('starts_on').value || null,
              p_ends_on: g('ends_on').value || null,
              p_max_uses: numVal(g('max_uses').value),
              p_active: g('active').checked,
              p_member_only: g('member_only').checked,
            });
            if (error) return ($('[data-err]', bg).textContent = errText(error));
            close();
            toast('쿠폰을 저장했습니다');
            renderAdminPromo();
          });
      }
    );
  }

  // 쿠폰 할인 문구 (예: 5,000원 할인 / 10% 할인)
  const couponValueText = (c) => (c.kind === 'amount' ? `${won(c.value)} 할인` : `${c.value}% 할인`);

  async function sendCouponDialog(c) {
    const [{ count: mkCount }, { count: allCount }] = await Promise.all([
      sb.from('members').select('id', { count: 'exact', head: true }).eq('marketing_agreed', true),
      sb.from('members').select('id', { count: 'exact', head: true }),
    ]);
    const defExp = c.ends_on || shiftDate(kstToday(), 30);
    modal(
      `<h3>"${esc(c.name)}" 회원에게 보내기</h3>
      <p class="hint" style="margin-top:0">회원 계정에 쿠폰이 들어가고, 계산할 때 회원을 선택하면 보유 쿠폰으로 바로 쓸 수 있습니다.</p>
      <div class="send-target">
        <label><input type="radio" name="tg" value="marketing" checked> 문자 수신 동의 회원 <b>${Number(mkCount || 0).toLocaleString('ko-KR')}명</b></label>
        <label><input type="radio" name="tg" value="all"> 전체 회원 <b>${Number(allCount || 0).toLocaleString('ko-KR')}명</b>
          <small class="hint">(문자 안내는 동의 회원에게만)</small></label>
      </div>
      <label class="field"><span>사용 기한 (이 날까지)</span><input type="date" id="scExp" value="${defExp}"></label>
      <p class="hint">이미 이 쿠폰을 갖고 있고 아직 안 쓴 회원은 건너뜁니다.</p>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>닫기</button><button class="btn primary" data-ok>쿠폰 발급</button></div>`,
      (bg, close) => {
        $('[data-x]', bg).onclick = () => close();
        $('[data-ok]', bg).onclick = (e) =>
          busy(e.target, async () => {
            const target = bg.querySelector('[name=tg]:checked').value;
            const exp = $('#scExp', bg).value || null;
            const { data, error } = await sb.rpc('issue_coupons', { p_coupon_id: c.id, p_target: target, p_member_ids: null, p_expires_on: exp });
            if (error) return ($('[data-err]', bg).textContent = errText(error));
            close();
            couponMessageDialog(c, data);
          });
      }
    );
  }

  // 발급 후 안내 문자 만들기 (문자 앱/발송 사이트에 붙여넣기)
  async function couponMessageDialog(c, result) {
    const { data: st } = await sb.from('stores').select('name, biz_name, phone').order('id').limit(1).maybeSingle();
    const shop = st?.biz_name || st?.name || 'VINTAGE';
    const exp = result?.expires_on ? fmtDate(result.expires_on) : '';
    const text = [
      `(광고) [${shop}]`,
      `${c.name} 쿠폰이 도착했어요!`,
      `▶ ${couponValueText(c)}${c.min_total ? ` (${won(c.min_total)} 이상 구매 시)` : ''}`,
      exp ? `▶ 사용 기한: ${exp}까지` : '',
      `계산할 때 휴대폰 번호를 말씀해 주세요.`,
      `무료수신거부 ${st?.phone || '(전화번호 입력)'}`,
    ]
      .filter(Boolean)
      .join('\n');
    modal(
      `<h3>✅ ${Number(result?.issued || 0).toLocaleString('ko-KR')}명에게 발급했습니다</h3>
      ${result?.skipped ? `<p class="hint" style="margin-top:0">이미 갖고 있는 ${result.skipped}명은 건너뛰었습니다.</p>` : ''}
      <label class="field"><span>안내 문자 (고쳐서 쓰셔도 됩니다)</span><textarea id="smsText" style="min-height:170px">${esc(text)}</textarea></label>
      <p class="hint">광고 문자는 <b>(광고)</b>로 시작하고 <b>무료 수신거부 방법</b>을 넣어야 합니다. 밤 9시~아침 8시 발송은 별도 동의가 필요합니다.</p>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn" data-x>닫기</button>
        <button class="btn" data-copytext>📋 문자 내용 복사</button>
        <button class="btn primary" data-copynums>📋 받는 번호 복사</button>
      </div>`,
      (bg, close) => {
        $('[data-x]', bg).onclick = () => close();
        const copy = async (value, okMsg) => {
          try {
            await navigator.clipboard.writeText(value);
            toast(okMsg);
          } catch {
            promptBox('복사', '아래 내용을 복사하세요', value, '닫기');
          }
        };
        $('[data-copytext]', bg).onclick = () => copy($('#smsText', bg).value, '문자 내용을 복사했습니다');
        $('[data-copynums]', bg).onclick = (e) =>
          busy(e.target, async () => {
            // 이 쿠폰을 갖고 있는(미사용) 회원 중 문자 수신 동의자만
            const holders = new Set();
            for (let from = 0; from < 50000; from += 1000) {
              const { data } = await sb.from('member_coupons').select('member_id').eq('coupon_id', c.id).eq('status', 'issued').range(from, from + 999);
              (data || []).forEach((r) => holders.add(r.member_id));
              if (!data || data.length < 1000) break;
            }
            const list = (await fetchAllMembers(true)).filter((m) => holders.has(m.id));
            await copy(list.map((m) => fmtPhone(m.phone)).join('\n'), `문자 수신 동의 회원 ${list.length}명 번호를 복사했습니다`);
          });
      }
    );
  }

  // 회원이 가진 사용 가능 쿠폰
  async function fetchMemberCoupons(memberId) {
    const { data } = await sb
      .from('member_coupons')
      .select('id, expires_on, coupons(id, code, name, kind, value, min_total, active, starts_on)')
      .eq('member_id', memberId)
      .eq('status', 'issued')
      .order('issued_at', { ascending: false });
    const today = kstToday();
    return (data || []).filter(
      (r) => r.coupons && r.coupons.active && (!r.expires_on || r.expires_on >= today) && (!r.coupons.starts_on || r.coupons.starts_on <= today)
    );
  }

  // ---------------- 회원 ----------------
  // 회원 전체 가져오기 (문자 수신 동의 목록 내보내기용, 1000명씩 나눠서)
  async function fetchAllMembers(onlyMarketing) {
    const all = [];
    for (let from = 0; from < 50000; from += 1000) {
      let qb = sb.from('members').select('*').order('created_at', { ascending: true }).range(from, from + 999);
      if (onlyMarketing) qb = qb.eq('marketing_agreed', true);
      const { data, error } = await qb;
      if (error) throw error;
      all.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return all;
  }

  async function lastPurchases(ids) {
    const map = {};
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await sb
        .from('sales')
        .select('member_id, created_at')
        .in('member_id', ids.slice(i, i + 200))
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(5000);
      for (const r of data || []) if (!map[r.member_id]) map[r.member_id] = r.created_at;
    }
    return map;
  }

  async function viewMembers() {
    state.view = 'members';
    const f = { marketing: false };
    shell(
      'members',
      `<div class="row" style="margin-bottom:12px"><h1 style="margin:0">회원</h1><span></span><button class="btn primary" id="mNew">+ 회원 등록</button></div>
      <div class="toolbar">
        <input type="search" class="search" id="mQ" placeholder="전화번호 또는 이름 검색" autocomplete="off">
        <div class="seg" id="mSeg"><button data-f="all" class="active">전체</button><button data-f="mk">📩 문자 수신 동의만</button></div>
      </div>
      <div id="mBar"></div>
      <div id="mList"></div>`
    );
    const q = $('#mQ');
    let t;
    const renderBar = async () => {
      const bar = $('#mBar');
      if (!f.marketing) return (bar.innerHTML = '');
      const { count } = await sb.from('members').select('id', { count: 'exact', head: true }).eq('marketing_agreed', true);
      if (state.view !== 'members') return;
      bar.innerHTML = `<div class="mk-bar">
        <div><b>문자 수신 동의 회원 ${Number(count || 0).toLocaleString('ko-KR')}명</b>
          <div class="hint">광고 문자는 이 회원들에게만 보내세요. 문자 앞에 <b>(광고)</b>, 끝에 <b>무료 수신거부 방법</b>을 넣어야 하고, 밤 9시~아침 8시 발송은 별도 동의가 필요합니다.</div></div>
        <div class="mk-actions"><button class="btn small" id="mkCopy">📋 번호 복사</button><button class="btn small" id="mkCsv">엑셀(CSV) 받기</button></div>
      </div>`;
      $('#mkCopy').onclick = (e) =>
        busy(e.target, async () => {
          const list = await fetchAllMembers(true);
          const text = list.map((m) => fmtPhone(m.phone)).join('\n');
          try {
            await navigator.clipboard.writeText(text);
            toast(`${list.length}명 번호를 복사했습니다. 문자 발송 사이트에 붙여넣으세요`);
          } catch {
            modal(
              `<h3>번호 ${list.length}개</h3><p class="hint">아래를 전부 선택해서 복사하세요</p><textarea style="min-height:240px">${esc(text)}</textarea>
               <div class="row"><button class="btn" data-x>닫기</button></div>`,
              (bg, close) => {
                $('textarea', bg).select();
                $('[data-x]', bg).onclick = () => close();
              }
            );
          }
        });
      $('#mkCsv').onclick = (e) =>
        busy(e.target, async () => {
          const list = await fetchAllMembers(true);
          const last = await lastPurchases(list.map((m) => m.id));
          const head = ['이름', '휴대폰', '포인트', '가입일', '가입 경로', '수신 동의일', '마지막 구매일', '메모'];
          const d = (v) => (v ? new Date(v).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '');
          const lines = list.map((m) =>
            [m.name, fmtPhone(m.phone), m.points, d(m.created_at), m.join_source === 'qr' ? 'QR' : '직원', d(m.marketing_agreed_at), d(last[m.id]), m.memo]
              .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
              .join(',')
          );
          const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `members_sms_${kstToday()}.csv`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        });
    };
    const load = async () => {
      const v = q.value.trim();
      const digits = v.replace(/[^0-9]/g, '');
      const term = v.replace(/[,()%*\\]/g, ' ').trim();
      let qb = sb.from('members').select('*').order('created_at', { ascending: false }).limit(200);
      if (v) qb = digits.length >= 3 ? qb.like('phone', `%${digits}%`) : qb.ilike('name', `%${term}%`);
      if (f.marketing) qb = qb.eq('marketing_agreed', true);
      const { data, error } = await qb;
      if (state.view !== 'members') return;
      if (error) return toast(errText(error), 'error');
      $('#mList').innerHTML = (data || []).length
        ? `<div class="table-wrap"><table><tr><th>이름</th><th>전화번호</th><th>포인트</th><th>가입일</th><th>가입</th><th>문자 수신</th><th>메모</th></tr>
          ${data
            .map(
              (m) => `<tr class="click" data-m="${m.id}"><td><b>${esc(m.name || '-')}</b></td><td>${esc(fmtPhone(m.phone))}</td>
              <td>${Number(m.points).toLocaleString('ko-KR')}P</td><td>${fmtDate(String(m.created_at).slice(0, 10))}</td>
              <td>${m.join_source === 'qr' ? '📱 QR' : '직원'}</td>
              <td>${m.marketing_agreed ? `<span class="pay cash">동의</span>${m.marketing_agreed_at ? ` <small class="hint">${fmtDate(String(m.marketing_agreed_at).slice(0, 10))}</small>` : ''}` : '-'}</td>
              <td style="white-space:normal">${esc(m.memo)}</td></tr>`
            )
            .join('')}</table></div>${data.length === 200 ? '<p class="hint">최근 200명까지 표시됩니다. 검색으로 찾아보세요. (번호 복사·엑셀은 전체가 들어갑니다)</p>' : ''}`
        : `<div class="empty">${f.marketing ? '문자 수신에 동의한 회원이 없습니다' : '회원이 없습니다'}</div>`;
      root.querySelectorAll('[data-m]').forEach((r) => (r.onclick = () => memberDetail(Number(r.dataset.m), load)));
    };
    q.oninput = () => {
      clearTimeout(t);
      t = setTimeout(load, 300);
    };
    $('#mSeg')
      .querySelectorAll('button')
      .forEach(
        (b) =>
          (b.onclick = () => {
            f.marketing = b.dataset.f === 'mk';
            $('#mSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
            renderBar();
            load();
          })
      );
    $('#mNew').onclick = () => memberEdit(null, load);
    load();
  }

  function memberEdit(m, after) {
    modal(
      `<h3>${m ? '회원 정보 수정' : '회원 등록'}</h3>
      <label class="field"><span>전화번호 *</span><input type="text" inputmode="tel" name="phone" value="${esc(m ? fmtPhone(m.phone) : '')}" placeholder="010-0000-0000"></label>
      <label class="field"><span>이름</span><input type="text" name="name" value="${esc(m?.name || '')}"></label>
      <label class="field"><span>메모 (선호 스타일, 사이즈 등)</span><textarea name="memo">${esc(m?.memo || '')}</textarea></label>
      <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px"><input type="checkbox" name="marketing" ${m?.marketing_agreed ? 'checked' : ''} style="margin-top:3px">
        <span>문자(광고) 수신 동의<br><small class="hint">고객에게 직접 동의를 받은 경우에만 체크하세요. 수신 거부 요청이 오면 체크를 해제하세요.${
          m?.marketing_agreed_at ? ` (동의일 ${fmtDate(String(m.marketing_agreed_at).slice(0, 10))})` : ''
        }</small></span></label>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>닫기</button><button class="btn primary" data-ok>저장</button></div>`,
      (bg, close) => {
        const g = (n) => $(`[name=${n}]`, bg);
        $('[data-x]', bg).onclick = () => close();
        $('[data-ok]', bg).onclick = (e) =>
          busy(e.target, async () => {
            const { error } = await sb.rpc('save_member', {
              p_id: m?.id ?? null,
              p_name: g('name').value,
              p_phone: g('phone').value,
              p_memo: g('memo').value,
              p_marketing: g('marketing').checked,
            });
            if (error) return ($('[data-err]', bg).textContent = errText(error));
            close();
            toast('저장했습니다');
            after?.();
          });
      }
    );
  }

  async function memberDetail(id, after) {
    const [{ data: m }, { data: ledger }, { data: sales }, { data: mcs }] = await Promise.all([
      sb.from('members').select('*').eq('id', id).maybeSingle(),
      sb.from('member_coupons').select('id, status, expires_on, issued_at, used_at, coupons(name, kind, value, min_total)').eq('member_id', id).order('issued_at', { ascending: false }).limit(50),
      sb.from('point_ledger').select('*').eq('member_id', id).order('created_at', { ascending: false }).limit(100),
      sb.from('sales').select('id, receipt_no, created_at, total, status, store_id, item_count').eq('member_id', id).order('created_at', { ascending: false }).limit(100),
    ]);
    if (!m) return toast('회원을 찾을 수 없습니다', 'error');
    const canEdit = !isCashier();
    modal(
      `<h3>${esc(m.name || '이름없음')} <small class="hint">${esc(fmtPhone(m.phone))}</small></h3>
      <div class="cash-total"><span>보유 포인트</span><b>${Number(m.points).toLocaleString('ko-KR')}P</b></div>
      ${m.memo ? `<p style="white-space:pre-wrap">${esc(m.memo)}</p>` : ''}
      <div class="row" style="flex-wrap:wrap">
        ${canEdit ? '<button class="btn small" data-edit>정보 수정</button><button class="btn small" data-adj>포인트 조정</button>' : ''}
        ${isAdmin() ? '<button class="btn small danger" data-del>회원 삭제</button>' : ''}<span></span>
      </div>
      <h2>쿠폰</h2>
      ${
        (mcs || []).length
          ? `<div class="mp-list">${mcs
              .map((r) => {
                const expired = r.status === 'issued' && r.expires_on && r.expires_on < kstToday();
                const label = r.status === 'used' ? '사용함' : r.status === 'revoked' ? '회수됨' : expired ? '기간 지남' : '보유 중';
                return `<div class="mp-row static ${r.status !== 'issued' || expired ? 'cancelled' : ''}"><span>${esc(r.coupons?.name || '-')}</span>
                  <span>${r.coupons ? couponValueText(r.coupons) : ''}${r.expires_on ? ` · ~${fmtDate(r.expires_on)}` : ''}</span>
                  <span class="pts">${label}${
                    isAdmin() && r.status === 'issued' ? ` <button class="btn small" data-revoke="${r.id}">회수</button>` : ''
                  }</span></div>`;
              })
              .join('')}</div>`
          : '<p class="hint">받은 쿠폰이 없습니다</p>'
      }
      <h2>구매 내역</h2>
      ${
        (sales || []).length
          ? `<div class="mp-list">${sales
              .map(
                (r) => `<button class="mp-row ${r.status}" data-sale="${r.id}"><span>${fmt(r.created_at)}</span><span>${esc(storeName(r.store_id))} · ${r.item_count}점</span>
                <span class="pts">${won(r.total)}${r.status === 'cancelled' ? ' (취소)' : ''}</span></button>`
              )
              .join('')}</div>`
          : '<p class="hint">구매 내역이 없습니다</p>'
      }
      <h2>포인트 내역</h2>
      ${
        (ledger || []).length
          ? `<div class="mp-list">${ledger
              .map(
                (l) => `<div class="mp-row static"><span>${fmt(l.created_at)}</span><span>${esc(l.reason)}</span>
                <span class="pts ${l.delta < 0 ? 'neg' : ''}">${l.delta > 0 ? '+' : ''}${Number(l.delta).toLocaleString('ko-KR')}P</span></div>`
              )
              .join('')}</div>`
          : '<p class="hint">포인트 내역이 없습니다</p>'
      }
      <div class="row" style="margin-top:12px"><button class="btn" data-x>닫기</button></div>`,
      (bg, close) => {
        $('[data-x]', bg).onclick = () => close();
        bg.querySelectorAll('[data-revoke]').forEach(
          (b) =>
            (b.onclick = async () => {
              const { error } = await sb.rpc('revoke_member_coupon', { p_id: Number(b.dataset.revoke) });
              if (error) return toast(errText(error), 'error');
              toast('쿠폰을 회수했습니다');
              close();
              memberDetail(id, after);
            })
        );
        bg.querySelectorAll('[data-sale]').forEach(
          (b) =>
            (b.onclick = () => {
              close();
              openReceipt(Number(b.dataset.sale), after);
            })
        );
        const ed = $('[data-edit]', bg);
        if (ed)
          ed.onclick = () => {
            close();
            memberEdit(m, after);
          };
        const adj = $('[data-adj]', bg);
        if (adj)
          adj.onclick = async () => {
            close();
            const v = await promptBox('포인트 조정', '더할 포인트 (빼려면 -1000 처럼 입력)', '', '다음');
            if (v === null) return;
            const delta = Number(String(v).replace(/[^0-9-]/g, ''));
            if (!delta) return toast('포인트를 입력하세요', 'error');
            const reason = await promptBox('포인트 조정 사유', '사유 (예: 이벤트, 오류 정정)', '', '조정');
            if (reason === null) return;
            const { error } = await sb.rpc('adjust_points', { p_member_id: m.id, p_delta: delta, p_reason: reason });
            if (error) return toast(errText(error), 'error');
            toast('포인트를 조정했습니다');
            after?.();
          };
        const del = $('[data-del]', bg);
        if (del)
          del.onclick = async () => {
            close();
            if (!(await confirmBox('회원 삭제', `<b>${esc(m.name || fmtPhone(m.phone))}</b> 회원을 삭제합니다. 포인트도 사라지며 되돌릴 수 없습니다. (구매 영수증은 남습니다)`, '삭제', 'sell'))) return;
            const { error } = await sb.rpc('delete_member', { p_member_id: m.id });
            if (error) return toast(errText(error), 'error');
            toast('회원을 삭제했습니다');
            after?.();
          };
      }
    );
  }

  // ---------------- 회원가입 QR ----------------
  async function showJoinQr(storeId) {
    if (!storeId) return toast('매장을 찾을 수 없습니다', 'error');
    await loadScript('./vendor/qrcode-generator-1.4.4.js');
    const { data: st, error } = await sb.from('stores').select('id, name, biz_name, join_token, join_poster').eq('id', storeId).maybeSingle();
    if (error || !st) return toast(errText(error || '매장을 찾을 수 없습니다'), 'error');
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}join.html?s=${st.join_token}`;
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
    const title = esc(st.biz_name || st.name);
    const jp = Number(state.settings?.join_points) || 0;
    modal(
      `<h3>${title} 회원가입 QR</h3>
      <div class="join-qr">${svg}</div>
      <p class="hint" style="text-align:center">손님이 휴대폰 카메라로 찍으면 가입 화면이 열립니다${jp ? ` · 가입 시 ${jp.toLocaleString('ko-KR')}P 적립` : ''}</p>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn" data-x>닫기</button>
        <button class="btn" data-copy>링크 복사</button>
        <button class="btn primary" data-print>🎨 안내문 꾸미기 / 인쇄</button>
      </div>
      ${
        isAdmin()
          ? `<div class="danger-zone"><button class="btn small danger" data-rotate>QR 새로 만들기</button>
             <p class="hint">QR이 밖으로 퍼져 장난 가입이 생기면 새로 만드세요. 예전 QR은 더 이상 쓸 수 없습니다.</p></div>`
          : ''
      }`,
      (bg, close) => {
        $('[data-x]', bg).onclick = () => close();
        $('[data-copy]', bg).onclick = async () => {
          try {
            await navigator.clipboard.writeText(url);
            toast('링크를 복사했습니다');
          } catch {
            promptBox('가입 링크', '아래 주소를 복사하세요', url, '닫기');
          }
        };
        $('[data-print]', bg).onclick = () => {
          close();
          posterEditor(st, svg);
        };
        const rot = $('[data-rotate]', bg);
        if (rot)
          rot.onclick = async () => {
            close();
            if (!(await confirmBox('QR 새로 만들기', '지금 붙어 있는 QR 안내문은 더 이상 쓸 수 없게 됩니다. 새 QR을 다시 인쇄해야 합니다.', '새로 만들기', 'sell'))) return;
            const { error: e2 } = await sb.rpc('rotate_join_token', { p_store_id: storeId });
            if (e2) return toast(errText(e2), 'error');
            toast('새 QR을 만들었습니다');
            showJoinQr(storeId);
          };
      }
    );
  }

  // ---------------- 가입 안내문 꾸미기 ----------------
  const POSTER_THEMES = {
    vintage: '빈티지 크림',
    black: '블랙',
    minimal: '미니멀 화이트',
    sage: '세이지 그린',
  };
  const POSTER_PAPERS = { A4: [210, 297], A5: [148, 210], A6: [105, 148] };

  function posterDefaults(st) {
    const jp = Number(state.settings?.join_points) || 0;
    const rate = Number(state.settings?.point_rate) || 0;
    return {
      theme: 'vintage',
      paper: 'A5',
      title: '회원가입하고\n포인트 받으세요',
      perk: jp ? `지금 가입하면 ${jp.toLocaleString('ko-KR')}P 바로 적립` : rate ? `구매 금액의 ${rate}% 포인트 적립` : '',
      steps: true,
      footer: '',
      ...(st.join_poster || {}),
    };
  }

  function posterHtml(st, svg, o) {
    const [w, h] = POSTER_PAPERS[o.paper] || POSTER_PAPERS.A5;
    const k = w / 148; // A5 기준 배율
    const name = esc(st.biz_name || st.name);
    return `<div class="poster pt-${esc(o.theme)}" style="width:${w}mm;height:${h}mm;--k:${k}">
      <div class="pt-frame">
        <div class="pt-top">
          <div class="pt-store">${name}</div>
          <div class="pt-rule"><span></span><i>MEMBERSHIP</i><span></span></div>
        </div>
        <div class="pt-title">${esc(o.title).replace(/\n/g, '<br>')}</div>
        ${o.perk ? `<div class="pt-perk">${esc(o.perk)}</div>` : ''}
        <div class="pt-qr">${svg}</div>
        ${
          o.steps
            ? `<div class="pt-steps"><div><b>1</b>카메라로<br>QR 찍기</div><div><b>2</b>이름·번호<br>입력</div><div><b>3</b>바로<br>적립 완료</div></div>`
            : '<div class="pt-how">휴대폰 카메라로 QR코드를 찍어주세요</div>'
        }
        ${o.footer ? `<div class="pt-foot">${esc(o.footer)}</div>` : ''}
      </div>
    </div>`;
  }

  function loadPosterFonts() {
    if (!document.getElementById('posterFonts')) {
      const l = document.createElement('link');
      l.id = 'posterFonts';
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&family=Noto+Sans+KR:wght@400;700;900&display=swap';
      document.head.appendChild(l);
    }
  }

  function posterEditor(st, svg) {
    loadPosterFonts();
    const o = posterDefaults(st);
    modal(
      `<h3>회원가입 안내문 꾸미기</h3>
      <div class="pe">
        <div class="pe-form">
          <label class="field"><span>테마</span><div class="seg pe-themes">${Object.entries(POSTER_THEMES)
            .map(([k, v]) => `<button type="button" data-theme="${k}" class="${o.theme === k ? 'active' : ''}">${v}</button>`)
            .join('')}</div></label>
          <label class="field"><span>제목 (줄바꿈 가능)</span><textarea id="peTitle" rows="2">${esc(o.title)}</textarea></label>
          <label class="field"><span>혜택 문구</span><input type="text" id="pePerk" value="${esc(o.perk)}" placeholder="예: 지금 가입하면 2,000P 적립"></label>
          <label class="field"><span>하단 문구 (인스타그램, 영업시간 등)</span><input type="text" id="peFoot" value="${esc(o.footer)}" placeholder="예: @siso_vintage"></label>
          <div class="row">
            <label class="field"><span>용지</span><select id="pePaper">${Object.keys(POSTER_PAPERS)
              .map((k) => `<option ${o.paper === k ? 'selected' : ''}>${k}</option>`)
              .join('')}</select></label>
            <label style="display:flex;gap:8px;align-items:center;margin-top:14px"><input type="checkbox" id="peSteps" ${o.steps ? 'checked' : ''}> 가입 순서 안내</label>
          </div>
          <p class="hint">인쇄 창에서 <b>배경 그래픽</b>을 켜고 배율 <b>100%</b>로 인쇄하세요. 대상에서 <b>PDF로 저장</b>을 고르면 파일로도 받을 수 있습니다.</p>
        </div>
        <div class="pe-preview"><div id="pePrev"></div></div>
      </div>
      <div class="err" data-err></div>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn" data-x>닫기</button>
        ${isAdmin() ? '<button class="btn" data-save>디자인 저장</button>' : ''}
        <button class="btn primary" data-print>🖨 인쇄</button>
      </div>`,
      (bg, close) => {
        bg.querySelector('.modal').classList.add('wide');
        const read = () => {
          o.title = $('#peTitle', bg).value;
          o.perk = $('#pePerk', bg).value.trim();
          o.footer = $('#peFoot', bg).value.trim();
          o.paper = $('#pePaper', bg).value;
          o.steps = $('#peSteps', bg).checked;
        };
        const render = () => {
          read();
          const prev = $('#pePrev', bg);
          prev.innerHTML = posterHtml(st, svg, o);
          const el = prev.firstElementChild;
          const box = prev.parentElement;
          const scale = Math.min(box.clientWidth / el.offsetWidth, 460 / el.offsetHeight, 1);
          el.style.transform = `scale(${scale})`;
          prev.style.height = `${el.offsetHeight * scale}px`;
          prev.style.width = `${el.offsetWidth * scale}px`;
        };
        bg.querySelectorAll('[data-theme]').forEach(
          (b) =>
            (b.onclick = () => {
              o.theme = b.dataset.theme;
              bg.querySelectorAll('[data-theme]').forEach((x) => x.classList.toggle('active', x === b));
              render();
            })
        );
        ['#peTitle', '#pePerk', '#peFoot'].forEach((sel) => ($(sel, bg).oninput = render));
        $('#pePaper', bg).onchange = render;
        $('#peSteps', bg).onchange = render;
        setTimeout(render, 30);
        (document.fonts?.ready || Promise.resolve()).then(() => setTimeout(render, 50));
        $('[data-x]', bg).onclick = () => close();
        const sv = $('[data-save]', bg);
        if (sv)
          sv.onclick = (e) =>
            busy(e.target, async () => {
              read();
              const { error } = await sb
                .from('stores')
                .update({ join_poster: { theme: o.theme, paper: o.paper, title: o.title, perk: o.perk, steps: o.steps, footer: o.footer } })
                .eq('id', st.id);
              if (error) return ($('[data-err]', bg).textContent = errText(error));
              st.join_poster = { ...o };
              toast('디자인을 저장했습니다. 다른 직원도 같은 디자인으로 인쇄합니다');
            });
        $('[data-print]', bg).onclick = async () => {
          read();
          document.getElementById('printArea')?.remove();
          document.getElementById('printPage')?.remove();
          const area = document.createElement('div');
          area.id = 'printArea';
          area.innerHTML = posterHtml(st, svg, o);
          document.body.appendChild(area);
          const [w, h] = POSTER_PAPERS[o.paper] || POSTER_PAPERS.A5;
          const stl = document.createElement('style');
          stl.id = 'printPage';
          stl.textContent = `@page { size: ${w}mm ${h}mm; margin: 0 }`;
          document.head.appendChild(stl);
          const cleanup = () => {
            area.remove();
            stl.remove();
            window.removeEventListener('afterprint', cleanup);
          };
          window.addEventListener('afterprint', cleanup);
          await Promise.race([document.fonts?.ready || Promise.resolve(), new Promise((r) => setTimeout(r, 1500))]);
          setTimeout(() => window.print(), 80);
        };
      }
    );
  }

  async function editStore(id) {
    const { data: st, error } = await sb.from('stores').select('*').eq('id', id).maybeSingle();
    if (error || !st) return toast(errText(error || '매장을 찾을 수 없습니다'), 'error');
    const f = (name, label, ph = '') =>
      `<label class="field"><span>${label}</span><input type="text" name="${name}" value="${esc(st[name] ?? '')}" placeholder="${esc(ph)}"></label>`;
    modal(
      `<h3>${esc(st.name)} 정보</h3>
      ${f('name', '매장 이름 *')}
      <p class="hint" style="margin:-6px 0 10px">아래는 영수증에 찍히는 정보입니다.</p>
      ${f('biz_name', '상호', st.name)}
      <div class="row">${f('biz_no', '사업자등록번호', '000-00-00000')}${f('owner_name', '대표자')}</div>
      ${f('address', '주소')}
      ${f('phone', '전화번호')}
      <label class="field"><span>영수증 하단 문구</span><textarea name="receipt_footer">${esc(st.receipt_footer)}</textarea></label>
      <details style="margin-bottom:12px"><summary class="hint">외부 연동 (준비)</summary>
        ${f('toss_merchant_id', '토스플레이스 가맹점 ID', '토스 연동 시 입력')}</details>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>닫기</button><button class="btn primary" data-ok>저장</button></div>`,
      (bg, close) => {
        $('[data-x]', bg).onclick = () => close();
        $('[data-ok]', bg).onclick = (e) =>
          busy(e.target, async () => {
            const v = (n) => $(`[name=${n}]`, bg).value.trim();
            if (!v('name')) return ($('[data-err]', bg).textContent = '매장 이름을 입력하세요');
            const upd = {};
            ['name', 'biz_name', 'biz_no', 'owner_name', 'address', 'phone', 'receipt_footer', 'toss_merchant_id'].forEach((n) => (upd[n] = v(n)));
            const { error: e2 } = await sb.from('stores').update(upd).eq('id', id);
            if (e2) return ($('[data-err]', bg).textContent = /duplicate/i.test(e2.message) ? '이미 있는 매장 이름입니다' : errText(e2));
            close();
            toast('저장했습니다');
            viewAdmin();
          });
      }
    );
  }

  function editUser(u, storeOpts) {
    modal(
      `<h3>${esc(u.username)} 수정</h3>
      <label class="field"><span>이름</span><input type="text" name="name" value="${esc(u.name)}"></label>
      <div class="row">
        <label class="field"><span>권한</span><select name="role" ${u.role === 'super' ? 'disabled' : ''}>
          ${u.role === 'super' ? '<option value="super" selected>총관리자</option>' : ''}
          <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>실장</option>
          <option value="cashier" ${u.role === 'cashier' ? 'selected' : ''}>캐셔</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>관리자</option></select></label>
        <label class="field"><span>매장</span><select name="store_id" ${!needsStore(u.role) ? 'disabled' : ''}>${storeOpts(u.store_id)}</select></label>
      </div>
      <label class="field"><span>새 비밀번호 (바꿀 때만)</span><input type="text" name="password" placeholder="비워두면 유지"></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> 사용 가능 (해제 시 로그인 정지 · 다시 켜면 복구)</label>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>닫기</button><button class="btn primary" data-ok>저장</button></div>
      ${
        ['manager', 'cashier'].includes(u.role) && u.id !== state.me.id
          ? `<div class="danger-zone"><button class="btn danger block" data-del>계정 삭제</button>
             <p class="hint">삭제하면 목록에서 사라지고 다시 로그인할 수 없습니다 (되돌릴 수 없음). 판매·등록 기록의 이름은 남습니다. 같은 아이디는 새로 만들 수 있습니다.</p></div>`
          : ''
      }`,
      (bg, close) => {
        const g = (n) => $(`[name=${n}]`, bg);
        g('role').onchange = () => (g('store_id').disabled = !needsStore(g('role').value));
        $('[data-x]', bg).onclick = () => close();
        const del = $('[data-del]', bg);
        if (del)
          del.onclick = async () => {
            close();
            const ok = await confirmBox(
              '계정 삭제',
              `<p><b>${esc(u.name)}</b> (${esc(u.username)}) 계정을 삭제합니다.</p><p class="hint">되돌릴 수 없습니다. 잠깐 쉬는 경우라면 삭제 대신 [사용 가능] 체크를 해제하세요.</p>`,
              '삭제',
              'sell'
            );
            if (!ok) return;
            try {
              await invokeAdmin({ action: 'delete', id: u.id });
              toast(`${u.username} 계정을 삭제했습니다`);
              viewAdmin();
            } catch (err) {
              toast(errText(err), 'error');
            }
          };
        $('[data-ok]', bg).onclick = (e) =>
          busy(e.target, async () => {
            try {
              await invokeAdmin({
                action: 'update',
                id: u.id,
                name: g('name').value,
                role: g('role').value,
                store_id: Number(g('store_id').value),
                active: g('active').checked,
                password: g('password').value || undefined,
              });
              close();
              toast('저장했습니다');
              viewAdmin();
            } catch (err) {
              $('[data-err]', bg).textContent = errText(err);
            }
          });
      }
    );
  }

  // ---------------- 내 정보 ----------------
  function viewAccount() {
    state.view = 'account';
    const me = state.me;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    shell(
      'account',
      `<h1>내 정보</h1>
      <div class="card form">
        <dl class="kv"><dt>아이디</dt><dd>${esc(me.username)}</dd><dt>이름</dt><dd>${esc(me.name)}</dd>
        <dt>권한</dt><dd>${ROLE_LABEL[me.role]}</dd>
        <dt>매장</dt><dd>${me.store_id ? esc(storeName(me.store_id)) : '전체'}</dd></dl>
        <button class="btn" id="logout">로그아웃</button>
      </div>

      <h2>비밀번호 변경</h2>
      <form class="card form" id="pw">
        <label class="field"><span>현재 비밀번호</span><input type="password" name="current" autocomplete="current-password" required></label>
        <label class="field"><span>새 비밀번호 (6자 이상)</span><input type="password" name="next" autocomplete="new-password" minlength="6" required></label>
        <div class="err" id="pwerr"></div>
        <button class="btn primary">변경</button>
      </form>

      <h2>앱으로 설치하기</h2>
      <div class="card form">
        ${
          standalone
            ? '<p>✅ 앱으로 실행 중입니다.</p>'
            : `<button class="btn primary" id="install2" ${installPrompt ? '' : 'hidden'}>이 기기에 앱 설치</button>
          <p class="hint" style="font-size:14px;line-height:1.7">
          <b>안드로이드 (크롬)</b>: 메뉴 ⋮ → <b>앱 설치</b> 또는 <b>홈 화면에 추가</b><br>
          <b>아이폰 (사파리)</b>: 공유 버튼 □↑ → <b>홈 화면에 추가</b><br>
          <b>PC (크롬/엣지)</b>: 주소창 오른쪽 설치 아이콘 ⊕ 클릭</p>`
        }
      </div>`
    );
    $('#logout').onclick = async () => {
      await sb.auth.signOut();
    };
    const i2 = $('#install2');
    if (i2) i2.onclick = doInstall;
    $('#pw').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      $('#pwerr').textContent = '';
      await busy($('button', f), async () => {
        const { data: u } = await sb.auth.getUser();
        const { error: e1 } = await sb.auth.signInWithPassword({ email: u.user.email, password: f.current.value });
        if (e1) return ($('#pwerr').textContent = '현재 비밀번호가 올바르지 않습니다');
        const { error: e2 } = await sb.auth.updateUser({ password: f.next.value });
        if (e2) return ($('#pwerr').textContent = errText(e2));
        f.reset();
        toast('비밀번호를 변경했습니다');
      });
    };
  }

  // ---------------- 이용관리 (총관리자 전용) ----------------
  const LICENSE_LABEL = { ok: '정상', warning: '곧 만료', grace: '만료 (유예기간)', expired: '사용 중지' };

  async function viewLicense() {
    state.view = 'license';
    if (!isSuper()) return shell('license', `<div class="empty">총관리자만 볼 수 있습니다</div>`);
    const [, { data: hist }] = await Promise.all([
      loadLicense(),
      sb.from('license_events').select('*').order('created_at', { ascending: false }).limit(50),
      loadPeople(),
    ]);
    const l = state.license;
    if (!l) return shell('license', `<div class="empty">이용기간 정보를 불러올 수 없습니다. schema.sql 을 최신으로 실행했는지 확인하세요</div>`);
    shell(
      'license',
      `<h1>이용관리</h1>
      <div class="card form">
        <dl class="kv">
          <dt>상태</dt><dd><span class="lic-badge ${l.state}">${LICENSE_LABEL[l.state]}</span></dd>
          <dt>사용 기한</dt><dd>${fmtDate(l.paid_until)}까지 ${
            l.days_left >= 0 ? `<span class="hint">(${l.days_left}일 남음)</span>` : `<span class="hint">(${-l.days_left}일 지남)</span>`
          }</dd>
          <dt>유예기간</dt><dd>만료 후 ${l.grace_days}일 (${fmtDate(addDays(l.paid_until, l.grace_days))}까지 사용 가능)</dd>
        </dl>
        <label class="field"><span>메모 (예: 11월분 입금 확인)</span><input type="text" id="lmemo"></label>
        <div class="row">
          <button class="btn primary" data-m="1">+1개월 연장</button>
          <button class="btn" data-m="3">+3개월</button>
          <button class="btn" data-m="12">+12개월</button>
        </div>
        <p class="hint">남은 기간이 있으면 그 뒤로 이어서, 이미 지났으면 오늘부터 연장됩니다.</p>
      </div>

      <h2>직접 지정</h2>
      <form class="card form" id="lset">
        <div class="row">
          <label class="field"><span>사용 기한 (이 날까지 사용)</span><input type="date" name="until" value="${esc(l.paid_until)}" required></label>
          <label class="field"><span>유예기간 (일)</span><input type="number" name="grace" min="0" max="60" value="${l.grace_days}"></label>
        </div>
        <div class="err" id="lerr"></div>
        <button class="btn">저장</button>
        <p class="hint">기한 + 유예기간이 지나면 총관리자를 뺀 모든 직원의 사용이 중지됩니다. 데이터는 지워지지 않습니다.</p>
      </form>

      <h2>변경 이력</h2>
      <div class="table-wrap"><table>
        <tr><th>일시</th><th>변경</th><th>메모</th><th>처리</th></tr>
        ${
          (hist || [])
            .map(
              (h) => `<tr><td>${fmt(h.created_at)}</td><td>${fmtDate(h.from_date)} → <b>${fmtDate(h.to_date)}</b></td>
                <td style="white-space:normal;min-width:140px">${esc(h.memo)}</td><td>${esc(personName(h.user_id))}</td></tr>`
            )
            .join('') || '<tr><td colspan="4" class="hint">아직 이력이 없습니다</td></tr>'
        }
      </table></div>`
    );

    root.querySelectorAll('[data-m]').forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            const { data, error } = await sb.rpc('extend_license', { p_months: Number(b.dataset.m), p_memo: $('#lmemo').value });
            if (error) return toast(errText(error), 'error');
            toast(`${fmtDate(data)}까지 연장했습니다`);
            viewLicense();
          }))
    );
    const f = $('#lset');
    f.onsubmit = (e) => {
      e.preventDefault();
      busy($('button', f), async () => {
        const { error } = await sb.rpc('set_license', {
          p_paid_until: f.until.value,
          p_grace_days: f.grace.value === '' ? null : Number(f.grace.value),
          p_memo: $('#lmemo').value || '직접 지정',
        });
        if (error) return ($('#lerr').textContent = errText(error));
        toast('저장했습니다');
        viewLicense();
      });
    };
  }

  // ---------------- 외부 라이브러리 (필요할 때만 불러옴) ----------------
  const scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => {
          delete scriptCache[src];
          reject(new Error('기능을 불러오지 못했습니다. 인터넷 연결을 확인하세요'));
        };
        document.head.appendChild(el);
      });
    }
    return scriptCache[src];
  }

  // ---------------- 상품 판매 (계산대 화면 · 장바구니) ----------------
  let scanner = null;
  let lastScan = { code: '', at: 0 };
  const isTouch = () => matchMedia('(pointer: coarse)').matches;
  const numVal = (v) => {
    const d = String(v ?? '').replace(/[^0-9]/g, '');
    return d === '' ? null : Number(d);
  };

  // 장바구니 (새로고침해도 유지)
  const cart = { items: [], discount: 0, member: null, coupon: null, points: 0, paying: false };
  const cartKey = () => `cart:${state.me?.id}`;
  function saveCart() {
    try {
      localStorage.setItem(
        cartKey(),
        JSON.stringify({ items: cart.items, discount: cart.discount, member: cart.member, coupon: cart.coupon, points: cart.points })
      );
    } catch {}
  }
  function resetCart() {
    cart.items = [];
    cart.discount = 0;
    cart.member = null;
    cart.coupon = null;
    cart.points = 0;
    cart.memberCoupons = [];
  }
  function loadCart() {
    try {
      const v = JSON.parse(localStorage.getItem(cartKey()) || 'null');
      resetCart();
      cart.items = Array.isArray(v?.items) ? v.items : [];
      cart.discount = Number(v?.discount) || 0;
      cart.member = v?.member || null;
      cart.coupon = v?.coupon || null;
      cart.points = Number(v?.points) || 0;
    } catch {
      resetCart();
    }
  }
  const cartSubtotal = () => cart.items.reduce((a, c) => a + (Number(c.sell) || 0), 0);
  const afterDiscount = () => Math.max(0, cartSubtotal() - (Number(cart.discount) || 0));
  const couponDiscount = () => {
    const c = cart.coupon;
    const base = afterDiscount();
    if (!c || base < (c.min_total || 0)) return 0;
    return c.kind === 'amount' ? Math.min(c.value, base) : Math.floor((base * Math.min(c.value, 100)) / 100);
  };
  const cartTotal = () => Math.max(0, afterDiscount() - couponDiscount() - (Number(cart.points) || 0));
  const pointsEarnPreview = () => {
    const st = state.settings;
    if (!cart.member || !st || !st.points_enabled) return 0;
    return Math.floor((cartTotal() * Number(st.point_rate)) / 100);
  };
  const maskPhone = (p) => {
    const d = String(p || '');
    return d.length >= 10 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : d;
  };
  const fmtPhone = (p) => {
    const d = String(p || '');
    return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
  };

  // 결제수단 + 가격 선택 창 (상품 상세 화면에서 1개 판매할 때)
  function sellDialog(p) {
    return modal(
      `<h3>${esc(p.code)} 판매</h3>
      <div>${esc(p.name)}</div>
      <label class="field" style="margin-top:12px"><span>판매 가격 (원)</span><input type="text" inputmode="numeric" value="${p.price ?? ''}"></label>
      <div class="paybtns">${Object.entries(PAY_LABEL)
        .map(([k, v]) => `<button class="btn sell" data-pay="${k}">${v}</button>`)
        .join('')}</div>
      <div class="row"><button class="btn" data-x>취소</button></div>`,
      (bg, close) => {
        const input = $('input', bg);
        $('[data-x]', bg).onclick = () => close(null);
        bg.querySelectorAll('[data-pay]').forEach(
          (b) => (b.onclick = () => close({ price: numVal(input.value), payment: b.dataset.pay }))
        );
      }
    );
  }

  async function stopScanner() {
    const sc = scanner;
    scanner = null;
    if (!sc) return;
    try {
      await sc.stop();
    } catch {}
    try {
      sc.clear();
    } catch {}
  }

  function focusScanInput() {
    const input = $('#scanInput');
    const active = document.activeElement;
    // 가격/할인 입력 중이면 커서를 뺏지 않음
    if (active && active !== input && active.matches?.('input, textarea, select')) return;
    if (input && !isTouch() && !document.querySelector('.modal-bg')) input.focus();
  }

  function resumeScanner(delay = 0) {
    setTimeout(() => {
      try {
        if (scanner) scanner.resume();
      } catch {}
    }, delay);
    focusScanInput();
  }

  // 판매 매장: 실장·캐셔는 자기 매장 고정, 관리자·총관리자는 화면에서 선택 (마지막 선택 기억)
  function sellStoreId() {
    if (state.me.store_id && !isAdmin()) return state.me.store_id;
    const saved = Number(pref('sellStore'));
    if (state.stores.some((s) => s.id === saved)) return saved;
    return cart.items[0]?.store_id || state.me.store_id || state.stores[0]?.id || null;
  }
  function setSellStore(id) {
    pref('sellStore', String(id));
    const sel = $('#sellStore');
    if (sel) sel.value = String(id);
    const lbl = $('#todayStore');
    if (lbl) lbl.textContent = storeName(id);
    loadCash();
    loadToday();
  }

  function viewSell() {
    state.view = 'sell';
    loadCart();
    if (cart.member)
      fetchMemberCoupons(cart.member.id).then((list) => {
        cart.memberCoupons = list;
        if (cart.coupon?.member_coupon_id && !list.some((r) => r.id === cart.coupon.member_coupon_id)) cart.coupon = null;
        if (state.view === 'sell') renderCart();
      });
    const me = state.me;
    shell(
      'sell',
      `<div class="pos">
        <div class="pos-main">
          <div class="pos-head"><h1>상품 판매</h1>${
            isAdmin()
              ? `<label class="store-pick">판매 매장 <select id="sellStore">${state.stores
                  .map((st) => `<option value="${st.id}" ${st.id === sellStoreId() ? 'selected' : ''}>${esc(st.name)}</option>`)
                  .join('')}</select></label>`
              : ''
          }<div id="cashBox"></div></div>
          <input type="text" id="scanInput" class="pos-input" placeholder="바코드/QR을 찍거나 상품코드 입력 후 Enter" autocomplete="off" autocapitalize="characters" enterkeyhint="go">
          <div id="reader" class="reader"></div>
          <button class="btn block" id="camBtn">📷 카메라로 찍기</button>
          <div id="scanMsg"></div>
          <div id="cart"></div>
        </div>
        <div class="pos-side">
          <h2>오늘 판매 <small class="hint" id="todayStore">${esc(storeName(sellStoreId()))}</small></h2>
          <div id="todayTotals"></div>
          <div id="todayList"></div>
          <p><a href="#/settle">정산 자세히 보기 →</a></p>
        </div>
      </div>`
    );
    const input = $('#scanInput');
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const v = input.value;
        input.value = '';
        handleScan(v);
      }
    };
    // PC 계산대: 빈 곳을 눌러도 입력칸에 커서 유지 → 스캐너로 바로 찍기
    $('.pos').addEventListener('click', (e) => {
      if (!e.target.closest('input, button, a, select, textarea, label, .sale-row')) focusScanInput();
    });
    $('#camBtn').onclick = startCamera;
    const ss = $('#sellStore');
    if (ss)
      ss.onchange = () => {
        const id = Number(ss.value);
        if (cart.items.length && cart.items[0].store_id !== id) {
          ss.value = String(cart.items[0].store_id);
          return toast('장바구니에 다른 매장 상품이 있습니다. 결제하거나 비운 뒤 바꾸세요', 'error');
        }
        setSellStore(id);
      };
    renderCart();
    focusScanInput();
    if (isTouch()) startCamera(); // 휴대폰은 바로 카메라
    loadToday();
    loadCash();
  }

  async function startCamera() {
    const btn = $('#camBtn');
    if (!btn) return;
    if (scanner) {
      await stopScanner();
      btn.textContent = '📷 카메라로 찍기';
      return;
    }
    btn.disabled = true;
    btn.textContent = '카메라 준비 중…';
    try {
      await loadScript('./vendor/html5-qrcode-2.3.8.min.js');
      if (state.view !== 'sell') return;
      const L = window.__Html5QrcodeLibrary__;
      const F = L.Html5QrcodeSupportedFormats;
      const sc = new L.Html5Qrcode('reader', {
        verbose: false,
        formatsToSupport: [F.QR_CODE, F.CODE_128, F.CODE_39, F.EAN_13, F.EAN_8, F.UPC_A],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      });
      await sc.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (w, h) => ({ width: Math.max(120, Math.floor(w * 0.85)), height: Math.max(80, Math.floor(Math.min(h, w) * 0.55)) }),
        },
        (text) => {
          const now = Date.now();
          if (text === lastScan.code && now - lastScan.at < 3000) return;
          lastScan = { code: text, at: now };
          try {
            sc.pause(true);
          } catch {}
          handleScan(text);
        },
        () => {}
      );
      if (state.view !== 'sell') {
        sc.stop().catch(() => {});
        return;
      }
      scanner = sc;
      btn.textContent = '카메라 끄기';
    } catch (err) {
      const m = String(err?.message || err);
      toast(
        /Permission|NotAllowed/i.test(m)
          ? '카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라를 허용하세요'
          : /NotFound|no camera|Requested device not found/i.test(m)
            ? '카메라를 찾을 수 없습니다. 바코드 스캐너나 직접 입력을 사용하세요'
            : `카메라를 켤 수 없습니다: ${m}`,
        'error'
      );
      btn.textContent = '📷 카메라로 찍기';
    } finally {
      btn.disabled = false;
    }
  }

  function scanMsg(kind, html) {
    const el = $('#scanMsg');
    if (el) el.innerHTML = html ? `<div class="scan-msg ${kind}">${html}</div>` : '';
  }

  // 찍은 상품 → 장바구니에 담기
  async function handleScan(raw) {
    const code = normCode(raw);
    if (!code) return;
    navigator.vibrate?.(50);
    if (cart.items.some((c) => c.code === code)) {
      scanMsg('warn', `<b>${esc(code)}</b> 이미 장바구니에 있습니다`);
      return resumeScanner(1200);
    }
    scanMsg('info', `${esc(code)} 찾는 중…`);
    const { data: p, error } = await sb.from('products').select('*').eq('code', code).maybeSingle();
    if (state.view !== 'sell') return;
    if (error) {
      scanMsg('error', esc(errText(error)));
      return resumeScanner(1500);
    }
    if (!p) {
      scanMsg(
        'none',
        `<b>${esc(code)}</b> 등록되지 않은 코드입니다 ${
          isCashier() ? '· 실장에게 등록을 요청하세요' : `· <a href="#/new?code=${encodeURIComponent(code)}">이 코드로 상품 등록</a>`
        }`
      );
    } else if (p.status === 'sold') {
      scanMsg('error', `<b>${esc(p.code)}</b> 이미 판매된 상품 · ${fmt(p.sold_at)} ${esc(storeName(p.sold_store_id))} ${esc(personName(p.sold_by))}`);
    } else if (!canManage(p.store_id)) {
      scanMsg('warn', `<b>${esc(p.code)}</b> ${esc(storeName(p.store_id))} 상품입니다 · 판매는 해당 매장에서 처리합니다`);
    } else if (cart.items.length && cart.items[0].store_id !== p.store_id) {
      scanMsg('warn', `<b>${esc(p.code)}</b> 다른 매장(${esc(storeName(p.store_id))}) 상품은 한 영수증에 담을 수 없습니다`);
    } else {
      if (isAdmin() && !cart.items.length && p.store_id !== sellStoreId()) {
        setSellStore(p.store_id);
        toast(`판매 매장을 ${storeName(p.store_id)}(으)로 바꿨습니다`);
      }
      cart.items.push({
        id: p.id,
        code: p.code,
        name: p.name,
        price: p.price,
        sell: p.price ?? 0,
        thumb: p.thumb_path || p.photo_path,
        store_id: p.store_id,
      });
      saveCart();
      renderCart();
      scanMsg('ok', `✓ <b>${esc(p.code)}</b> ${esc(p.name)} ${won(p.price)} 담김`);
    }
    resumeScanner(1200);
  }

  function renderCart() {
    const el = $('#cart');
    if (!el) return;
    if (!cart.items.length) {
      el.innerHTML = `<div class="cart cart-empty">상품을 찍으면 여기에 담깁니다.<br><span class="hint">여러 개를 담아서 한 번에 결제할 수 있습니다.</span></div>${receiptOptionsHtml()}`;
      bindReceiptOptions();
      return;
    }
    const blocked = cart.items.some((c) => c.soldElsewhere);
    el.innerHTML = `<div class="cart">
      ${cart.items
        .map(
          (c, i) => `<div class="cart-row ${c.soldElsewhere ? 'gone' : ''}">
          <img src="${esc(photoUrl(c.thumb))}" alt="">
          <div class="cn"><b>${esc(c.code)}</b><br><small>${esc(c.name)}</small>
            ${c.soldElsewhere ? '<br><small class="gone-msg">다른 곳에서 판매됨 · 빼주세요</small>' : ''}</div>
          <div class="cp"><input type="text" inputmode="numeric" data-price="${i}" value="${c.sell ?? ''}">
            ${Number(c.sell) !== Number(c.price) && c.price != null ? `<small class="hint"><s>${won(c.price)}</s></small>` : ''}</div>
          <button class="btn small" data-del="${i}" title="빼기">✕</button>
        </div>`
        )
        .join('')}
      <div class="cart-sum">
        <div><span>상품 ${cart.items.length}개 합계</span><b id="cSub">${won(cartSubtotal())}</b></div>
        <div><span>추가 할인 (원)</span><input type="text" inputmode="numeric" id="cDisc" value="${cart.discount || ''}" placeholder="0"></div>
        ${cartExtrasHtml()}
        <div class="cart-total"><span>결제 금액</span><b id="cTotal">${won(cartTotal())}</b></div>
        <div class="earn hint" id="cEarn">${cart.member && pointsEarnPreview() ? `적립 예정 ${pointsEarnPreview().toLocaleString('ko-KR')}P` : ''}</div>
      </div>
      <div class="paybtns big">${Object.entries(PAY_LABEL)
        .map(([k, v]) => `<button class="btn sell" data-pay="${k}" ${blocked ? 'disabled' : ''}>${v}</button>`)
        .join('')}</div>
      <div class="row" style="margin-top:8px"><button class="btn small" id="cClear">장바구니 비우기</button><span></span></div>
    </div>${receiptOptionsHtml()}`;
    const updateSums = () => {
      $('#cSub').textContent = won(cartSubtotal());
      const cd = $('#cCouponAmt');
      if (cd) cd.textContent = cart.coupon ? (couponDiscount() ? `-${won(couponDiscount())}` : `최소 ${won(cart.coupon.min_total)} 이상`) : '';
      $('#cTotal').textContent = won(cartTotal());
      const ce = $('#cEarn');
      if (ce) ce.textContent = cart.member && pointsEarnPreview() ? `적립 예정 ${pointsEarnPreview().toLocaleString('ko-KR')}P` : '';
      saveCart();
    };
    el.querySelectorAll('[data-price]').forEach(
      (inp) =>
        (inp.oninput = () => {
          cart.items[Number(inp.dataset.price)].sell = numVal(inp.value) ?? 0;
          updateSums();
        })
    );
    el.querySelectorAll('[data-del]').forEach(
      (b) =>
        (b.onclick = () => {
          cart.items.splice(Number(b.dataset.del), 1);
          if (!cart.items.length) resetCart();
          saveCart();
          renderCart();
          focusScanInput();
        })
    );
    $('#cDisc').oninput = (e) => {
      cart.discount = numVal(e.target.value) ?? 0;
      updateSums();
    };
    $('#cClear').onclick = async () => {
      if (!(await confirmBox('장바구니 비우기', '담은 상품과 회원·쿠폰 선택을 모두 비울까요?', '비우기'))) return;
      resetCart();
      saveCart();
      renderCart();
      scanMsg('', '');
      focusScanInput();
    };
    el.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = () => pay(b.dataset.pay)));
    bindCartExtras(updateSums);
    bindReceiptOptions();
  }

  // ----- 장바구니: 회원 · 포인트 · 쿠폰 -----
  function cartExtrasHtml() {
    const m = cart.member;
    const st = state.settings || {};
    return `
      <div class="cart-extra"><span>회원</span>${
        m
          ? `<span class="member-chip"><b>${esc(m.name || '이름없음')}</b> ${esc(maskPhone(m.phone))} · ${Number(m.points).toLocaleString('ko-KR')}P
             <button class="btn small" id="cMemberX" title="회원 빼기">✕</button></span>`
          : `<button class="btn small" id="cMember">회원 찾기 / 가입</button>`
      }</div>
      ${
        m && st.points_enabled
          ? `<div class="cart-extra"><span>포인트 사용 <small class="hint">(${Number(st.point_min_use).toLocaleString('ko-KR')}P부터)</small></span>
             <span><input type="text" inputmode="numeric" id="cPoints" value="${cart.points || ''}" placeholder="0">
             <button class="btn small" id="cPointsAll">전액</button></span></div>`
          : ''
      }
      ${
        m && !cart.coupon && (cart.memberCoupons || []).length
          ? `<div class="cart-extra"><span>보유 쿠폰</span><span class="mc-list">${cart.memberCoupons
              .map(
                (r) => `<button class="btn small mc-btn" data-mc="${r.id}">${esc(r.coupons.name)} · ${couponValueText(r.coupons)}${
                  r.expires_on ? ` <small>~${esc(r.expires_on.slice(5).replace('-', '/'))}</small>` : ''
                }</button>`
              )
              .join('')}</span></div>`
          : ''
      }
      <div class="cart-extra"><span>쿠폰</span>${
        cart.coupon
          ? `<span class="member-chip"><b>${esc(cart.coupon.name)}</b> <span id="cCouponAmt">${
              couponDiscount() ? `-${won(couponDiscount())}` : `최소 ${won(cart.coupon.min_total)} 이상`
            }</span> <button class="btn small" id="cCouponX" title="쿠폰 빼기">✕</button></span>`
          : `<span><input type="text" id="cCouponCode" placeholder="쿠폰 코드" autocapitalize="characters"> <button class="btn small" id="cCouponApply">적용</button></span>`
      }</div>`;
  }

  function bindCartExtras(updateSums) {
    const rerender = () => {
      saveCart();
      renderCart();
    };
    const mb = $('#cMember');
    if (mb)
      mb.onclick = () =>
        memberPicker().then(async (m) => {
          if (!m) return;
          cart.member = m;
          cart.memberCoupons = await fetchMemberCoupons(m.id);
          rerender();
          if (cart.memberCoupons.length) toast(`${m.name || '회원'}님 보유 쿠폰 ${cart.memberCoupons.length}장`);
        });
    $('#cart')
      ?.querySelectorAll('[data-mc]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            const r = cart.memberCoupons.find((x) => x.id === Number(b.dataset.mc));
            cart.coupon = { ...r.coupons, member_coupon_id: r.id };
            if (afterDiscount() < (r.coupons.min_total || 0)) toast(`이 쿠폰은 ${won(r.coupons.min_total)} 이상 결제 시 적용됩니다`);
            rerender();
          })
      );
    const mx = $('#cMemberX');
    if (mx)
      mx.onclick = () => {
        cart.member = null;
        cart.points = 0;
        cart.memberCoupons = [];
        if (cart.coupon?.member_coupon_id) cart.coupon = null;
        rerender();
      };
    const pi = $('#cPoints');
    if (pi)
      pi.oninput = () => {
        cart.points = numVal(pi.value) ?? 0;
        updateSums();
      };
    const pa = $('#cPointsAll');
    if (pa)
      pa.onclick = () => {
        cart.points = Math.min(Number(cart.member.points) || 0, Math.max(0, afterDiscount() - couponDiscount()));
        rerender();
      };
    const ca = $('#cCouponApply');
    if (ca)
      ca.onclick = () =>
        busy(ca, async () => {
          const code = $('#cCouponCode').value.trim();
          if (!code) return;
          const { data, error } = await sb.rpc('coupon_quote', { p_code: code, p_amount: afterDiscount() });
          if (error) return toast(errText(error), 'error');
          cart.coupon = { id: data.id, code: data.code, name: data.name, kind: data.kind, value: data.value, min_total: data.min_total };
          if (afterDiscount() < data.min_total) toast(`이 쿠폰은 ${won(data.min_total)} 이상 결제 시 적용됩니다`);
          rerender();
        });
    const cc = $('#cCouponCode');
    if (cc) cc.onkeydown = (e) => e.key === 'Enter' && ca.click();
    const cx = $('#cCouponX');
    if (cx)
      cx.onclick = () => {
        cart.coupon = null;
        rerender();
      };
  }

  // 회원 찾기 / 가입 창 (계산대)
  function memberPicker() {
    return modal(
      `<h3>회원 찾기</h3>
      <div class="row"><input type="text" id="mpQ" placeholder="전화번호 뒷자리 또는 이름" inputmode="text"><button class="btn primary" id="mpGo">찾기</button></div>
      <div id="mpList" class="mp-list"></div>
      <button class="btn block" id="mpQr" style="margin-top:12px">📱 손님이 직접 가입 (QR 보여주기)</button>
      <details id="mpNewBox" style="margin-top:8px"><summary><b>+ 직원이 대신 가입</b></summary>
        <div style="margin-top:10px">
          <label class="field"><span>전화번호 *</span><input type="text" inputmode="tel" id="mpPhone" placeholder="010-0000-0000"></label>
          <label class="field"><span>이름</span><input type="text" id="mpName"></label>
          <label style="display:flex;gap:8px;align-items:center;margin-bottom:8px;font-size:14px"><input type="checkbox" id="mpMk"> 문자(광고) 수신 동의를 받았어요</label>
          <div class="err" data-err></div>
          <button class="btn primary block" id="mpSave">가입하고 선택</button>
        </div>
      </details>
      <div class="row" style="margin-top:12px"><button class="btn" data-x>닫기</button></div>`,
      (bg, close) => {
        const q = $('#mpQ', bg);
        q.focus();
        const search = async () => {
          const v = q.value.trim();
          const box = $('#mpList', bg);
          if (!v) return (box.innerHTML = '');
          const digits = v.replace(/[^0-9]/g, '');
          const term = v.replace(/[,()%*\\]/g, ' ').trim();
          let qb = sb.from('members').select('*').order('created_at', { ascending: false }).limit(20);
          qb = digits.length >= 3 ? qb.like('phone', `%${digits}%`) : qb.ilike('name', `%${term}%`);
          const { data, error } = await qb;
          if (error) return (box.innerHTML = `<div class="hint">${esc(errText(error))}</div>`);
          box.innerHTML = (data || []).length
            ? data
                .map(
                  (m) => `<button class="mp-row" data-id="${m.id}"><b>${esc(m.name || '이름없음')}</b> <span>${esc(fmtPhone(m.phone))}</span>
                  <span class="pts">${Number(m.points).toLocaleString('ko-KR')}P</span></button>`
                )
                .join('')
            : `<div class="hint" style="padding:10px 0">찾는 회원이 없습니다. 아래에서 새로 가입하세요.</div>`;
          box.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => close(data.find((m) => m.id === Number(b.dataset.id)))));
          if (!(data || []).length && digits.length >= 9) {
            $('#mpNewBox', bg).open = true;
            $('#mpPhone', bg).value = digits;
          }
        };
        $('#mpGo', bg).onclick = search;
        $('#mpQr', bg).onclick = () => {
          close(null);
          showJoinQr(cart.items[0]?.store_id || sellStoreId());
        };
        q.onkeydown = (e) => e.key === 'Enter' && search();
        $('#mpSave', bg).onclick = (e) =>
          busy(e.target, async () => {
            const { data: id, error } = await sb.rpc('save_member', {
              p_id: null,
              p_name: $('#mpName', bg).value,
              p_phone: $('#mpPhone', bg).value,
              p_memo: '',
              p_marketing: $('#mpMk', bg).checked,
            });
            if (error) return ($('[data-err]', bg).textContent = errText(error));
            const { data: m } = await sb.from('members').select('*').eq('id', id).maybeSingle();
            toast('회원으로 가입했습니다');
            close(m);
          });
        $('[data-x]', bg).onclick = () => close(null);
      }
    );
  }

  // 영수증 옵션 (자동 출력, 용지 폭)
  const receiptPref = () => ({ auto: pref('receiptAuto') === '1', width: pref('receiptWidth') === '58' ? 58 : 80 });
  function receiptOptionsHtml() {
    const r = receiptPref();
    return `<div class="receipt-opts">
      <label><input type="checkbox" id="rAuto" ${r.auto ? 'checked' : ''}> 결제 후 영수증 자동 출력</label>
      <label>용지 <select id="rWidth"><option value="80" ${r.width === 80 ? 'selected' : ''}>80mm</option><option value="58" ${
        r.width === 58 ? 'selected' : ''
      }>58mm</option></select></label>
    </div>`;
  }
  function bindReceiptOptions() {
    const a = $('#rAuto');
    const w = $('#rWidth');
    if (a) a.onchange = () => pref('receiptAuto', a.checked ? '1' : '0');
    if (w) w.onchange = () => pref('receiptWidth', w.value);
  }

  // 현금 결제: 받은 금액 → 거스름돈
  function cashDialog(total) {
    return modal(
      `<h3>현금 결제</h3>
      <div class="cash-total"><span>결제 금액</span><b>${won(total)}</b></div>
      <label class="field"><span>받은 금액 (원)</span><input type="text" inputmode="numeric" id="recv" value="${total}"></label>
      <div class="quick-cash">
        <button class="btn small" data-set="${total}">딱 맞게</button>
        ${[10000, 50000, 100000].map((v) => `<button class="btn small" data-set="${v}">${v / 10000}만원</button>`).join('')}
        ${[1000, 5000, 10000].map((v) => `<button class="btn small" data-add="${v}">+${v.toLocaleString('ko-KR')}</button>`).join('')}
      </div>
      <div class="cash-total change"><span>거스름돈</span><b id="chg">0원</b></div>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>취소</button><button class="btn sell" data-ok>결제 완료</button></div>`,
      (bg, close) => {
        const input = $('#recv', bg);
        const upd = () => {
          const r = numVal(input.value) ?? 0;
          $('#chg', bg).textContent = r >= total ? won(r - total) : `${won(total - r)} 부족`;
          $('#chg', bg).classList.toggle('short', r < total);
        };
        input.oninput = upd;
        input.focus();
        input.select();
        upd();
        bg.querySelectorAll('[data-set]').forEach(
          (b) =>
            (b.onclick = () => {
              input.value = b.dataset.set;
              upd();
            })
        );
        bg.querySelectorAll('[data-add]').forEach(
          (b) =>
            (b.onclick = () => {
              input.value = (numVal(input.value) ?? 0) + Number(b.dataset.add);
              upd();
            })
        );
        const ok = () => {
          const r = numVal(input.value) ?? 0;
          if (r < total) return ($('[data-err]', bg).textContent = '받은 금액이 결제 금액보다 적습니다');
          close(r);
        };
        $('[data-ok]', bg).onclick = ok;
        input.onkeydown = (e) => {
          if (e.key === 'Enter') ok();
        };
        $('[data-x]', bg).onclick = () => close(null);
      }
    );
  }

  async function pay(method) {
    if (!cart.items.length || cart.paying) return;
    const total = cartTotal();
    if ((Number(cart.discount) || 0) > cartSubtotal()) return toast('할인이 상품 합계보다 큽니다', 'error');
    if (cart.points && cart.points > (Number(cart.member?.points) || 0)) return toast('보유 포인트보다 많이 쓸 수 없습니다', 'error');
    if (cart.points && cart.points > afterDiscount() - couponDiscount()) return toast('포인트는 결제 금액까지만 쓸 수 있습니다', 'error');
    let received = null;
    if (method === 'cash') {
      received = await cashDialog(total);
      if (received === null) return focusScanInput();
    }
    cart.paying = true;
    const btns = [...document.querySelectorAll('#cart [data-pay]')];
    btns.forEach((b) => (b.disabled = true));
    const { data, error } = await sb.rpc('checkout', {
      p_items: cart.items.map((c) => ({ id: c.id, price: Number(c.sell) || 0 })),
      p_discount: Number(cart.discount) || 0,
      p_payment: method,
      p_received_cash: received,
      p_memo: '',
      p_member_id: cart.member?.id ?? null,
      p_points_used: Number(cart.points) || 0,
      p_coupon_code: cart.coupon && !cart.coupon.member_coupon_id && couponDiscount() > 0 ? cart.coupon.code : null,
      p_member_coupon_id: cart.coupon?.member_coupon_id && couponDiscount() > 0 ? cart.coupon.member_coupon_id : null,
    });
    cart.paying = false;
    if (error) {
      btns.forEach((b) => (b.disabled = false));
      toast(errText(error), 'error');
      return focusScanInput();
    }
    const memberName = cart.member?.name;
    resetCart();
    saveCart();
    renderCart();
    scanMsg(
      'done',
      `✅ 결제 완료 · <b>${won(data.total)}</b> ${PAY_LABEL[method]}${
        method === 'cash' && data.change ? ` · 거스름돈 <b>${won(data.change)}</b>` : ''
      }<br><small>영수증 ${esc(data.receipt_no)}${
        data.points_earned ? ` · ${esc(memberName || '회원')}님 ${Number(data.points_earned).toLocaleString('ko-KR')}P 적립` : ''
      }</small>
      <div class="row" style="margin-top:8px"><button class="btn small" id="rPrint">🧾 영수증 출력</button><span></span></div>`
    );
    $('#rPrint').onclick = () => printReceipt(data.sale_id);
    if (receiptPref().auto) printReceipt(data.sale_id);
    loadToday();
    loadCash();
    focusScanInput();
  }

  // ---------------- 영수증 ----------------
  async function fetchReceipt(saleId) {
    const { data: sale, error } = await sb.from('sales').select('*, sale_items(*)').eq('id', saleId).maybeSingle();
    if (error || !sale) throw error || new Error('영수증을 찾을 수 없습니다');
    const { data: st } = await sb.from('stores').select('*').eq('id', sale.store_id).maybeSingle();
    let member = null;
    let coupon = null;
    if (sale.member_id) member = (await sb.from('members').select('*').eq('id', sale.member_id).maybeSingle()).data;
    if (sale.coupon_id) coupon = (await sb.from('coupons').select('name, code').eq('id', sale.coupon_id).maybeSingle()).data;
    if (!state.people[sale.created_by]) await loadPeople();
    return { sale, member, coupon, items: (sale.sale_items || []).sort((a, b) => a.id - b.id), store: st || { name: storeName(sale.store_id) } };
  }

  function receiptHtml({ sale, items, store, member, coupon }, widthMm) {
    const line = (l, r, cls = '') => `<div class="r-line ${cls}"><span>${l}</span><span>${r}</span></div>`;
    const t = new Date(sale.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
    return `<div class="receipt" style="width:${widthMm - 8}mm">
      <div class="r-title">${esc(store.biz_name || store.name)}</div>
      <div class="r-info">
        ${store.biz_no ? `사업자 ${esc(store.biz_no)}` : ''}${store.owner_name ? ` · 대표 ${esc(store.owner_name)}` : ''}
        ${store.address ? `<br>${esc(store.address)}` : ''}${store.phone ? `<br>TEL ${esc(store.phone)}` : ''}
      </div>
      <div class="r-hr"></div>
      ${line('영수증', esc(sale.receipt_no))}
      ${line('일시', esc(t))}
      ${line('판매자', esc(personName(sale.created_by)))}
      ${sale.status === 'cancelled' ? '<div class="r-cancel">*** 취소된 영수증 ***</div>' : ''}
      <div class="r-hr"></div>
      ${items
        .map(
          (i) => `<div class="r-item ${i.status === 'refunded' ? 'refunded' : ''}"><div>${esc(i.name || i.code)}</div>
          ${line(`<small>${esc(i.code)}</small>`, `${i.list_price != null && i.list_price !== i.price ? `<small><s>${won(i.list_price)}</s></small> ` : ''}${won(i.price)}${
            i.status === 'refunded' ? ' (환불)' : ''
          }`)}</div>`
        )
        .join('')}
      <div class="r-hr"></div>
      ${line(`상품 ${sale.item_count}개 합계`, won(sale.subtotal))}
      ${sale.discount ? line('할인', `-${won(sale.discount)}`) : ''}
      ${sale.coupon_discount ? line(`쿠폰${coupon ? ` (${esc(coupon.name)})` : ''}`, `-${won(sale.coupon_discount)}`) : ''}
      ${sale.points_used ? line('포인트 사용', `-${won(sale.points_used)}`) : ''}
      ${line('결제 금액', won(sale.total), 'r-total')}
      ${sale.refunded_amount ? line('환불', `-${won(sale.refunded_amount)}`) : ''}
      ${line('결제수단', PAY_LABEL[sale.payment] || '-')}
      ${sale.payment === 'cash' && sale.received_cash != null ? line('받은 금액', won(sale.received_cash)) + line('거스름돈', won(sale.change_cash || 0)) : ''}
      ${
        member || sale.member_id
          ? `<div class="r-hr"></div>${line('회원', member ? `${esc(member.name || '')} ${esc(maskPhone(member.phone))}` : '(삭제된 회원)')}
             ${sale.points_earned ? line('적립 포인트', `${Number(sale.points_earned).toLocaleString('ko-KR')}P`) : ''}
             ${member ? line('보유 포인트', `${Number(member.points).toLocaleString('ko-KR')}P`) : ''}`
          : ''
      }
      <div class="r-hr"></div>
      <div class="r-foot">${esc(store.receipt_footer || '')}</div>
    </div>`;
  }

  async function printReceipt(saleId) {
    let r;
    try {
      r = await fetchReceipt(saleId);
    } catch (e) {
      return toast(errText(e), 'error');
    }
    const w = receiptPref().width;
    document.getElementById('printArea')?.remove();
    document.getElementById('printPage')?.remove();
    const area = document.createElement('div');
    area.id = 'printArea';
    area.innerHTML = receiptHtml(r, w);
    document.body.appendChild(area);
    const st = document.createElement('style');
    st.id = 'printPage';
    st.textContent = `@page { size: ${w}mm 300mm; margin: 0 } #printArea .receipt { margin: 0 auto; }`;
    document.head.appendChild(st);
    const cleanup = () => {
      area.remove();
      st.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => window.print(), 50);
  }

  const canCancelSale = (sale) =>
    sale.status === 'completed' &&
    (isCashier() ? sale.created_by === state.me.id && new Date(sale.created_at) >= new Date(kstStart(kstToday())) : canManage(sale.store_id));

  async function openReceipt(saleId, after) {
    let r;
    try {
      r = await fetchReceipt(saleId);
    } catch (e) {
      return toast(errText(e), 'error');
    }
    modal(
      `<div class="receipt-preview">${receiptHtml(r, 80)}</div>
      <div class="row" style="margin-top:12px">
        <button class="btn" data-x>닫기</button>
        ${canCancelSale(r.sale) ? '<button class="btn danger" data-cancel>영수증 취소</button>' : ''}
        <button class="btn primary" data-print>🧾 출력</button>
      </div>`,
      (bg, close) => {
        $('[data-x]', bg).onclick = () => close();
        $('[data-print]', bg).onclick = () => printReceipt(saleId);
        const c = $('[data-cancel]', bg);
        if (c)
          c.onclick = async () => {
            close();
            if (await cancelReceipt(r.sale)) after?.();
          };
      }
    );
  }

  async function cancelReceipt(sale) {
    const reason = await promptBox(
      `영수증 ${sale.receipt_no} 취소`,
      `사유 (상품 ${sale.item_count}개가 모두 판매중으로 돌아갑니다)`,
      '',
      '영수증 취소',
      'sell'
    );
    if (reason === null) return false;
    const { error } = await sb.rpc('cancel_sale', { p_sale_id: sale.id, p_reason: reason });
    if (error) {
      toast(errText(error), 'error');
      return false;
    }
    toast(`영수증 ${sale.receipt_no} 를 취소했습니다`);
    return true;
  }

  // ---------------- 판매 내역 (오늘 판매 / 정산 공용) ----------------
  async function fetchSales(from, to, storeId) {
    let qb = sb
      .from('sales')
      .select('*, sale_items(id, code, name, price, status)')
      .gte('created_at', kstStart(from))
      .lt('created_at', kstStart(shiftDate(to, 1)))
      .order('created_at', { ascending: false })
      .limit(2000);
    if (storeId) qb = qb.eq('store_id', Number(storeId));
    const { data, error } = await qb;
    if (error) throw error;
    return data || [];
  }

  // 완료된 영수증 기준 (취소 제외, 부분환불 차감)
  function salesTotals(rows) {
    const t = { receipts: 0, items: 0, total: 0, discount: 0, coupon: 0, points: 0, cash: 0, card: 0, transfer: 0, none: 0, refunded: 0, cancelled: 0 };
    for (const r of rows) {
      if (r.status !== 'completed') {
        t.cancelled++;
        continue;
      }
      const net = (r.total || 0) - (r.refunded_amount || 0);
      t.receipts++;
      t.items += (r.sale_items || []).filter((i) => i.status === 'sold').length;
      t.total += net;
      t.discount += r.discount || 0;
      t.coupon += r.coupon_discount || 0;
      t.points += r.points_used || 0;
      t.refunded += r.refunded_amount || 0;
      t[r.payment || 'none'] += net;
    }
    return t;
  }

  function totalsHtml(t) {
    return `<div class="totals">
      <div class="sum"><span>총 매출</span><b>${won(t.total)}</b></div>
      <div><span>결제 건수</span><b>${t.receipts}건 <small>(${t.items}점)</small></b></div>
      <div><span>현금</span><b>${won(t.cash)}</b></div>
      <div><span>카드</span><b>${won(t.card)}</b></div>
      <div><span>이체</span><b>${won(t.transfer)}</b></div>
      ${t.discount ? `<div><span>할인 합계</span><b>${won(t.discount)}</b></div>` : ''}
      ${t.coupon ? `<div><span>쿠폰 할인</span><b>${won(t.coupon)}</b></div>` : ''}
      ${t.points ? `<div><span>포인트 사용</span><b>${won(t.points)}</b></div>` : ''}
      ${t.refunded ? `<div><span>부분환불</span><b>${won(t.refunded)}</b></div>` : ''}
      ${t.none ? `<div><span>결제수단 미지정</span><b>${won(t.none)}</b></div>` : ''}
      ${t.cancelled ? `<div><span>취소된 영수증</span><b>${t.cancelled}건</b></div>` : ''}
    </div>`;
  }

  const itemsLabel = (r) => {
    const its = r.sale_items || [];
    if (!its.length) return '-';
    return `${esc(its[0].name || its[0].code)}${its.length > 1 ? ` 외 ${its.length - 1}개` : ''}`;
  };

  async function loadToday() {
    const box = $('#todayList');
    if (!box) return;
    const today = kstToday();
    let rows;
    try {
      rows = await fetchSales(today, today, sellStoreId());
    } catch (e) {
      return toast(errText(e), 'error');
    }
    if (state.view !== 'sell') return;
    $('#todayTotals').innerHTML = totalsHtml(salesTotals(rows));
    box.innerHTML = rows.length
      ? `<div class="sale-list">${rows
          .slice(0, 60)
          .map(
            (r) => `<div class="sale-row ${r.status}" data-sale="${r.id}">
            <span class="t">${hhmm(r.created_at)}</span>
            <span class="n">${itemsLabel(r)}<br><small class="hint">${esc(r.receipt_no.split('-').pop())}번 · ${esc(personName(r.created_by))}${
              r.status === 'cancelled' ? ' · 취소됨' : ''
            }</small></span>
            <span class="p">${won(r.total)}<br><small class="pay ${r.payment || ''}">${PAY_LABEL[r.payment] || '-'}</small></span>
          </div>`
          )
          .join('')}</div><p class="hint">목록을 누르면 영수증을 보고 출력·취소할 수 있습니다.</p>`
      : '<div class="empty" style="padding:20px 0">아직 오늘 판매가 없습니다</div>';
    box.querySelectorAll('[data-sale]').forEach(
      (el) => (el.onclick = () => openReceipt(Number(el.dataset.sale), () => (loadToday(), loadCash())))
    );
  }

  // ---------------- 시재 ----------------
  let cashState = null;
  async function loadCash() {
    const box = $('#cashBox');
    if (!box) return;
    const storeId = sellStoreId();
    if (!storeId) {
      box.innerHTML = '<span class="hint">매장을 먼저 추가하세요</span>';
      return;
    }
    const { data, error } = await sb.rpc('cash_status', { p_store_id: storeId });
    if (state.view !== 'sell') return;
    if (error) return (box.innerHTML = `<span class="hint">시재 정보를 불러올 수 없습니다</span>`);
    cashState = data;
    box.innerHTML = data?.open
      ? `<div class="cash-chip open"><span>🟢 영업 중 · 예상 현금 <b>${won(data.expected)}</b></span>
          <button class="btn small" id="cashMove">입출금</button><button class="btn small" id="cashClose">마감</button></div>`
      : `<div class="cash-chip"><span>⚪ 영업 전</span><button class="btn small primary" id="cashOpen">영업 시작 (시재 입력)</button></div>`;
    const o = $('#cashOpen');
    if (o) o.onclick = openCashDialog;
    const m = $('#cashMove');
    if (m) m.onclick = cashMoveDialog;
    const c = $('#cashClose');
    if (c) c.onclick = closeCashDialog;
  }

  function openCashDialog() {
    modal(
      `<h3>영업 시작</h3>
      <p class="hint">돈통에 넣어둔 거스름돈(시작 시재)을 입력하세요.</p>
      <label class="field"><span>시작 시재 (원)</span><input type="text" inputmode="numeric" id="ocAmt" placeholder="예: 100000"></label>
      <label class="field"><span>메모</span><input type="text" id="ocMemo"></label>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>취소</button><button class="btn primary" data-ok>영업 시작</button></div>`,
      (bg, close) => {
        $('#ocAmt', bg).focus();
        $('[data-x]', bg).onclick = () => close();
        $('[data-ok]', bg).onclick = (e) =>
          busy(e.target, async () => {
            const { error } = await sb.rpc('open_cash', {
              p_store_id: sellStoreId(),
              p_opening: numVal($('#ocAmt', bg).value) ?? 0,
              p_memo: $('#ocMemo', bg).value,
            });
            if (error) return ($('[data-err]', bg).textContent = errText(error));
            close();
            toast('영업을 시작했습니다');
            loadCash();
            focusScanInput();
          });
      }
    );
  }

  function cashMoveDialog() {
    modal(
      `<h3>입출금 기록</h3>
      <div class="seg" id="mvKind"><button type="button" data-k="in" class="active">입금 (잔돈 보충 등)</button><button type="button" data-k="out">출금 (지출 등)</button></div>
      <label class="field" style="margin-top:12px"><span>금액 (원)</span><input type="text" inputmode="numeric" id="mvAmt"></label>
      <label class="field"><span>메모 (예: 택배비, 잔돈 보충)</span><input type="text" id="mvMemo"></label>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>취소</button><button class="btn primary" data-ok>기록</button></div>`,
      (bg, close) => {
        let kind = 'in';
        bg.querySelectorAll('[data-k]').forEach(
          (b) =>
            (b.onclick = () => {
              kind = b.dataset.k;
              bg.querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('active', x === b));
            })
        );
        $('[data-x]', bg).onclick = () => close();
        $('[data-ok]', bg).onclick = (e) =>
          busy(e.target, async () => {
            const { error } = await sb.rpc('cash_move', {
              p_session_id: cashState.session_id,
              p_kind: kind,
              p_amount: numVal($('#mvAmt', bg).value) ?? 0,
              p_memo: $('#mvMemo', bg).value,
            });
            if (error) return ($('[data-err]', bg).textContent = errText(error));
            close();
            toast('기록했습니다');
            loadCash();
          });
      }
    );
  }

  const DENOMS = [50000, 10000, 5000, 1000, 500, 100];
  function closeCashDialog() {
    const c = cashState;
    modal(
      `<h3>영업 마감</h3>
      <div class="cash-breakdown">
        <div><span>시작 시재</span><b>${won(c.opening_cash)}</b></div>
        <div><span>+ 현금 매출</span><b>${won(c.cash_sales)}</b></div>
        <div><span>+ 입금</span><b>${won(c.moves_in)}</b></div>
        <div><span>− 출금</span><b>${won(c.moves_out)}</b></div>
        <div class="exp"><span>= 있어야 할 현금</span><b>${won(c.expected)}</b></div>
      </div>
      <p class="hint" style="margin:10px 0 6px">돈통 현금을 권종별로 세어 입력하세요 (또는 아래 합계에 바로 입력)</p>
      <div class="denoms">${DENOMS.map(
        (d) => `<label><span>${d.toLocaleString('ko-KR')}원</span><input type="text" inputmode="numeric" data-d="${d}" placeholder="0"> 개</label>`
      ).join('')}</div>
      <label class="field"><span>실제 현금 합계 (원)</span><input type="text" inputmode="numeric" id="ccCount"></label>
      <div class="cash-total change"><span>과부족</span><b id="ccDiff">-</b></div>
      <label class="field"><span>메모</span><input type="text" id="ccMemo"></label>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>취소</button><button class="btn primary" data-ok>마감하기</button></div>`,
      (bg, close) => {
        const count = $('#ccCount', bg);
        const showDiff = () => {
          const v = numVal(count.value);
          const el = $('#ccDiff', bg);
          if (v == null) return (el.textContent = '-');
          const d = v - c.expected;
          el.textContent = d === 0 ? '0원 (딱 맞음)' : d > 0 ? `+${won(d)} 남음` : `${won(-d)} 부족`;
          el.classList.toggle('short', d < 0);
        };
        bg.querySelectorAll('[data-d]').forEach(
          (inp) =>
            (inp.oninput = () => {
              let sum = 0;
              bg.querySelectorAll('[data-d]').forEach((x) => (sum += (numVal(x.value) ?? 0) * Number(x.dataset.d)));
              count.value = sum;
              showDiff();
            })
        );
        count.oninput = showDiff;
        $('[data-x]', bg).onclick = () => close();
        $('[data-ok]', bg).onclick = (e) =>
          busy(e.target, async () => {
            const v = numVal(count.value);
            if (v == null) return ($('[data-err]', bg).textContent = '실제 현금을 입력하세요');
            const { data, error } = await sb.rpc('close_cash', { p_session_id: c.session_id, p_counted: v, p_memo: $('#ccMemo', bg).value });
            if (error) return ($('[data-err]', bg).textContent = errText(error));
            close();
            const d = data.difference;
            toast(`마감 완료 · 과부족 ${d === 0 ? '없음' : d > 0 ? `+${won(d)}` : `-${won(-d)}`}`);
            loadCash();
          });
      }
    );
  }

  // ---------------- 정산 ----------------
  const settle = { from: null, to: null, store: null, rows: [] };

  function viewSettle() {
    state.view = 'settle';
    const today = kstToday();
    if (!settle.from) {
      settle.from = today;
      settle.to = today;
    }
    const lockStore = !isAdmin();
    if (lockStore) settle.store = state.me.store_id;
    shell(
      'settle',
      `<h1>정산</h1>
      <div class="card form" style="max-width:none">
        <div class="row">
          <label class="field"><span>시작일</span><input type="date" id="sFrom" value="${settle.from}"></label>
          <label class="field"><span>종료일</span><input type="date" id="sTo" value="${settle.to}"></label>
          <label class="field"><span>매장</span><select id="sStore" ${lockStore ? 'disabled' : ''}>
            ${lockStore ? '' : `<option value="">전체 매장</option>`}
            ${state.stores.map((s) => `<option value="${s.id}" ${String(settle.store) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select></label>
        </div>
        <div class="row quick">
          <button class="btn small" data-q="today">오늘</button>
          <button class="btn small" data-q="yesterday">어제</button>
          <button class="btn small" data-q="week">최근 7일</button>
          <button class="btn small" data-q="month">이번 달</button>
          <span></span>
        </div>
      </div>
      <div id="sTotals" style="margin-top:14px"></div>
      <div id="sBySeller"></div>
      <div id="sCash"></div>
      <div class="row" style="margin:18px 0 8px"><h2 style="margin:0">영수증 목록</h2><span></span>
        <button class="btn small" id="sCsv">엑셀(CSV) 받기</button><button class="btn small" id="sPrint">인쇄</button></div>
      <div id="sList"></div>`
    );
    const upd = () => {
      settle.from = $('#sFrom').value || today;
      settle.to = $('#sTo').value || settle.from;
      if (settle.to < settle.from) settle.to = settle.from;
      if (!lockStore) settle.store = $('#sStore').value || null;
      loadSettle();
    };
    $('#sFrom').onchange = upd;
    $('#sTo').onchange = upd;
    $('#sStore').onchange = upd;
    root.querySelectorAll('[data-q]').forEach(
      (b) =>
        (b.onclick = () => {
          const q = b.dataset.q;
          let f = today;
          let t = today;
          if (q === 'yesterday') f = t = shiftDate(today, -1);
          if (q === 'week') f = shiftDate(today, -6);
          if (q === 'month') f = `${today.slice(0, 8)}01`;
          $('#sFrom').value = f;
          $('#sTo').value = t;
          upd();
        })
    );
    $('#sCsv').onclick = () => {
      const head = ['판매일시', '영수증번호', '매장', '상품코드', '상품명', '판매가', '영수증 결제금액', '할인', '결제수단', '판매자', '상태'];
      const lines = [];
      for (const r of settle.rows) {
        const st = r.status === 'cancelled' ? '취소' : '완료';
        for (const i of r.sale_items || []) {
          lines.push(
            [
              new Date(r.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }),
              r.receipt_no,
              storeName(r.store_id),
              i.code,
              i.name,
              i.price,
              r.total,
              r.discount,
              PAY_LABEL[r.payment] || '',
              personName(r.created_by),
              i.status === 'refunded' ? '환불' : st,
            ]
              .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
              .join(',')
          );
        }
      }
      const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sales_${settle.from}_${settle.to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    $('#sPrint').onclick = () => window.print();
    loadSettle();
  }

  async function loadSettle() {
    if (!$('#sList')) return;
    let rows;
    let sessions = [];
    try {
      rows = await fetchSales(settle.from, settle.to, settle.store);
      let cq = sb
        .from('cash_sessions')
        .select('*')
        .gte('opened_at', kstStart(settle.from))
        .lt('opened_at', kstStart(shiftDate(settle.to, 1)))
        .order('opened_at', { ascending: false });
      if (settle.store) cq = cq.eq('store_id', Number(settle.store));
      const { data } = await cq;
      sessions = data || [];
    } catch (e) {
      return toast(errText(e), 'error');
    }
    if (state.view !== 'settle') return;
    settle.rows = rows;
    const period = settle.from === settle.to ? fmtDate(settle.from) : `${fmtDate(settle.from)} ~ ${fmtDate(settle.to)}`;
    $('#sTotals').innerHTML = `<p class="hint" style="margin:0 0 6px">${period} · ${settle.store ? esc(storeName(Number(settle.store))) : '전체 매장'}</p>${totalsHtml(
      salesTotals(rows)
    )}`;

    const bySeller = {};
    for (const r of rows) {
      if (r.status !== 'completed') continue;
      const k = r.created_by || '-';
      bySeller[k] = bySeller[k] || { count: 0, total: 0 };
      bySeller[k].count++;
      bySeller[k].total += (r.total || 0) - (r.refunded_amount || 0);
    }
    $('#sBySeller').innerHTML = Object.keys(bySeller).length
      ? `<h2>판매자별</h2><div class="table-wrap"><table><tr><th>판매자</th><th>결제 건수</th><th>금액</th></tr>${Object.entries(bySeller)
          .sort((a, b) => b[1].total - a[1].total)
          .map(([k, v]) => `<tr><td>${esc(personName(k))}</td><td>${v.count}건</td><td>${won(v.total)}</td></tr>`)
          .join('')}</table></div>`
      : '';

    $('#sCash').innerHTML = sessions.length
      ? `<h2>시재 기록</h2><div class="table-wrap"><table>
        <tr><th>매장</th><th>영업 시작</th><th>마감</th><th>시작 시재</th><th>있어야 할 현금</th><th>실제 현금</th><th>과부족</th><th>메모</th></tr>
        ${sessions
          .map((c) => {
            const d = c.difference;
            return `<tr><td>${esc(storeName(c.store_id))}</td>
              <td>${fmt(c.opened_at)}<br><small class="hint">${esc(personName(c.opened_by))}</small></td>
              <td>${c.status === 'open' ? '<b>영업 중</b>' : `${fmt(c.closed_at)}<br><small class="hint">${esc(personName(c.closed_by))}</small>`}</td>
              <td>${won(c.opening_cash)}</td><td>${c.expected_cash != null ? won(c.expected_cash) : '-'}</td>
              <td>${c.counted_cash != null ? won(c.counted_cash) : '-'}</td>
              <td class="${d < 0 ? 'neg' : d > 0 ? 'pos' : ''}">${d == null ? '-' : d === 0 ? '0원' : d > 0 ? `+${won(d)}` : `-${won(-d)}`}</td>
              <td style="white-space:normal;min-width:120px">${esc(c.memo)}</td></tr>`;
          })
          .join('')}</table></div>`
      : '';

    $('#sList').innerHTML = rows.length
      ? `<div class="table-wrap"><table>
        <tr><th>일시</th><th>영수증</th><th>매장</th><th>상품</th><th>결제 금액</th><th>결제</th><th>판매자</th><th>상태</th></tr>
        ${rows
          .map(
            (r) => `<tr class="click ${r.status}" data-sale="${r.id}"><td>${fmt(r.created_at)}</td><td>${esc(r.receipt_no)}</td>
            <td>${esc(storeName(r.store_id))}</td><td style="white-space:normal">${itemsLabel(r)}</td>
            <td>${won(r.total)}${r.discount ? `<br><small class="hint">할인 ${won(r.discount)}</small>` : ''}${
              r.refunded_amount ? `<br><small class="hint">환불 ${won(r.refunded_amount)}</small>` : ''
            }</td>
            <td><span class="pay ${r.payment || ''}">${PAY_LABEL[r.payment] || '-'}</span></td>
            <td>${esc(personName(r.created_by))}</td><td>${r.status === 'cancelled' ? '취소' : '완료'}</td></tr>`
          )
          .join('')}</table></div><p class="hint">줄을 누르면 영수증을 보고 출력·취소할 수 있습니다.</p>`
      : '<div class="empty">이 기간에 판매 내역이 없습니다</div>';
    root.querySelectorAll('#sList [data-sale]').forEach((el) => (el.onclick = () => openReceipt(Number(el.dataset.sale), loadSettle)));
  }

  // ---------------- 라벨 출력 (QR 또는 바코드 선택 → 인쇄 / 이미지 저장) ----------------
  const LABEL_SIZES = {
    '50x30': { name: '라벨프린터 50×30mm', w: 50, h: 30 },
    '40x30': { name: '라벨프린터 40×30mm', w: 40, h: 30 },
    '60x40': { name: '라벨프린터 60×40mm', w: 60, h: 40 },
    a4: { name: 'A4 스티커 21칸 (63.5×38.1mm)', w: 63.5, h: 38.1, sheet: { cols: 3, rows: 7, top: 15.15, left: 7.2, pitchX: 66, pitchY: 38.1 } },
  };
  const LABEL_TYPES = { barcode: '바코드', qr: 'QR코드' }; // 기본은 바코드
  const LABEL_FONT = '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", Arial, sans-serif';
  const DPI = 300;
  const mmPx = (v) => Math.round((v / 25.4) * DPI);
  const pref = (k, v) => {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch {}
    return null;
  };

  // 글자가 칸보다 길면 … 으로 줄임
  function fitText(ctx, text, maxW) {
    let t = String(text || '');
    if (ctx.measureText(t).width <= maxW) return t;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  // 라벨 1장을 300dpi 이미지(canvas)로 그림. 미리보기·인쇄·저장 모두 이 그림을 사용
  function renderLabel(p, size, type) {
    const W = mmPx(size.w);
    const H = mmPx(size.h);
    const pad = mmPx(1.5);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'top';
    const nameFont = mmPx(Math.max(2.4, Math.min(3.4, size.h * 0.1)));
    const subFont = Math.round(nameFont * 0.8);
    const price = p.price != null ? won(p.price) : '';

    if (type === 'qr') {
      // QR → 그 밑에 상품명 → 코드 · 가격
      const textH = Math.round(nameFont * 1.25 + subFont * 1.2);
      const qr = window.qrcode(0, 'M');
      qr.addData(p.code);
      qr.make();
      const n = qr.getModuleCount() + 4; // 사방 2칸 여백(스캔용)
      const box = Math.min(H - pad * 2 - textH, W - pad * 2);
      const cell = Math.max(1, Math.floor(box / n));
      const qrPx = cell * n;
      const x0 = Math.round((W - qrPx) / 2);
      const y0 = pad;
      for (let r = 0; r < n - 4; r++)
        for (let col = 0; col < n - 4; col++)
          if (qr.isDark(r, col)) ctx.fillRect(x0 + (col + 2) * cell, y0 + (r + 2) * cell, cell, cell);
      ctx.textAlign = 'center';
      let y = y0 + qrPx;
      ctx.font = `700 ${nameFont}px ${LABEL_FONT}`;
      ctx.fillText(fitText(ctx, p.name || p.code, W - pad * 2), W / 2, y);
      y += Math.round(nameFont * 1.25);
      ctx.font = `400 ${subFont}px ${LABEL_FONT}`;
      ctx.fillText(fitText(ctx, [p.code, price].filter(Boolean).join(' · '), W - pad * 2), W / 2, y);
    } else {
      // 상품명(+가격) → 그 밑에 바코드 → 코드번호
      const quiet = Math.max(pad, mmPx(3)); // 바코드 좌우 여백(스캔용)
      ctx.font = `700 ${nameFont}px ${LABEL_FONT}`;
      ctx.textAlign = 'left';
      let priceW = 0;
      if (price) {
        priceW = ctx.measureText(price).width + mmPx(1.5);
        ctx.textAlign = 'right';
        ctx.fillText(price, W - pad, pad);
        ctx.textAlign = 'left';
      }
      ctx.fillText(fitText(ctx, p.name || '', W - pad * 2 - priceW), pad, pad);
      const barTop = pad + Math.round(nameFont * 1.35);
      const barBottom = H - pad - Math.round(subFont * 1.25);
      const tmp = document.createElement('canvas');
      window.JsBarcode(tmp, p.code, { format: 'CODE128', displayValue: false, margin: 0, width: 1, height: 10, background: '#fff' });
      const scale = Math.max(1, Math.floor((W - quiet * 2) / tmp.width)); // 막대 폭을 정수배로 → 선명
      const bw = tmp.width * scale;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, Math.round((W - bw) / 2), barTop, bw, barBottom - barTop);
      ctx.font = `400 ${subFont}px ${LABEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(p.code, W / 2, barBottom + Math.round(subFont * 0.15));
    }
    return c;
  }

  function printLabels(images, size) {
    document.getElementById('printArea')?.remove();
    document.getElementById('printPage')?.remove();
    const area = document.createElement('div');
    area.id = 'printArea';
    const img = (src) => `<img src="${src}" style="width:${size.w}mm;height:${size.h}mm;display:block">`;
    if (!size.sheet) {
      area.innerHTML = images.map((src) => `<div class="label-page">${img(src)}</div>`).join('');
    } else {
      const sh = size.sheet;
      const per = sh.cols * sh.rows;
      let out = '';
      for (let i = 0; i < images.length; i += per) {
        out += `<div class="a4-page">${images
          .slice(i, i + per)
          .map((src, j) => {
            const left = sh.left + (j % sh.cols) * sh.pitchX;
            const top = sh.top + Math.floor(j / sh.cols) * sh.pitchY;
            return `<div style="position:absolute;left:${left}mm;top:${top}mm">${img(src)}</div>`;
          })
          .join('')}</div>`;
      }
      area.innerHTML = out;
    }
    document.body.appendChild(area);
    const st = document.createElement('style');
    st.id = 'printPage';
    st.textContent = size.sheet ? '@page { size: A4; margin: 0 }' : `@page { size: ${size.w}mm ${size.h}mm; margin: 0 }`;
    document.head.appendChild(st);
    const cleanup = () => {
      area.remove();
      st.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    // 이미지가 다 준비된 뒤 인쇄
    Promise.all([...area.querySelectorAll('img')].map((i) => (i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r))))).then(() =>
      window.print()
    );
  }

  function downloadCanvas(canvas, filename) {
    return new Promise((resolve) =>
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        resolve();
      }, 'image/png')
    );
  }

  async function viewLabels(ids) {
    state.view = 'labels';
    shell('list', `<div class="empty">불러오는 중…</div>`);
    await Promise.all([loadScript('./vendor/qrcode-generator-1.4.4.js'), loadScript('./vendor/jsbarcode-3.11.6.min.js')]);
    let qb = sb.from('products').select('*');
    if (ids.length) qb = qb.in('id', ids);
    else {
      qb = qb.eq('status', 'available').order('created_at', { ascending: false }).limit(100);
      if (!isAdmin() && state.me.store_id) qb = qb.eq('store_id', state.me.store_id);
    }
    const { data, error } = await qb;
    if (state.view !== 'labels') return;
    if (error) return toast(errText(error), 'error');
    const products = data || [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checked = new Set(ids.length ? products.map((p) => p.id) : products.filter((p) => new Date(p.created_at) >= today).map((p) => p.id));
    let sizeKey = LABEL_SIZES[pref('labelSize')] ? pref('labelSize') : '50x30';
    let type = 'barcode'; // 항상 바코드로 시작, [QR코드]를 눌러야 바뀜

    shell(
      'list',
      `<p><a href="${ids.length === 1 ? `#/p/${ids[0]}` : '#/'}">← 돌아가기</a></p>
      <h1>라벨 출력</h1>
      <div class="card form" style="max-width:none">
        <label class="field"><span>라벨 종류</span>
          <div class="seg" id="ltype">${Object.entries(LABEL_TYPES)
            .map(([k, v]) => `<button type="button" data-type="${k}" class="${k === type ? 'active' : ''}">${v}</button>`)
            .join('')}</div></label>
        <div class="row">
          <label class="field"><span>라벨 크기</span><select id="lsize">${Object.entries(LABEL_SIZES)
            .map(([k, v]) => `<option value="${k}" ${k === sizeKey ? 'selected' : ''}>${v.name}</option>`)
            .join('')}</select></label>
          <label class="field"><span>상품당 장수 (인쇄)</span><input type="number" id="lcopies" min="1" max="20" value="1"></label>
        </div>
        <div class="row">
          <button class="btn primary" id="lprint">🖨 인쇄</button>
          <button class="btn" id="lsave">⬇ 이미지로 저장 (PNG)</button>
        </div>
        <p class="hint">인쇄 창에서 <b>여백: 없음</b>, <b>배율: 100%(실제 크기)</b>로 설정하세요. 저장한 이미지는 라벨프린터 전용 프로그램에서 불러와 출력할 수도 있습니다. 미리보기의 라벨을 누르면 그 라벨만 저장됩니다.</p>
      </div>
      ${
        ids.length
          ? ''
          : `<h2>출력할 상품 <small class="hint">(판매중 · 최근 100개, 오늘 등록한 상품이 미리 선택됨)</small></h2>
        <div class="row" style="margin-bottom:8px"><button class="btn small" id="lall">전체 선택</button><button class="btn small" id="lnone">선택 해제</button><span></span></div>
        <div class="pick-list">${
          products
            .map(
              (p) => `<label class="pick"><input type="checkbox" value="${p.id}" ${checked.has(p.id) ? 'checked' : ''}>
              <img src="${esc(photoUrl(p.thumb_path || p.photo_path))}" alt=""><span><b>${esc(p.code)}</b><br><small>${esc(p.name)} · ${esc(
                storeName(p.store_id)
              )}</small></span></label>`
            )
            .join('') || '<div class="empty">판매중인 상품이 없습니다</div>'
        }</div>`
      }
      <h2>미리보기</h2>
      <div id="lpreview" class="label-preview"></div>`
    );

    const selected = () => products.filter((p) => checked.has(p.id));
    const fileName = (p) => `${p.code}_${type === 'qr' ? 'QR' : 'barcode'}.png`;
    const renderPreview = () => {
      const size = LABEL_SIZES[sizeKey];
      const list = selected();
      const el = $('#lpreview');
      if (!list.length) return (el.innerHTML = '<div class="hint">선택된 상품이 없습니다</div>');
      el.innerHTML = '';
      list.slice(0, 12).forEach((p) => {
        const img = document.createElement('img');
        img.src = renderLabel(p, size, type).toDataURL('image/png');
        img.className = 'label-img';
        img.style.width = `${size.w * 1.4}mm`;
        img.title = `${p.code} - 눌러서 이미지 저장`;
        img.onclick = () => downloadCanvas(renderLabel(p, size, type), fileName(p));
        el.appendChild(img);
      });
      if (list.length > 12) el.insertAdjacentHTML('beforeend', `<div class="hint">외 ${list.length - 12}개</div>`);
    };
    renderPreview();

    $('#ltype').querySelectorAll('button').forEach(
      (b) =>
        (b.onclick = () => {
          type = b.dataset.type;
          $('#ltype').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
          renderPreview();
        })
    );
    $('#lsize').onchange = (e) => {
      sizeKey = e.target.value;
      pref('labelSize', sizeKey);
      renderPreview();
    };
    root.querySelectorAll('.pick input').forEach(
      (cb) =>
        (cb.onchange = () => {
          const id = Number(cb.value);
          cb.checked ? checked.add(id) : checked.delete(id);
          renderPreview();
        })
    );
    const setAll = (on) => {
      root.querySelectorAll('.pick input').forEach((cb) => {
        cb.checked = on;
        on ? checked.add(Number(cb.value)) : checked.delete(Number(cb.value));
      });
      renderPreview();
    };
    if ($('#lall')) $('#lall').onclick = () => setAll(true);
    if ($('#lnone')) $('#lnone').onclick = () => setAll(false);

    $('#lprint').onclick = () => {
      const list = selected();
      if (!list.length) return toast('출력할 상품을 선택하세요', 'error');
      const copies = Math.min(20, Math.max(1, Number($('#lcopies').value) || 1));
      const size = LABEL_SIZES[sizeKey];
      const images = list.flatMap((p) => Array(copies).fill(renderLabel(p, size, type).toDataURL('image/png')));
      printLabels(images, size);
    };
    $('#lsave').onclick = async () => {
      const list = selected();
      if (!list.length) return toast('저장할 상품을 선택하세요', 'error');
      const size = LABEL_SIZES[sizeKey];
      if (list.length > 1) toast(`${list.length}개 이미지를 저장합니다. 브라우저가 "여러 파일 다운로드"를 물으면 허용하세요`);
      for (const p of list) {
        await downloadCanvas(renderLabel(p, size, type), fileName(p));
        await new Promise((r) => setTimeout(r, 350));
      }
    };
  }

  // ---------------- 라우터 ----------------
  function route() {
    if (!state.me) return renderLogin();
    if (licenseBlocked()) return renderExpired();
    const full = location.hash.replace(/^#\/?/, '');
    const [h, qs = ''] = full.split('?');
    const params = new URLSearchParams(qs);
    let m;
    state.detailId = null;
    if (h !== 'sell' && h !== 'scan') stopScanner();
    if (h === 'sell' || h === 'scan') return viewSell();
    if (h === 'settle') return viewSettle();
    if (h === 'account') return viewAccount();
    // 캐셔는 상품 판매 · 정산 · 내정보만 사용
    if (isCashier()) {
      history.replaceState(null, '', '#/sell');
      return viewSell();
    }
    if (h === 'new') return viewForm(null, normCode(params.get('code') || ''));
    if (h === 'labels') return viewLabels((params.get('ids') || '').split(',').map(Number).filter(Boolean));
    if ((m = /^p\/(\d+)\/edit$/.exec(h))) return viewForm(Number(m[1]));
    if ((m = /^p\/(\d+)$/.exec(h))) return viewDetail(Number(m[1]));
    if (h === 'admin') return viewAdmin();
    if (h === 'members') return viewMembers();
    if (h === 'license') return viewLicense();
    return viewList();
  }
  window.addEventListener('hashchange', route);

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      state.me = null;
      goHome();
      stopRealtime();
      renderLogin();
    }
  });

  (async function boot() {
    root.innerHTML = '<div class="login-wrap"><div class="hint">불러오는 중…</div></div>';
    try {
      const {
        data: { session },
      } = await sb.auth.getSession();
      if (!session) return renderLogin();
      if (!(await loadMe())) {
        await sb.auth.signOut();
        return renderLogin('등록되지 않았거나 비활성화된 계정입니다');
      }
      await afterLogin();
    } catch (e) {
      renderLogin(errText(e));
    }
  })();
})();
