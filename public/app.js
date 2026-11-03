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
  const canManage = (storeId) => state.me && (state.me.role === 'admin' || state.me.store_id === storeId);
  const isAdmin = () => state.me?.role === 'admin';
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
          ${isAdmin() ? link('#/admin', 'admin', '관리자') : ''}
          ${link('#/account', 'account', '내정보')}
          <a href="#" id="installBtn" ${installPrompt ? '' : 'hidden'}>앱 설치</a>
        </nav>
        <div class="who">${esc(me.name)} · ${me.role === 'admin' ? '관리자' : esc(storeName(me.store_id))}</div>
      </header>
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
    const { data } = await sb.rpc('needs_setup');
    if (data === true && state.view === 'login') renderSetup();
  }

  function renderSetup() {
    state.view = 'setup';
    root.innerHTML = `
      <div class="login-wrap"><form class="card login" id="setupForm" autocomplete="off">
        <h1>VINTAGE</h1><p class="sub">처음 오셨네요! 최초 관리자 계정을 만드세요</p>
        <label class="field"><span>관리자 아이디 (영문/숫자)</span><input type="text" name="username" value="admin" autocapitalize="none" required></label>
        <label class="field"><span>이름</span><input type="text" name="name" value="관리자" required></label>
        <label class="field"><span>비밀번호 (6자 이상)</span><input type="password" name="password" autocomplete="new-password" minlength="6" required></label>
        <label class="field"><span>비밀번호 확인</span><input type="password" name="password2" autocomplete="new-password" minlength="6" required></label>
        <div class="err" id="setupErr"></div>
        <button class="btn primary block">관리자 만들기</button>
        <p class="hint" style="text-align:center;margin-top:14px">이 화면은 관리자가 생기면 다시 나오지 않습니다</p>
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
        confirmBox(
          '관리자 계정이 만들어졌습니다 🎉',
          `<p>아이디 <b>${esc(username)}</b> 로 로그인되었습니다.</p>
           <p><b>마지막으로 꼭 해주세요:</b><br>Supabase 대시보드 → Authentication → Sign In / Providers →
           <b>'Allow new users to sign up' 끄기</b><br>
           <span class="hint">(끄지 않으면 아무나 가입은 할 수 있어요. 데이터는 못 보지만 깔끔하게 막아두세요)</span></p>`,
          '확인했어요'
        );
      });
    };
  }

  async function afterLogin() {
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
        loadList(true);
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
      ? `<div class="empty">상품이 없습니다</div>`
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
  async function viewForm(id) {
    state.view = 'form';
    let p = null;
    if (id) {
      const { data } = await sb.from('products').select('*').eq('id', id).maybeSingle();
      p = data;
      if (!p) return shell('list', `<div class="empty">상품을 찾을 수 없습니다</div>`);
      if (!canManage(p.store_id)) return shell('list', `<div class="empty">다른 매장 상품은 수정할 수 없습니다</div>`);
    }
    const me = state.me;
    const storeLocked = !p && me.role !== 'admin';
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
          <div class="row"><input type="text" name="code" required value="${esc(p?.code || '')}" autocapitalize="characters">
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
      fillCode();
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
            toast(`${normCode(fields.p_code)} 등록 완료`);
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
    const { data, error } = await sb.functions.invoke('admin-users', { body });
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
      (a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === 'admin' ? -1 : 1)
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
            <td>${u.role === 'admin' ? '관리자' : '실장'}</td>
            <td>${u.role === 'manager' ? esc(storeName(u.store_id)) : '전체'}</td>
            <td>${u.active ? '사용중' : '정지'}</td>
            <td><button class="btn small" data-edit="${u.id}">수정</button></td></tr>`
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
    nf.role.onchange = () => (nf.store_id.disabled = nf.role.value === 'admin');
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
        <label class="field"><span>권한</span><select name="role">
          <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>실장</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>관리자</option></select></label>
        <label class="field"><span>매장</span><select name="store_id" ${u.role === 'admin' ? 'disabled' : ''}>${storeOpts(u.store_id)}</select></label>
      </div>
      <label class="field"><span>새 비밀번호 (바꿀 때만)</span><input type="text" name="password" placeholder="비워두면 유지"></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> 사용 가능 (해제 시 로그인 정지)</label>
      <div class="err" data-err></div>
      <div class="row"><button class="btn" data-x>닫기</button><button class="btn primary" data-ok>저장</button></div>`,
      (bg, close) => {
        const g = (n) => $(`[name=${n}]`, bg);
        g('role').onchange = () => (g('store_id').disabled = g('role').value === 'admin');
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
        <dt>권한</dt><dd>${me.role === 'admin' ? '관리자' : '실장'}</dd>
        <dt>매장</dt><dd>${me.role === 'admin' ? '전체' : esc(storeName(me.store_id))}</dd></dl>
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

  // ---------------- 라우터 ----------------
  function route() {
    if (!state.me) return renderLogin();
    const h = location.hash.replace(/^#\/?/, '');
    let m;
    state.detailId = null;
    if (h === 'new') return viewForm(null);
    if ((m = /^p\/(\d+)\/edit$/.exec(h))) return viewForm(Number(m[1]));
    if ((m = /^p\/(\d+)$/.exec(h))) return viewDetail(Number(m[1]));
    if (h === 'admin') return viewAdmin();
    if (h === 'account') return viewAccount();
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
