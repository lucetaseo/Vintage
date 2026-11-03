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
  const ROLE_LABEL = { super: '총관리자', admin: '관리자', manager: '실장' };
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
    const { data } = await sb.from('profiles').select('id, username, name, role, store_id, active');
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
        scheduleRefresh();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'product_events' }, onEvent)
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
    if (b) b.hidden = false;
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
          ${link('#/', 'list', '상품목록')}
          ${link('#/new', 'new', '+ 등록')}
          ${link('#/scan', 'scan', '스캔')}
          ${isAdmin() ? link('#/admin', 'admin', '관리자') : ''}
          ${isSuper() ? link('#/license', 'license', '이용관리') : ''}
          ${link('#/account', 'account', '내정보')}
          <a href="#" id="installBtn" ${installPrompt ? '' : 'hidden'}>앱 설치</a>
        </nav>
        <div class="who">${esc(me.name)} · ${me.role === 'manager' ? esc(storeName(me.store_id)) : ROLE_LABEL[me.role]}</div>
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
        await afterLogin();
        toast(`총관리자 계정(${username})이 만들어졌습니다`);
      });
    };
  }

  async function afterLogin() {
    await loadLicense();
    if (licenseBlocked()) return renderExpired();
    await Promise.all([loadStores(), loadPeople()]);
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
         <a class="btn addbtn" href="#/scan">📷 스캔</a>
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
                   ${p.sold_price != null ? `<br>판매가 ${won(p.sold_price)}` : ''}</div>`
                : ''
            }
            ${
              !manage && !sold
                ? `<p class="hint">이 상품은 <b>${esc(storeName(p.store_id))}</b> 상품입니다. 판매 처리는 해당 매장에서 합니다.</p>`
                : ''
            }
            <div class="actions">
              ${manage && !sold ? `<button class="btn sell block" id="sellBtn">판매 처리</button>` : ''}
              ${manage && sold ? `<button class="btn block" id="unsellBtn">판매 취소 (되돌리기)</button>` : ''}
              <a class="btn" href="#/labels?ids=${p.id}" style="text-align:center;text-decoration:none">🏷 라벨 출력 (QR · 바코드)</a>
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
        const v = await promptBox(`${p.code} 판매 처리`, '판매 가격 (원)', p.price ?? '', '판매 완료', 'sell', 'numeric');
        if (v === null) return;
        const price = String(v).replace(/[^0-9]/g, '');
        await busy(sellBtn, async () => {
          const { error: e } = await sb.rpc('sell_product', { p_id: p.id, p_sold_price: price === '' ? null : Number(price) });
          if (e) return toast(errText(e), 'error');
          toast(`${p.code} 판매완료 처리됨 - 모든 매장에 반영됩니다`);
          viewDetail(p.id, true);
        });
      };
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
    const users = Object.values(state.people).sort(
      (a, b) => {
        const order = { super: 0, admin: 1, manager: 2 };
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
            <td>${u.role === 'manager' ? esc(storeName(u.store_id)) : '전체'}</td>
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
          <label class="field"><span>권한</span><select name="role"><option value="manager">실장</option><option value="admin">관리자</option></select></label>
          <label class="field"><span>소속 매장</span><select name="store_id">${storeOpts(state.stores[0]?.id)}</select></label>
        </div>
        <label class="field"><span>초기 비밀번호 (6자 이상)</span><input type="text" name="password" required minlength="6"></label>
        <div class="err" id="uerr"></div>
        <button class="btn primary">계정 만들기</button>
      </form>

      <h2>매장</h2>
      <div class="card">
        ${state.stores
          .map(
            (s) => `<div class="row" style="margin-bottom:8px"><span>${esc(s.name)} <small class="hint">재고 ${s.available}</small></span>
            <button class="btn small" data-rename="${s.id}">이름 변경</button></div>`
          )
          .join('')}
        <button class="btn" id="addStore" style="margin-top:6px">+ 매장 추가</button>
      </div>`
    );

    const nf = $('#newUser');
    nf.role.onchange = () => (nf.store_id.disabled = nf.role.value !== 'manager');
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
        (b.onclick = async () => {
          const s = state.storeMap[b.dataset.rename];
          const name = await promptBox('매장 이름 변경', '매장 이름', s.name);
          if (!name || !name.trim()) return;
          const { error } = await sb.from('stores').update({ name: name.trim() }).eq('id', s.id);
          if (error) return toast(errText(error), 'error');
          viewAdmin();
        })
    );
    $('#addStore').onclick = async () => {
      const name = await promptBox('매장 추가', '매장 이름', `${state.stores.length + 1}호점`);
      if (!name || !name.trim()) return;
      const { error } = await sb.from('stores').insert({ name: name.trim() });
      if (error) return toast(/duplicate/i.test(error.message) ? '이미 있는 매장 이름입니다' : errText(error), 'error');
      viewAdmin();
    };
  }

  function editUser(u, storeOpts) {
    modal(
      `<h3>${esc(u.username)} 수정</h3>
      <label class="field"><span>이름</span><input type="text" name="name" value="${esc(u.name)}"></label>
      <div class="row">
        <label class="field"><span>권한</span><select name="role" ${u.role === 'super' ? 'disabled' : ''}>
          ${u.role === 'super' ? '<option value="super" selected>총관리자</option>' : ''}
          <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>실장</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>관리자</option></select></label>
        <label class="field"><span>매장</span><select name="store_id" ${u.role !== 'manager' ? 'disabled' : ''}>${storeOpts(u.store_id)}</select></label>
      </div>
      <label class="field"><span>새 비밀번호 (바꿀 때만)</span><input type="text" name="password" placeholder="비워두면 유지"></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> 사용 가능 (해제 시 로그인 정지)</label>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>닫기</button><button class="btn primary" data-ok>저장</button></div>`,
      (bg, close) => {
        const g = (n) => $(`[name=${n}]`, bg);
        g('role').onchange = () => (g('store_id').disabled = g('role').value !== 'manager');
        $('[data-x]', bg).onclick = () => close();
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
        <dt>매장</dt><dd>${me.role === 'manager' ? esc(storeName(me.store_id)) : '전체'}</dd></dl>
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
            : `${installPrompt ? '<button class="btn primary" id="install2">이 기기에 앱 설치</button>' : ''}
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

  // ---------------- 스캔 판매 ----------------
  let scanner = null;
  let lastScan = { code: '', at: 0 };

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

  function resumeScanner() {
    try {
      if (scanner) scanner.resume();
    } catch {}
    const input = $('#scanInput');
    if (input && !matchMedia('(pointer: coarse)').matches) input.focus();
  }

  function viewScan() {
    state.view = 'scan';
    shell(
      'scan',
      `<h1>스캔</h1>
      <div class="scan-wrap">
        <div>
          <div id="reader" class="reader"></div>
          <button class="btn primary block" id="camBtn">📷 카메라로 찍기</button>
          <label class="field" style="margin-top:14px"><span>바코드 스캐너 / 직접 입력</span>
            <input type="text" id="scanInput" placeholder="상품코드 입력 후 Enter" autocomplete="off" autocapitalize="characters" enterkeyhint="go"></label>
          <p class="hint">QR코드와 바코드 모두 됩니다. 찍으면 상품이 뜨고, [판매 완료]를 눌러야 판매 처리됩니다.</p>
        </div>
        <div id="scanResult"></div>
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
    if (!matchMedia('(pointer: coarse)').matches) input.focus();
    $('#camBtn').onclick = startCamera;
    if (matchMedia('(pointer: coarse)').matches) startCamera(); // 휴대폰은 바로 카메라 켜기
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
      if (state.view !== 'scan') return;
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
      if (state.view !== 'scan') {
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

  async function handleScan(raw) {
    const el = $('#scanResult');
    if (!el) return;
    const code = normCode(raw);
    navigator.vibrate?.(60);
    el.innerHTML = `<div class="card empty">${esc(code)} 찾는 중…</div>`;
    const { data: p, error } = await sb.from('products').select('*').eq('code', code).maybeSingle();
    if (state.view !== 'scan') return;
    if (error) {
      el.innerHTML = `<div class="scan-card none"><strong>${esc(errText(error))}</strong></div>`;
      return resumeScanner();
    }
    const again = `<button class="btn" data-again>다시 스캔</button>`;
    if (!p) {
      el.innerHTML = `<div class="scan-card none">
        <strong>등록되지 않은 코드</strong><div class="bigcode">${esc(code)}</div>
        <div class="actions"><a class="btn primary" href="#/new?code=${encodeURIComponent(code)}" style="text-align:center;text-decoration:none">이 코드로 상품 등록</a>${again}</div></div>`;
    } else {
      const sold = p.status === 'sold';
      const manage = canManage(p.store_id);
      const head = `<img src="${esc(photoUrl(p.photo_path))}" alt="">
        <div class="bigcode">${esc(p.code)}</div>
        <div>${esc(p.name)}</div>
        <div class="scan-price">${won(p.price)}</div>
        <div class="hint">${esc(storeName(p.store_id))}</div>`;
      if (sold) {
        el.innerHTML = `<div class="scan-card sold">${head}
          <div class="soldbox">이미 판매된 상품입니다<br>${fmt(p.sold_at)} · ${esc(storeName(p.sold_store_id))} · ${esc(personName(p.sold_by))}</div>
          <div class="actions"><a class="btn" href="#/p/${p.id}" style="text-align:center;text-decoration:none">상세 보기</a>${again}</div></div>`;
      } else if (!manage) {
        el.innerHTML = `<div class="scan-card warn">${head}
          <div class="warnbox">${esc(storeName(p.store_id))} 상품입니다. 판매는 해당 매장에서 처리합니다.</div>
          <div class="actions"><a class="btn" href="#/p/${p.id}" style="text-align:center;text-decoration:none">상세 보기</a>${again}</div></div>`;
      } else {
        el.innerHTML = `<div class="scan-card ok">${head}
          <label class="field" style="margin-top:12px"><span>판매 가격 (원)</span>
            <input type="text" inputmode="numeric" id="soldPrice" value="${p.price ?? ''}"></label>
          <div class="actions"><button class="btn sell block" id="scanSell">판매 완료</button>${again}</div></div>`;
        $('#scanSell').onclick = (e) =>
          busy(e.target, async () => {
            const price = $('#soldPrice').value.replace(/[^0-9]/g, '');
            const { error: se } = await sb.rpc('sell_product', { p_id: p.id, p_sold_price: price === '' ? null : Number(price) });
            if (se) return toast(errText(se), 'error');
            el.innerHTML = `<div class="scan-card done"><strong>✅ ${esc(p.code)} 판매 완료</strong>
              <div class="hint">모든 매장에 반영되었습니다. 다음 상품을 찍으세요.</div></div>`;
            resumeScanner();
          });
      }
    }
    const a = $('[data-again]', el);
    if (a)
      a.onclick = () => {
        el.innerHTML = '';
        resumeScanner();
      };
  }

  // ---------------- 라벨 출력 (QR + 바코드) ----------------
  const LABEL_SIZES = {
    '50x30': { name: '라벨프린터 50×30mm', w: 50, h: 30 },
    '40x30': { name: '라벨프린터 40×30mm', w: 40, h: 30 },
    '60x40': { name: '라벨프린터 60×40mm', w: 60, h: 40 },
    a4: { name: 'A4 스티커 21칸 (63.5×38.1mm)', w: 63.5, h: 38.1, sheet: { cols: 3, rows: 7, top: 15.15, left: 7.2, pitchX: 66, pitchY: 38.1 } },
  };
  const pref = (k, v) => {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch {}
    return null;
  };

  function labelHtml(p, size) {
    const pad = 1.5;
    const qrMm = Math.min(size.h * 0.58, size.w * 0.42);
    const barH = size.h - qrMm - pad * 2 - 1.2;
    const qr = window.qrcode(0, 'M');
    qr.addData(p.code);
    qr.make();
    const qrSvg = qr.createSvgTag({ cellSize: 2, margin: 2, scalable: true });
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    window.JsBarcode(bar, p.code, { format: 'CODE128', displayValue: false, margin: 0, height: 50, width: 2 });
    const bw = bar.getAttribute('width');
    const bh = bar.getAttribute('height');
    bar.setAttribute('viewBox', `0 0 ${parseFloat(bw)} ${parseFloat(bh)}`);
    bar.setAttribute('preserveAspectRatio', 'none');
    bar.removeAttribute('width');
    bar.removeAttribute('height');
    bar.removeAttribute('style');
    const fs = Math.max(2.2, Math.min(3.2, size.h / 10));
    return `<div class="label" style="width:${size.w}mm;height:${size.h}mm;padding:${pad}mm">
      <div class="label-top" style="height:${qrMm}mm">
        <div class="label-qr" style="width:${qrMm}mm;height:${qrMm}mm">${qrSvg}</div>
        <div class="label-text" style="font-size:${fs}mm">
          <div class="label-code">${esc(p.code)}</div>
          <div class="label-name">${esc(p.name)}</div>
          <div class="label-price">${p.price != null ? won(p.price) : ''}</div>
        </div>
      </div>
      <div class="label-bar" style="height:${barH}mm;margin-top:1.2mm;padding:0 ${Math.max(0, 3 - pad)}mm">${bar.outerHTML}</div>
    </div>`;
  }

  function sheetHtml(items, size) {
    if (!size.sheet) return items.map((p) => `<div class="label-page">${labelHtml(p, size)}</div>`).join('');
    const sh = size.sheet;
    const per = sh.cols * sh.rows;
    let out = '';
    for (let i = 0; i < items.length; i += per) {
      out += `<div class="a4-page">${items
        .slice(i, i + per)
        .map((p, j) => {
          const c = j % sh.cols;
          const r = Math.floor(j / sh.cols);
          return `<div style="position:absolute;left:${sh.left + c * sh.pitchX}mm;top:${sh.top + r * sh.pitchY}mm">${labelHtml(p, size)}</div>`;
        })
        .join('')}</div>`;
    }
    return out;
  }

  function printLabels(items, sizeKey) {
    const size = LABEL_SIZES[sizeKey];
    document.getElementById('printArea')?.remove();
    document.getElementById('printPage')?.remove();
    const area = document.createElement('div');
    area.id = 'printArea';
    area.innerHTML = sheetHtml(items, size);
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
    setTimeout(() => window.print(), 50);
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
    let sizeKey = pref('labelSize') || '50x30';
    if (!LABEL_SIZES[sizeKey]) sizeKey = '50x30';

    shell(
      'list',
      `<p><a href="${ids.length === 1 ? `#/p/${ids[0]}` : '#/'}">← 돌아가기</a></p>
      <h1>라벨 출력</h1>
      <div class="card form" style="max-width:none">
        <div class="row">
          <label class="field"><span>라벨 종류</span><select id="lsize">${Object.entries(LABEL_SIZES)
            .map(([k, v]) => `<option value="${k}" ${k === sizeKey ? 'selected' : ''}>${v.name}</option>`)
            .join('')}</select></label>
          <label class="field"><span>상품당 장수</span><input type="number" id="lcopies" min="1" max="20" value="1"></label>
        </div>
        <button class="btn primary block" id="lprint">🖨 인쇄</button>
        <p class="hint">라벨 하나에 QR코드와 바코드가 함께 들어갑니다. 인쇄 창에서 <b>여백: 없음</b>, <b>배율: 100%(실제 크기)</b>로 설정하세요.</p>
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
    const renderPreview = () => {
      const size = LABEL_SIZES[sizeKey];
      const list = selected().slice(0, 6);
      $('#lpreview').innerHTML = list.length
        ? list.map((p) => labelHtml(p, size)).join('') + (selected().length > 6 ? `<div class="hint">외 ${selected().length - 6}개</div>` : '')
        : '<div class="hint">선택된 상품이 없습니다</div>';
    };
    renderPreview();
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
      const copies = Math.min(20, Math.max(1, Number($('#lcopies').value) || 1));
      const items = selected().flatMap((p) => Array(copies).fill(p));
      if (!items.length) return toast('출력할 상품을 선택하세요', 'error');
      printLabels(items, sizeKey);
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
    if (h !== 'scan') stopScanner();
    if (h === 'new') return viewForm(null, normCode(params.get('code') || ''));
    if (h === 'scan') return viewScan();
    if (h === 'labels') return viewLabels((params.get('ids') || '').split(',').map(Number).filter(Boolean));
    if ((m = /^p\/(\d+)\/edit$/.exec(h))) return viewForm(Number(m[1]));
    if ((m = /^p\/(\d+)$/.exec(h))) return viewDetail(Number(m[1]));
    if (h === 'admin') return viewAdmin();
    if (h === 'account') return viewAccount();
    if (h === 'license') return viewLicense();
    return viewList();
  }
  window.addEventListener('hashchange', route);

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      state.me = null;
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
