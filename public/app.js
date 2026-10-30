/* Class of ’29 portfolio — front end. All user text is inserted with textContent (never innerHTML). */
'use strict';
const CLASS_LABEL = '’29';
const CLASS_NAME = `Class of ${CLASS_LABEL}`;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const THEMES = [
  { bg: '#FFD60A', fg: '#0b0b0b', name: 'Butter' },
  { bg: '#2D5BFF', fg: '#FFE34D', name: 'Cobalt' },
  { bg: '#FF5A36', fg: '#0b0b0b', name: 'Flame' },
  { bg: '#0b0b0b', fg: '#FFD60A', name: 'Night' },
  { bg: '#C6FF3D', fg: '#0b0b0b', name: 'Acid' },
  { bg: '#FF9BD2', fg: '#0b0b0b', name: 'Bubblegum' },
];

/* ---------- tiny DOM helper ---------- */
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat(9).forEach((x) => { if (x != null && x !== false) e.append(x.nodeType ? x : document.createTextNode(x)); });
  return e;
}
function split(el, text, delay = 0) {
  el.textContent = ''; el.setAttribute('aria-label', text);
  [...text].forEach((c, i) => {
    const s = h('span', { class: 'ch', 'aria-hidden': 'true' }, h('i', { style: `--i:${i};--d:${delay}ms` }, c === ' ' ? ' ' : c));
    el.append(s);
  });
  return el;
}
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');
const pad = (n) => String(n).padStart(2, '0');
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };

/* ---------- api ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Req': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Something went wrong'), { status: r.status });
  return d;
}

/* ---------- state ---------- */
let me = null, MAX = 30, count = 0, total = 0, students = [], googleClientId = null, allowPasswordLogin = true;
async function loadBase() {
  const reqLimit = MAX > 60 ? 30 : Math.max(60, MAX);
  const [m, s] = await Promise.all([api('/me'), api('/students?limit=' + reqLimit + '&offset=0')]);
  me = m.me;
  MAX = s.max || m.max || 30;
  count = typeof s.count === 'number' ? s.count : (s.students ? s.students.length : 0);
  total = typeof s.total === 'number' ? s.total : count;
  students = s.students || [];
  googleClientId = m.googleClientId;
  allowPasswordLogin = m.allowPasswordLogin;
}

/* ---------- theme ---------- */
let inkColor = THEMES[0].fg;
function setTheme(i) {
  const t = THEMES[i] || THEMES[0];
  const r = document.documentElement.style;
  r.setProperty('--bg', t.bg); r.setProperty('--fg', t.fg);
  inkColor = t.fg;
  $('meta[name=theme-color]').content = t.bg;
}

/* ---------- toast ---------- */
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- pixel-dissolve page transition ---------- */
const px = $('#px'); let cells = [];
function buildPx() {
  const cols = innerWidth < 700 ? 8 : 16, size = innerWidth / cols, rows = Math.ceil(innerHeight / size);
  px.style.gridTemplateColumns = `repeat(${cols},1fr)`; px.style.gridTemplateRows = `repeat(${rows},1fr)`;
  px.replaceChildren(); cells = [];
  for (let i = 0; i < cols * rows; i++) { const c = h('i'); px.append(c); cells.push(c); }
}
function pixel(dir) {
  if (reduce) return Promise.resolve();
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
  if (dir === 'in') {
    px.style.setProperty('--c', fg); px.classList.add('on');
    cells.forEach((c) => { c.style.background = Math.random() < .14 ? '#2D5BFF' : ''; });
  }
  const frames = dir === 'in' ? [{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'scale(1.04)' }] : [{ opacity: 1, transform: 'scale(1.04)' }, { opacity: 0, transform: 'scale(.4)' }];
  return Promise.all(cells.map((c) => c.animate(frames, { duration: 170, delay: Math.random() * 480, fill: 'both', easing: 'ease-out' }).finished))
    .then(() => { if (dir === 'out') px.classList.remove('on'); });
}

/* ---------- ink blob that chases the cursor ---------- */
const cv = $('#ink'), cx = cv.getContext('2d');
let W = 0, H = 0, mx = innerWidth / 2, my = innerHeight / 2, lastMove = -1e9, hover = 0;
const N = 26, pts = Array.from({ length: N }, () => ({ x: 0, y: 0 }));
function sizeInk() { W = cv.width = Math.ceil(innerWidth / 2); H = cv.height = Math.ceil(innerHeight / 2); }
sizeInk();
pts.forEach((p) => { p.x = W / 2; p.y = H / 2; });
addEventListener('pointermove', (e) => { mx = e.clientX; my = e.clientY; lastMove = performance.now(); });
document.addEventListener('pointerover', (e) => { hover = e.target.closest?.('a,button,.tile,input,textarea') ? 1 : 0; });
function drawInk(t) {
  if (reduce) return;
  let tx = mx / 2, ty = my / 2;
  if (t - lastMove > 2200) { tx = W / 2 + Math.cos(t / 1300) * W * .3; ty = H / 2 + Math.sin(t / 1000) * H * .24; }
  pts[0].x += (tx - pts[0].x) * .16; pts[0].y += (ty - pts[0].y) * .16;
  for (let i = 1; i < N; i++) { pts[i].x += (pts[i - 1].x - pts[i].x) * .36; pts[i].y += (pts[i - 1].y - pts[i].y) * .36; }
  const speed = Math.hypot(tx - pts[0].x, ty - pts[0].y);
  const head = (16 + Math.min(speed * .12, 7) + Math.sin(t / 240) * 1.5) * (hover ? 1.55 : 1);
  cx.clearRect(0, 0, W, H); cx.fillStyle = inkColor; cx.beginPath();
  for (let i = 0; i < N; i++) {
    const r = Math.max(2.2, head * Math.pow(1 - i / N, 1.25));
    cx.moveTo(pts[i].x + r, pts[i].y); cx.arc(pts[i].x, pts[i].y, r, 0, 6.2832);
  }
  cx.fill();
}

/* ---------- main animation loop: ink, card tilt, parallax, marquee speed ---------- */
let lastY = scrollY, vy = 0, rx = 0, ry = 0, tiltX = 0, tiltY = 0;
function loop(t) {
  drawInk(t);
  vy += ((scrollY - lastY) - vy) * .1; lastY = scrollY;
  const card = $('.idcard');
  if (card && !reduce) {
    const idle = t - lastMove > 2200;
    const nx = idle ? Math.sin(t / 1500) * .35 : mx / innerWidth - .5, ny = idle ? Math.cos(t / 1900) * .3 : my / innerHeight - .5;
    tiltX += (ny * -26 - tiltX) * .08; tiltY += (nx * 34 - tiltY) * .08;
    card.style.setProperty('--rx', (tiltX + Math.sin(t / 1200) * 2).toFixed(2) + 'deg');
    card.style.setProperty('--ry', tiltY.toFixed(2) + 'deg');
    card.style.setProperty('--hx', (50 + nx * 80).toFixed(1)); card.style.setProperty('--hy', (50 + ny * 80).toFixed(1));
    card.parentElement.style.transform = `translate(-50%,calc(-47% + ${Math.min(scrollY * .12, 90)}px))`;
  }
  const mega = $('.mega'); if (mega && !reduce) mega.style.transform = `translateY(${Math.min(scrollY * .18, 140)}px)`;
  const tr = $('.marquee .track');
  if (tr) { const a = tr.getAnimations?.()[0]; if (a) a.playbackRate = 1 + Math.min(Math.abs(vy) * .35, 9); const m = tr.parentElement; m.style.transform = `skewY(${(-1.5 + Math.max(-4, Math.min(4, vy * .08))).toFixed(2)}deg)`; }
  requestAnimationFrame(loop);
}

/* magnetic buttons (event-delegated) */
document.addEventListener('pointermove', (e) => {
  if (reduce) return;
  $$('.mag').forEach((el) => {
    const r = el.getBoundingClientRect(), cxm = r.left + r.width / 2, cym = r.top + r.height / 2;
    const dx = e.clientX - cxm, dy = e.clientY - cym, d = Math.hypot(dx, dy), reach = Math.max(r.width, r.height) * .9;
    el.style.transform = d < reach ? `translate(${dx * .28}px,${dy * .4}px)` : '';
  });
});

/* scroll reveal */
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12 });
const observe = (root) => $$('.rv', root).forEach((el) => io.observe(el));

/* ---------- views ---------- */
const avatarUrl = (s) => `/api/avatar/${s.username}?v=${s.v}`;

function homeView() {
  const joined = count, open = Math.max(0, MAX - joined);
  const el = h('div', { class: 'home' });

  // hero
  const l1 = split(h('span', { class: 'l1' }), 'Class', 150);
  const l2t = split(h('span'), CLASS_LABEL, 450);
  const screenB = h('b', {}, joined && students.length ? students[0].name : 'You?');
  const num = h('b', { class: 'num' }, String(joined));
  const card = h('div', { class: 'card-wrap' },
    h('div', { class: 'idcard' },
      h('div', { class: 'holo' }),
      h('div', { class: 'screen' }, screenB),
      h('div', { class: 'row' }, h('span', { class: 'num' }, pad(joined)), h('small', {}, `of ${MAX}`, h('br'), 'joined')),
      h('div', { class: 'tag' }, CLASS_NAME, h('br'), 'Access pass'),
      h('div', { class: 'bars' })));
  let k = 0;
  if (students.length > 1) {
    const iv = setInterval(() => {
      if (!screenB.isConnected) return clearInterval(iv);
      k = (k + 1) % students.length; screenB.textContent = students[k].name;
      screenB.classList.remove('glitch'); void screenB.offsetWidth; screenB.classList.add('glitch');
    }, 1800);
  }
  const hero = h('header', { class: 'hero' },
    h('h1', { class: 'mega', 'aria-label': CLASS_NAME }, l1, h('span', { class: 'l2' }, h('span', { class: 'script' }, 'of'), l2t)),
    card,
    h('p', { class: 'hero-sub' }, `${MAX} students · ${MAX} portfolios · one page`),
    h('a', { class: 'btn mag hero-cta', href: me ? '#/me' : '#/signup' }, h('span', {}, me ? 'My page' : 'Claim your spot'), h('span', {}, '→')),
    h('div', { class: 'cue', 'aria-hidden': 'true' }, '↓'));

  // marquee
  // If MAX <= 60: marquee uses everyone
  // If MAX > 60: marquee uses a sample of up to 30 names
  const marqueeList = MAX <= 60 ? students : students.slice(0, 30);
  const names = marqueeList.length ? marqueeList.map((s) => s.name) : ['Be the first'];
  const unit = names.flatMap((n) => [h('span', {}, n), h('span', {}, h('em', {}, '✦'))]);
  const track = h('div', { class: 'track' }, ...unit, ...unit.map((n) => n.cloneNode(true)), ...unit.map((n) => n.cloneNode(true)), ...unit.map((n) => n.cloneNode(true)));
  const marquee = h('div', { class: 'marquee', 'aria-hidden': 'true' }, track);

  const grid = h('div', { class: 'grid' });
  let crew;

  if (MAX <= 60) {
    // Mode 1: Small class (<= 60 students) - ORIGINAL GRID LOOK
    // Every joined student first, then one separate numbered "open spot" tile for each remaining spot (joined+1 to MAX)
    const tiles = students.map((s, i) => {
      const tile = h('a', { class: 'tile rv in', href: `#/u/${s.username}`, style: `--d:${(i % 6) * 70}ms`, 'aria-label': s.name },
        h('div', { class: 'top' }, h('span', {}, pad(s.n || (i + 1))), h('span', {}, s.role || 'Student')),
        h('div', { class: 'face' }, s.hasAvatar ? h('img', { class: 'blobimg', src: avatarUrl(s), alt: '', loading: 'lazy' }) : h('div', { class: 'initial' }, (s.name || '?')[0].toUpperCase())),
        h('div', {}, h('h3', {}, s.name), h('p', {}, s.tagline || ' ')),
        h('span', { class: 'peek' }, 'VIEW ↗'));
      tile.addEventListener('pointermove', (e) => {
        const r = tile.getBoundingClientRect();
        tile.style.setProperty('--px', (e.clientX - r.left + 14) + 'px');
        tile.style.setProperty('--py', (e.clientY - r.top + 14) + 'px');
      });
      return tile;
    });

    for (let i = joined; i < MAX; i++) {
      tiles.push(h('a', { class: 'tile open rv in', href: me ? '#/me' : '#/signup', style: `--d:${(i % 6) * 70}ms`, 'aria-label': 'Open spot' },
        h('div', { class: 'top' }, h('span', {}, pad(i + 1)), h('span', {}, 'Open')),
        h('div', { class: 'face' }, '+'),
        h('div', {}, h('h3', {}, me ? 'Spot waiting' : 'Claim this spot'))));
    }

    grid.replaceChildren(...tiles);

    crew = h('section', { class: 'sec', id: 'crew' },
      h('div', { class: 'sec-head rv' }, h('h2', {}, 'The crew'), h('p', {}, h('b', {}, `${pad(joined)}/${MAX}`), open ? `${open} spots left` : 'Full house')),
      grid);
  } else {
    // Mode 2: Large class (> 60 students) - SCALABLE BEHAVIOR
    // Search box, infinite scroll, single "N spots left" tile, sample marquee
    let crewList = [...students];
    let offset = crewList.length;
    const limit = 30;
    let hasMore = total > crewList.length;
    let loadingMore = false;
    let currentQ = '';

    const renderTiles = (list, isFiltered = false) => {
      const tiles = list.map((s, i) => {
        const tile = h('a', { class: 'tile rv in', href: `#/u/${s.username}`, style: `--d:${(i % 6) * 70}ms`, 'aria-label': s.name },
          h('div', { class: 'top' }, h('span', {}, pad(s.n || (i + 1))), h('span', {}, s.role || 'Student')),
          h('div', { class: 'face' }, s.hasAvatar ? h('img', { class: 'blobimg', src: avatarUrl(s), alt: '', loading: 'lazy' }) : h('div', { class: 'initial' }, (s.name || '?')[0].toUpperCase())),
          h('div', {}, h('h3', {}, s.name), h('p', {}, s.tagline || ' ')),
          h('span', { class: 'peek' }, 'VIEW ↗'));
        tile.addEventListener('pointermove', (e) => {
          const r = tile.getBoundingClientRect();
          tile.style.setProperty('--px', (e.clientX - r.left + 14) + 'px');
          tile.style.setProperty('--py', (e.clientY - r.top + 14) + 'px');
        });
        return tile;
      });

      if (!isFiltered && open > 0) {
        tiles.push(h('a', { class: 'tile open rv in', href: me ? '#/me' : '#/signup', 'aria-label': `${open} spots left` },
          h('div', { class: 'top' }, h('span', {}, pad(open)), h('span', {}, 'Open')),
          h('div', { class: 'face' }, '+'),
          h('div', {}, h('h3', {}, `${open} spots left`), h('p', {}, me ? 'Spot waiting' : 'Claim your spot'))));
      }
      return tiles;
    };

    const sentinel = h('div', { class: 'grid-sentinel' }, 'Loading more…');

    const updateGridDisplay = (isFiltered = false) => {
      const tiles = renderTiles(crewList, isFiltered);
      if (hasMore) {
        grid.replaceChildren(...tiles, sentinel);
      } else {
        grid.replaceChildren(...tiles);
      }
    };

    updateGridDisplay(false);

    // IntersectionObserver for infinite scrolling
    const scrollIo = new IntersectionObserver(async (entries) => {
      if (!entries[0].isIntersecting || loadingMore || !hasMore) return;
      loadingMore = true;
      try {
        const qParam = currentQ ? `&q=${encodeURIComponent(currentQ)}` : '';
        const data = await api(`/students?limit=${limit}&offset=${offset}${qParam}`);
        if (data.students && data.students.length > 0) {
          crewList.push(...data.students);
          offset += data.students.length;
          hasMore = offset < (currentQ ? data.total : data.count);
          updateGridDisplay(Boolean(currentQ));
        } else {
          hasMore = false;
          sentinel.remove();
        }
      } catch (err) {
        console.warn('Could not load more students:', err);
      } finally {
        loadingMore = false;
      }
    }, { rootMargin: '250px' });

    scrollIo.observe(sentinel);

    const searchInput = h('input', {
      class: 'crew-search-input',
      type: 'search',
      placeholder: 'Search crew by name, role, or skill…',
      'aria-label': 'Filter students by name, role or skill'
    });
    const searchCount = h('span', { class: 'crew-search-count' });
    const clearBtn = h('button', { class: 'crew-search-clear', type: 'button', 'aria-label': 'Clear search', style: 'display:none' }, '✕');

    let searchTimeout;
    const doSearch = () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(async () => {
        const q = searchInput.value.trim();
        clearBtn.style.display = q ? 'inline-block' : 'none';
        currentQ = q;
        offset = 0;
        loadingMore = true;

        try {
          const qParam = q ? `&q=${encodeURIComponent(q)}` : '';
          const data = await api(`/students?limit=${limit}&offset=0${qParam}`);
          crewList = data.students || [];
          offset = crewList.length;
          hasMore = offset < (q ? data.total : data.count);
          searchCount.textContent = q ? `${data.total} found` : '';

          if (crewList.length === 0) {
            grid.classList.add('empty');
            const emptyMsg = h('div', { class: 'grid-empty-state' },
              h('p', {}, `No students found matching “${q}”`),
              h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { searchInput.value = ''; doSearch(); searchInput.focus(); } }, h('span', {}, 'Show all crew'))
            );
            grid.replaceChildren(emptyMsg);
          } else {
            grid.classList.remove('empty');
            updateGridDisplay(Boolean(q));
          }
        } catch (err) {
          console.warn('Search error:', err);
        } finally {
          loadingMore = false;
        }
      }, 200);
    };

    searchInput.addEventListener('input', doSearch);
    clearBtn.addEventListener('click', () => { searchInput.value = ''; doSearch(); searchInput.focus(); });

    const searchBar = h('div', { class: 'crew-search-bar rv' },
      h('div', { class: 'crew-search-box' },
        h('span', { class: 'crew-search-icon', 'aria-hidden': 'true' }, '⌕'),
        searchInput,
        clearBtn
      ),
      searchCount
    );

    crew = h('section', { class: 'sec', id: 'crew' },
      h('div', { class: 'sec-head rv' }, h('h2', {}, 'The crew'), h('p', {}, h('b', {}, `${pad(joined)}/${MAX}`), open ? `${open} spots left` : 'Full house')),
      searchBar,
      grid);
  }

  const foot = h('footer', { class: 'foot' },
    h('h2', { class: 'rv' }, me ? 'You’re in.' : 'Your turn.'),
    h('a', { class: 'btn mag rv', href: me ? '#/edit' : '#/signup' }, h('span', {}, me ? 'Edit my page' : 'Make my page'), h('span', {}, '→')),
    h('small', {}, 'Anyone can look. Only you can edit your own page.'));

  el.append(hero, marquee, crew, foot);
  return { el, theme: 0 };
}

async function profileView(username) {
  let data;
  try { data = await api('/students/' + encodeURIComponent(username)); }
  catch { return notFound(); }
  const s = data.student, own = me && me.username === s.username;
  const name = split(h('h1', { class: 'p-name' }), s.name, 100);
  const avatar = s.hasAvatar ? h('img', { class: 'p-avatar', src: avatarUrl(s), alt: s.name }) : h('div', { class: 'p-avatar ph', 'aria-hidden': 'true' }, s.name[0].toUpperCase());
  const L = s.links, linkDefs = [['GitHub', L.github], ['LinkedIn', L.linkedin], ['Instagram', L.instagram], ['Website', L.website]].filter((x) => x[1]);
  const links = linkDefs.map(([t, u]) => h('a', { class: 'btn ghost mag', href: safeUrl(u), target: '_blank', rel: 'noopener noreferrer' }, h('span', {}, t), h('span', {}, '↗')));
  if (L.email) links.push(h('a', { class: 'btn mag', href: 'mailto:' + L.email }, h('span', {}, 'Say hi'), h('span', {}, '✉')));
  if (s.hasResume && (own || (s.resumePublic && me))) {
    links.push(h('a', { class: 'btn ghost mag', href: `/api/resume/${encodeURIComponent(s.username)}`, target: '_blank', rel: 'noopener noreferrer' }, h('span', {}, 'Uploaded PDF'), h('span', {}, '📄 ↗')));
  }

  // Auto-generated resume controls
  let autoResumeBox = null;
  const canDownloadResume = own || (s.resumePublic && me);
  if (canDownloadResume) {
    const tplSelect = h('select', { class: 'tpl-select', 'aria-label': 'Resume Template' },
      h('option', { value: 'classic' }, 'Classic'),
      h('option', { value: 'modern' }, 'Modern'),
      h('option', { value: 'minimal' }, 'Minimal')
    );
    const getDownloadUrl = (isInline = false) => {
      const ep = own ? '/api/resume/auto' : `/api/resume/auto/${encodeURIComponent(s.username)}`;
      return `${ep}?template=${encodeURIComponent(tplSelect.value)}${isInline ? '&preview=1' : ''}`;
    };
    const dlBtn = h('a', {
      class: 'btn pill',
      href: getDownloadUrl(false),
      download: '',
    }, h('span', {}, 'Download resume'), h('span', {}, '↓'));
    
    const prevBtn = h('a', {
      class: 'btn ghost pill',
      href: getDownloadUrl(true),
      target: '_blank',
      rel: 'noopener noreferrer',
    }, h('span', {}, 'Preview'), h('span', {}, '↗'));

    tplSelect.addEventListener('change', () => {
      dlBtn.setAttribute('href', getDownloadUrl(false));
      prevBtn.setAttribute('href', getDownloadUrl(true));
    });

    autoResumeBox = h('div', { class: 'resume-ctrl-wrap rv' },
      tplSelect,
      dlBtn,
      prevBtn
    );
  }

  const projects = (s.projects || []).map((p, i) => {
    const inner = [
      h('span', { class: 'i' }, pad(i + 1)),
      p.image && h('div', { class: 'proj-preview' },
        h('img', { class: 'proj-img', src: p.image, alt: p.title ? p.title + ' preview' : '', loading: 'lazy' })
      ),
      h('div', { class: 'proj-main' },
        h('h3', {}, p.title),
        p.desc && h('p', {}, p.desc)
      ),
      h('span', { class: 'arr' }, p.url ? '↗' : '')
    ];
    return p.url
      ? h('a', { class: 'proj rv' + (p.image ? ' has-shot' : ''), href: safeUrl(p.url), target: '_blank', rel: 'noopener noreferrer', title: host(p.url) }, inner)
      : h('div', { class: 'proj rv' + (p.image ? ' has-shot' : '') }, inner);
  });

  const experienceItems = (s.experience || []).map((exp) => {
    const dateText = [exp.start, exp.end].filter(Boolean).join(' – ');
    return h('div', { class: 'p-item rv' },
      h('div', {},
        h('h3', {}, exp.title || 'Role'),
        exp.organisation && h('div', { class: 'p-item-sub' }, exp.organisation),
        exp.description && h('p', { class: 'p-item-desc' }, exp.description)
      ),
      dateText && h('div', { class: 'p-item-date' }, dateText)
    );
  });

  const educationItems = (s.education || []).map((edu) => {
    const degreeLine = [edu.degree, edu.field].filter(Boolean).join(' in ');
    const dateText = [edu.start_year, edu.end_year].filter(Boolean).join(' – ');
    return h('div', { class: 'p-item rv' },
      h('div', {},
        h('h3', {}, degreeLine || edu.school || 'Education'),
        edu.school && degreeLine && h('div', { class: 'p-item-sub' }, edu.school)
      ),
      dateText && h('div', { class: 'p-item-date' }, dateText)
    );
  });

  const certItems = (s.certifications || []).map((c) => {
    const meta = [c.issuer, c.year].filter(Boolean).join(' • ');
    return h('div', { class: 'p-item rv' },
      h('div', {},
        h('h3', {}, c.name),
        meta && h('div', { class: 'p-item-sub' }, meta)
      )
    );
  });

  const achItems = (s.achievements || []).map((ach) => h('span', { class: 'chip' }, ach));

  const el = h('section', { class: 'profile' },
    h('div', { class: 'p-top' }, h('span', {}, `Student ${pad(s.n)} / ${MAX}`), h('span', {}, '@' + s.username)),
    name,
    h('div', { class: 'p-body' },
      h('div', { class: 'rv' }, avatar),
      h('div', { class: 'rv', style: '--d:150ms' },
        h('span', { class: 'p-role' }, s.role || 'Student'),
        s.tagline && h('div', { class: 'p-tag' }, s.tagline),
        s.location && h('div', { style: 'font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.75;margin-bottom:12px;' }, '📍 ' + s.location),
        s.bio ? h('p', { class: 'p-bio' }, s.bio) : h('p', { class: 'p-bio' }, own ? 'Add a bio so people know who you are →' : 'Still writing the story…'),
        s.skills.length > 0 && h('div', { class: 'chips' }, s.skills.map((k) => h('span', { class: 'chip' }, k))),
        links.length > 0 && h('div', { class: 'links' }, links),
        autoResumeBox)),
    projects.length > 0 && h('div', { class: 'p-sec' }, h('h2', { class: 'rv' }, 'Selected work'), h('div', {}, projects)),
    experienceItems.length > 0 && h('div', { class: 'p-sec' }, h('h2', { class: 'rv' }, 'Experience'), h('div', {}, experienceItems)),
    educationItems.length > 0 && h('div', { class: 'p-sec' }, h('h2', { class: 'rv' }, 'Education'), h('div', {}, educationItems)),
    certItems.length > 0 && h('div', { class: 'p-sec' }, h('h2', { class: 'rv' }, 'Certifications'), h('div', {}, certItems)),
    achItems.length > 0 && h('div', { class: 'p-sec' }, h('h2', { class: 'rv' }, 'Achievements & Honors'), h('div', { class: 'chips' }, achItems)),
    data.next && data.next !== s.username && h('a', { class: 'p-next rv', href: '#/u/' + data.next }, h('small', {}, 'Next student →'), h('b', {}, data.nextName)),
    own && h('a', { class: 'btn fab', href: '#/edit' }, h('span', {}, 'Edit my page'), h('span', {}, '✎')));
  return { el, theme: s.theme, title: s.name };
}

function notFound() {
  return { el: h('section', { class: 'center' }, h('h1', {}, 'Nobody', h('br'), 'here yet'), h('div', {}, h('a', { class: 'btn', href: '#/crew' }, h('span', {}, 'See the crew'), h('span', {}, '→')))), theme: 0 };
}

function decodeJwt(token) {
  try {
    const base64Url = (token || '').split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch {
    return {};
  }
}

function makeGoogleIcon() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '20');
  s.setAttribute('height', '20');
  s.setAttribute('aria-hidden', 'true');
  const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p1.setAttribute('fill', '#4285F4');
  p1.setAttribute('d', 'M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z');
  const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p2.setAttribute('fill', '#34A853');
  p2.setAttribute('d', 'M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z');
  const p3 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p3.setAttribute('fill', '#FBBC05');
  p3.setAttribute('d', 'M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z');
  const p4 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p4.setAttribute('fill', '#EA4335');
  p4.setAttribute('d', 'M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z');
  s.append(p1, p2, p3, p4);
  return s;
}

function googleAuthView() {
  const err = h('div', { class: 'err', role: 'alert' });
  const gBox = h('div', { id: 'gBtn', style: 'margin: 20px 0; max-width: 280px; min-height: 44px;' });
  const devBox = h('div', { class: 'dev-auth-form', style: 'display:none;' });

  const emailInput = h('input', {
    type: 'email',
    placeholder: 'your.name.s.129@kalvium.community',
    style: 'margin-bottom: 12px;',
  });
  const devSubmitBtn = h('button', { class: 'btn', type: 'submit' }, h('span', {}, 'Continue with Email'), h('span', {}, '→'));

  const submitEmail = async (rawEmail) => {
    err.textContent = '';
    const email = (window.EmailRule?.normalize || ((s) => (typeof s === 'string' ? s.trim() : '')))(rawEmail || '');
    if (window.EmailRule && !window.EmailRule.isAuthorizedEmail(email)) {
      err.textContent = window.EmailRule.ACCESS_DENIED_MESSAGE;
      el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
      return;
    }
    try {
      devSubmitBtn.disabled = true;
      const r = await api('/google', { method: 'POST', body: { credential: 'dev:' + email } });
      me = r.me;
      await loadBase();
      updateNav();
      toast(`Welcome, ${me.name.split(' ')[0]} ✦`);
      location.hash = '#/u/' + me.username;
    } catch (ex) {
      err.textContent = ex.message;
      el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
      devSubmitBtn.disabled = false;
    }
  };

  const devForm = h('form', { novalidate: true },
    h('div', { class: 'field' },
      h('span', {}, 'Enter your student Google email'),
      emailInput,
      h('small', {}, 'Only @kalvium.community student addresses are permitted.')
    ),
    h('div', { style: 'margin-top: 14px;' }, devSubmitBtn)
  );
  devForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitEmail(emailInput.value);
  });

  const quickChips = [
    { name: 'Thrishank Kumar', email: 'thrishank.kumar.s.129@kalvium.community' },
    { name: 'Lohith M', email: 'lohith.m.s.129@kalvium.community' },
    { name: 'Pravin Kumar', email: 'pravin.kumar.s.129@kalvium.community' },
  ].map((c) => h('button', {
    type: 'button',
    class: 'quick-chip',
    onclick: () => {
      emailInput.value = c.email;
      submitEmail(c.email);
    }
  }, c.name));

  devBox.append(
    devForm,
    h('div', { style: 'margin-top: 18px;' },
      h('span', { style: 'font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.7;' }, 'Or quick-sign as pre-made student:'),
      h('div', { class: 'quick-chips' }, quickChips)
    )
  );

  const fallbackBtn = h('button', {
    class: 'btn google-sign-btn',
    type: 'button',
    onclick: () => {
      if (googleClientId && window.google?.accounts?.id) {
        window.google.accounts.id.prompt();
      } else {
        devBox.style.display = devBox.style.display === 'none' ? 'block' : 'none';
        emailInput.focus();
      }
    }
  }, makeGoogleIcon(), h('span', {}, 'Sign in with Google'));

  const el = h('section', { class: 'formpage' },
    split(h('h1'), 'Sign in', 60),
    h('div', { class: 'rv in' },
      h('p', { class: 'alt', style: 'margin-bottom: 24px;' }, 'Sign in with your student Google account to join the crew or edit your page.'),
      h('div', { style: 'margin: 20px 0;' }, fallbackBtn),
      gBox,
      devBox,
      err,
      allowPasswordLogin && h('p', { class: 'alt', style: 'margin-top: 36px;' }, 'Local testing? ', h('a', { href: '#/password-login' }, 'Sign in with User ID + password'))
    )
  );

  function setupGoogle() {
    if (window.google?.accounts?.id && googleClientId) {
      fallbackBtn.style.display = 'none';
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (resp) => {
          err.textContent = '';
          const credential = resp.credential;
          try {
            const payload = decodeJwt(credential);
            const rule = window.EmailRule;
            const email = (rule?.normalize || ((s) => (typeof s === 'string' ? s.trim() : '')))(payload.email || '');
            if (rule && !rule.isAuthorizedEmail(email)) {
              err.textContent = rule.ACCESS_DENIED_MESSAGE;
              el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
              return;
            }
            const r = await api('/google', { method: 'POST', body: { credential } });
            me = r.me;
            await loadBase();
            updateNav();
            toast(`Welcome, ${me.name.split(' ')[0]} ✦`);
            location.hash = '#/u/' + me.username;
          } catch (ex) {
            err.textContent = ex.message;
            el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
          }
        },
      });
      gBox.replaceChildren();
      window.google.accounts.id.renderButton(gBox, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        text: 'signin_with',
        width: 280,
      });
    } else {
      setTimeout(setupGoogle, 150);
    }
  }

  requestAnimationFrame(setupGoogle);
  return { el, theme: 1 };
}

function authView(mode) {
  const signup = mode === 'signup';
  const err = h('div', { class: 'err', role: 'alert' });
  const f = (label, name, type, extra = {}) => h('label', { class: 'field' }, h('span', {}, label), h('input', { name, type, required: true, autocomplete: extra.ac, placeholder: extra.ph, maxlength: extra.max, spellcheck: false, autocapitalize: 'off' }));
  const btn = h('button', { class: 'btn', type: 'submit' }, h('span', {}, signup ? 'Create my page' : 'Log in'), h('span', {}, '→'));
  const form = h('form', { novalidate: true },
    signup && f('Your name', 'name', 'text', { ac: 'name', ph: 'Thrishank', max: 40 }),
    f('User ID', 'username', 'text', { ac: 'username', ph: 'letters, numbers, _', max: 20 }),
    f('Password', 'password', 'password', { ac: signup ? 'new-password' : 'current-password', ph: signup ? 'at least 6 characters' : '••••••' }),
    err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true;
    const d = Object.fromEntries(new FormData(form));
    try {
      const r = await api(signup ? '/signup' : '/login', { method: 'POST', body: d });
      me = r.me; await loadBase(); updateNav();
      toast(signup ? 'You’re in! Make it yours ✦' : `Welcome back, ${me.name.split(' ')[0]}`);
      location.hash = signup ? '#/edit' : '#/u/' + me.username;
    } catch (ex) {
      err.textContent = ex.message; form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); btn.disabled = false;
    }
  });
  const el = h('section', { class: 'formpage' },
    split(h('h1'), signup ? 'Join up' : 'Log in', 60),
    h('div', { class: 'rv in' }, form,
      h('p', { class: 'alt' }, signup ? 'Already have a page? ' : 'No account yet? ', h('a', { href: signup ? '#/login' : '#/signup' }, signup ? 'Log in' : 'Make one'),
        MAX - students.length <= 0 && signup ? ' — heads up, the class is full.' : '')));
  return { el, theme: 1 };
}

async function uploadToStorage(blobOrFile, kind, contentType) {
  const { uploadUrl, storageKey } = await api('/files/upload-url', {
    method: 'POST',
    body: { kind, contentType },
  });
  const upRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blobOrFile,
  });
  if (!upRes.ok) throw new Error('Failed to upload file to storage');
  const comp = await api('/files/complete', {
    method: 'POST',
    body: { storageKey, kind, mime: contentType },
  });
  return comp.file;
}

async function editView() {
  const { profile: p } = await api('/profile');
  const st = {
    ...p,
    phone: p.phone || '',
    location: p.location || '',
    links: { ...p.links },
    projects: (p.projects || []).map((x) => ({ ...x })),
    education: (p.education || []).map((x) => ({ ...x })),
    experience: (p.experience || []).map((x) => ({ ...x })),
    certifications: (p.certifications || []).map((x) => ({ ...x })),
    achievements: [...(p.achievements || [])],
    skills: [...p.skills],
    avatar: undefined,
    resume_public: p.resumePublic,
    hasResume: p.hasResume,
  };

  const inp = (label, get, set, o = {}) => {
    const i = h(o.area ? 'textarea' : 'input', { placeholder: o.ph, maxlength: o.max, type: o.area ? null : 'text', rows: o.area ? 4 : null });
    i.value = get() || '';
    i.addEventListener('input', () => {
      set(i.value);
      updateCompleteness();
    });
    return h('label', { class: 'field' }, h('span', {}, label), i, o.hint && h('small', {}, o.hint));
  };

  // Completeness Card Live Helper
  const compVal = h('span', { class: 'completeness-val' }, '0/10');
  const compFill = h('div', { class: 'completeness-fill', style: 'width: 0%' });
  const compMissing = h('div', { class: 'completeness-missing' });
  const compCard = h('div', { class: 'completeness-card rv' },
    h('div', { class: 'completeness-head' },
      h('span', { class: 'completeness-title' }, '✦ Resume Completeness'),
      compVal
    ),
    h('div', { class: 'completeness-track' }, compFill),
    compMissing
  );

  function updateCompleteness() {
    const checks = [
      { id: 'photo', label: 'Photo', ok: Boolean(st.avatar || p.hasAvatar) },
      { id: 'tagline', label: 'Tagline', ok: Boolean(st.tagline && st.tagline.trim()) },
      { id: 'bio', label: 'Bio', ok: Boolean(st.bio && st.bio.trim()) },
      { id: 'skills', label: '3+ Skills', ok: (skills.value ? skills.value.split(',').map((x) => x.trim()).filter(Boolean).length : st.skills.length) >= 3 },
      { id: 'project', label: 'A Project', ok: st.projects.some((pr) => pr.title && pr.title.trim()) },
      { id: 'education', label: 'Education', ok: st.education.some((ed) => (ed.school && ed.school.trim()) || (ed.degree && ed.degree.trim())) },
      { id: 'experience', label: 'Experience', ok: st.experience.some((ex) => (ex.title && ex.title.trim()) || (ex.organisation && ex.organisation.trim())) },
      { id: 'links', label: 'Links', ok: Boolean(st.links.github || st.links.linkedin || st.links.website || st.links.email) },
      { id: 'location', label: 'Location', ok: Boolean(st.location && st.location.trim()) },
      { id: 'cert_or_ach', label: 'Certifications or Honors', ok: st.certifications.length > 0 || st.achievements.length > 0 },
    ];

    const doneCount = checks.filter((c) => c.ok).length;
    const totalCount = checks.length;
    const pct = Math.round((doneCount / totalCount) * 100);

    compVal.textContent = `${doneCount} of ${totalCount} sections filled (${pct}%)`;
    compFill.style.width = `${pct}%`;

    const missing = checks.filter((c) => !c.ok).map((c) => c.label);
    if (missing.length === 0) {
      compMissing.textContent = 'Awesome! Your profile and resume are 100% complete.';
    } else {
      compMissing.replaceChildren(
        h('b', {}, 'Missing: '),
        document.createTextNode(missing.join(', '))
      );
    }
  }

  // avatar
  const prev = h('div', { class: 'up' });
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const renderAvatar = () => {
    prev.replaceChildren(
      (st.avatar || p.hasAvatar) ? h('img', { class: 'p-avatar', src: st.avatar || avatarUrl(p), alt: '' }) : h('div', { class: 'p-avatar ph' }, (st.name || '?')[0].toUpperCase()),
      h('div', { class: 'links', style: 'margin:0' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => file.click() }, h('span', {}, 'Upload photo')),
        (st.avatar || p.hasAvatar) && h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
          try {
            await api('/files', { method: 'DELETE', body: { storageKey: `users/${me.username}/avatar/` } }).catch(() => {});
            p.hasAvatar = false;
            st.avatar = '';
            renderAvatar();
            updateCompleteness();
            toast('Photo removed');
          } catch (e) { toast(e.message); }
        } }, h('span', {}, 'Remove'))));
  };
  file.addEventListener('change', async () => {
    const f = file.files[0]; if (!f) return;
    try {
      toast('Uploading photo…');
      const blob = await shrinkToBlob(f, 360);
      await uploadToStorage(blob, 'avatar', 'image/jpeg');
      p.hasAvatar = true;
      p.v = Date.now();
      st.avatar = avatarUrl(p);
      renderAvatar();
      updateCompleteness();
      toast('Photo updated ✓');
    } catch (err) {
      toast(err.message || 'Couldn’t upload that image');
    }
  });
  renderAvatar();

  // resume section
  const resumeFile = h('input', { type: 'file', accept: '.pdf,application/pdf', hidden: true });
  const resumeBox = h('div', { class: 'resume-ed-box' });
  const renderResume = () => {
    const hasRes = Boolean(st.hasResume ?? p.hasResume);

    // Auto-generated resume toolbar
    const tplSelect = h('select', { class: 'tpl-select', 'aria-label': 'Resume Template' },
      h('option', { value: 'classic' }, 'Classic'),
      h('option', { value: 'modern' }, 'Modern (Theme Accent)'),
      h('option', { value: 'minimal' }, 'Minimal')
    );
    const getDownloadUrl = (isInline = false) => `/api/resume/auto?template=${encodeURIComponent(tplSelect.value)}${isInline ? '&preview=1' : ''}`;
    const autoDlBtn = h('a', { class: 'btn ghost sm pill', href: getDownloadUrl(false), download: '' }, h('span', {}, 'Download resume'), h('span', {}, '↓'));
    const autoPrevBtn = h('a', { class: 'btn ghost sm pill', href: getDownloadUrl(true), target: '_blank', rel: 'noopener noreferrer' }, h('span', {}, 'Preview'), h('span', {}, '↗'));

    tplSelect.addEventListener('change', () => {
      autoDlBtn.setAttribute('href', getDownloadUrl(false));
      autoPrevBtn.setAttribute('href', getDownloadUrl(true));
    });

    resumeBox.replaceChildren(
      h('div', { style: 'margin-bottom:14px;' },
        h('div', { style: 'font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;' }, 'Auto-Generated Live Resume (always up to date)'),
        h('div', { class: 'resume-ctrl-wrap', style: 'margin:0;' }, tplSelect, autoDlBtn, autoPrevBtn)
      ),
      h('hr', { style: 'border:0;border-top:1px solid var(--fg);opacity:0.25;margin:14px 0;' }),
      h('div', { class: 'resume-status' },
        hasRes
          ? h('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;' },
              h('span', { class: 'chip' }, 'Custom PDF attached 📄'),
              h('a', { class: 'btn ghost sm', href: `/api/resume/${encodeURIComponent(me.username)}`, target: '_blank', rel: 'noopener noreferrer' }, h('span', {}, 'View PDF')),
              h('button', { class: 'btn ghost sm', type: 'button', onclick: () => resumeFile.click() }, h('span', {}, 'Replace PDF')),
              h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => {
                if (!confirm('Remove your attached resume PDF?')) return;
                try {
                  await api('/files', { method: 'DELETE', body: { storageKey: `users/${me.username}/resume/` } }).catch(() => {});
                  st.hasResume = false;
                  p.hasResume = false;
                  renderResume();
                  toast('Attached resume removed');
                } catch (e) { toast(e.message); }
              } }, h('span', {}, 'Remove'))
            )
          : h('div', {},
              h('button', { class: 'btn ghost sm', type: 'button', onclick: () => resumeFile.click() }, h('span', {}, '+ Attach custom PDF resume')),
              h('small', { style: 'display:block;margin-top:6px;opacity:0.75;' }, 'Optional manual PDF · up to 3 MB')
            )
      ),
      h('label', { style: 'display:flex;align-items:center;gap:10px;cursor:pointer;margin-top:14px;font-size:13px;' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(st.resume_public ?? p.resumePublic),
          onchange: (e) => { st.resume_public = e.target.checked; }
        }),
        h('span', {}, 'Show my resume publicly to other students (defaults to OFF)')
      ),
      resumeFile
    );
  };
  resumeFile.addEventListener('change', async () => {
    const f = resumeFile.files[0]; if (!f) return;
    if (f.size > 3 * 1024 * 1024) { toast('Resume must be 3 MB or smaller'); return; }
    try {
      toast('Uploading resume…');
      await uploadToStorage(f, 'resume', 'application/pdf');
      st.hasResume = true;
      p.hasResume = true;
      renderResume();
      toast('Resume uploaded ✓');
    } catch (e) {
      toast(e.message || 'Couldn’t upload resume');
    }
  });
  renderResume();

  // theme
  const sw = h('div', { class: 'swatches' });
  const renderSw = () => sw.replaceChildren(...THEMES.map((t, i) => h('button', { type: 'button', class: 'sw' + (st.theme === i ? ' on' : ''), title: t.name, 'aria-label': t.name, style: `background:${t.bg};color:${t.fg};border-color:${t.fg === '#0b0b0b' ? '#0b0b0b' : t.fg}`, onclick: () => { st.theme = i; setTheme(i); renderSw(); } })));
  renderSw();

  // projects
  const projBox = h('div');
  const renderProj = () => {
    projBox.replaceChildren(...st.projects.map((pr, i) => {
      const shotFile = h('input', { type: 'file', accept: 'image/*', hidden: true });
      shotFile.addEventListener('change', async () => {
        const f = shotFile.files[0]; if (!f) return;
        try {
          toast('Uploading screenshot…');
          const blob = await shrinkShotToBlob(f, 1200, 750);
          const fileInfo = await uploadToStorage(blob, 'project_image', 'image/jpeg');
          pr.image = fileInfo.url || '';
          renderProj();
          toast('Screenshot uploaded ✓');
        } catch (e) {
          toast(e.message || 'Couldn’t upload screenshot');
        }
      });

      const shotPreview = h('div', { class: 'proj-shot-field' },
        pr.image ? h('div', { class: 'proj-shot-wrap' },
          h('img', { class: 'proj-shot-thumb', src: pr.image, alt: 'Project preview' }),
          h('div', { class: 'proj-shot-btns' },
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => shotFile.click() }, h('span', {}, 'Change image')),
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { pr.image = ''; renderProj(); } }, h('span', {}, 'Remove image'))
          )
        ) : h('div', { class: 'proj-shot-empty' },
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => shotFile.click() }, h('span', {}, '+ Add screenshot')),
          h('small', {}, 'Optional · resized in browser to keep fast')
        ),
        shotFile
      );

      return h('div', { class: 'proj-ed' },
        h('button', { class: 'rm', type: 'button', onclick: () => { st.projects.splice(i, 1); renderProj(); updateCompleteness(); } }, 'Remove'),
        inp('Project title', () => pr.title, (v) => (pr.title = v), { max: 60, ph: 'Weather app' }),
        inp('What is it?', () => pr.desc, (v) => (pr.desc = v), { max: 240, area: true, ph: 'One or two lines' }),
        inp('Link', () => pr.url, (v) => (pr.url = v), { max: 300, ph: 'github.com/you/project' }),
        h('label', { class: 'field' }, h('span', {}, 'Project screenshot'), shotPreview)
      );
    }),
    st.projects.length < 6 && h('button', { class: 'btn ghost', type: 'button', onclick: () => { st.projects.push({ title: '', desc: '', url: '', image: '' }); renderProj(); updateCompleteness(); } }, h('span', {}, '+ Add project')));
  };
  renderProj();

  // experience
  const expBox = h('div');
  const renderExp = () => {
    expBox.replaceChildren(...st.experience.map((exp, i) => {
      return h('div', { class: 'proj-ed' },
        h('button', { class: 'rm', type: 'button', onclick: () => { st.experience.splice(i, 1); renderExp(); updateCompleteness(); } }, 'Remove'),
        h('div', { class: 'form2' },
          inp('Title / Role', () => exp.title, (v) => (exp.title = v), { max: 80, ph: 'Frontend Intern' }),
          inp('Organisation', () => exp.organisation, (v) => (exp.organisation = v), { max: 100, ph: 'Acme Corp' })
        ),
        h('div', { class: 'form2' },
          inp('Start Date', () => exp.start, (v) => (exp.start = v), { max: 30, ph: 'Jun 2024' }),
          inp('End Date', () => exp.end, (v) => (exp.end = v), { max: 30, ph: 'Present' })
        ),
        inp('Description', () => exp.description, (v) => (exp.description = v), { max: 400, area: true, ph: 'Key accomplishments, technologies used…' })
      );
    }),
    st.experience.length < 8 && h('button', { class: 'btn ghost', type: 'button', onclick: () => { st.experience.push({ title: '', organisation: '', start: '', end: '', description: '' }); renderExp(); updateCompleteness(); } }, h('span', {}, '+ Add experience')));
  };
  renderExp();

  // education
  const eduBox = h('div');
  const renderEdu = () => {
    eduBox.replaceChildren(...st.education.map((edu, i) => {
      return h('div', { class: 'proj-ed' },
        h('button', { class: 'rm', type: 'button', onclick: () => { st.education.splice(i, 1); renderEdu(); updateCompleteness(); } }, 'Remove'),
        inp('School / University', () => edu.school, (v) => (edu.school = v), { max: 100, ph: 'Kalvium / MIT' }),
        h('div', { class: 'form2' },
          inp('Degree', () => edu.degree, (v) => (edu.degree = v), { max: 80, ph: 'B.Tech / Bachelor' }),
          inp('Field of Study', () => edu.field, (v) => (edu.field = v), { max: 80, ph: 'Computer Science' })
        ),
        h('div', { class: 'form2' },
          inp('Start Year', () => edu.start_year, (v) => (edu.start_year = v), { max: 20, ph: '2025' }),
          inp('End Year (or Expected)', () => edu.end_year, (v) => (edu.end_year = v), { max: 20, ph: '2029' })
        )
      );
    }),
    st.education.length < 6 && h('button', { class: 'btn ghost', type: 'button', onclick: () => { st.education.push({ school: '', degree: '', field: '', start_year: '', end_year: '' }); renderEdu(); updateCompleteness(); } }, h('span', {}, '+ Add education')));
  };
  renderEdu();

  // certifications
  const certBox = h('div');
  const renderCert = () => {
    certBox.replaceChildren(...st.certifications.map((c, i) => {
      return h('div', { class: 'proj-ed' },
        h('button', { class: 'rm', type: 'button', onclick: () => { st.certifications.splice(i, 1); renderCert(); updateCompleteness(); } }, 'Remove'),
        h('div', { class: 'form2' },
          inp('Certification Name', () => c.name, (v) => (c.name = v), { max: 100, ph: 'AWS Certified Cloud Practitioner' }),
          inp('Issuer', () => c.issuer, (v) => (c.issuer = v), { max: 100, ph: 'Amazon Web Services' })
        ),
        inp('Year / Date', () => c.year, (v) => (c.year = v), { max: 20, ph: '2025' })
      );
    }),
    st.certifications.length < 10 && h('button', { class: 'btn ghost', type: 'button', onclick: () => { st.certifications.push({ name: '', issuer: '', year: '' }); renderCert(); updateCompleteness(); } }, h('span', {}, '+ Add certification')));
  };
  renderCert();

  // achievements
  const achBox = h('div');
  const renderAch = () => {
    achBox.replaceChildren(...st.achievements.map((a, i) => {
      const iInput = h('input', { placeholder: '1st place in National Hackathon 2025', maxlength: 140 });
      iInput.value = a;
      iInput.addEventListener('input', () => { st.achievements[i] = iInput.value; updateCompleteness(); });
      return h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:12px;' },
        h('label', { class: 'field', style: 'flex:1;margin:0;' }, iInput),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { st.achievements.splice(i, 1); renderAch(); updateCompleteness(); } }, h('span', {}, 'Remove'))
      );
    }),
    st.achievements.length < 10 && h('button', { class: 'btn ghost', type: 'button', onclick: () => { st.achievements.push(''); renderAch(); updateCompleteness(); } }, h('span', {}, '+ Add achievement / honor')));
  };
  renderAch();

  const skills = h('input', { placeholder: 'React, Python, Figma…', maxlength: 300 });
  skills.value = st.skills.join(', ');
  skills.addEventListener('input', () => updateCompleteness());

  const err = h('div', { class: 'err', role: 'alert' });
  const saveBtn = h('button', { class: 'btn', type: 'submit' }, h('span', {}, 'Save changes'), h('span', {}, '✓'));

  const form = h('form', { novalidate: true },
    compCard,
    h('div', { class: 'ed-h', style: 'border:0;margin-top:0;padding-top:0' }, 'Photo & vibe'), prev, file,
    h('div', { class: 'ed-h' }, 'Resume'), resumeBox,
    h('div', { class: 'field' }, h('span', {}, 'Page colour'), sw),
    h('div', { class: 'ed-h' }, 'About you'),
    h('div', { class: 'form2' },
      inp('Name', () => st.name, (v) => (st.name = v), { max: 40 }),
      inp('Role / what you do', () => st.role, (v) => (st.role = v), { max: 40, ph: 'Full-stack dev' })),
    h('div', { class: 'form2' },
      inp('Location', () => st.location, (v) => (st.location = v), { max: 100, ph: 'Bengaluru, India' }),
      inp('Phone (Private · for resume only)', () => st.phone, (v) => (st.phone = v), { max: 30, ph: '+91 98765 43210' })),
    inp('One-line tagline', () => st.tagline, (v) => (st.tagline = v), { max: 80, ph: 'I build things that move' }),
    inp('Bio (Professional summary)', () => st.bio, (v) => (st.bio = v), { max: 600, area: true, ph: 'Tell people who you are…' }),
    h('label', { class: 'field' }, h('span', {}, 'Skills'), skills, h('small', {}, 'Comma separated, up to 12')),
    h('div', { class: 'ed-h' }, 'Links & Contact'),
    h('div', { class: 'form2' },
      inp('GitHub', () => st.links.github, (v) => (st.links.github = v), { max: 300, ph: 'github.com/you' }),
      inp('LinkedIn', () => st.links.linkedin, (v) => (st.links.linkedin = v), { max: 300 }),
      inp('Instagram', () => st.links.instagram, (v) => (st.links.instagram = v), { max: 300 }),
      inp('Website', () => st.links.website, (v) => (st.links.website = v), { max: 300 }),
      inp('Public Email', () => st.links.email, (v) => (st.links.email = v), { max: 120, ph: 'you@mail.com' })),
    h('div', { class: 'ed-h' }, 'Projects'), projBox,
    h('div', { class: 'ed-h' }, 'Experience'), expBox,
    h('div', { class: 'ed-h' }, 'Education'), eduBox,
    h('div', { class: 'ed-h' }, 'Certifications'), certBox,
    h('div', { class: 'ed-h' }, 'Achievements & Honors'), achBox,
    err,
    h('div', { class: 'savebar' }, saveBtn, h('a', { class: 'btn ghost', href: '#/u/' + me.username }, h('span', {}, 'View page'))));

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = ''; saveBtn.disabled = true;
    const body = {
      name: st.name,
      tagline: st.tagline,
      role: st.role,
      bio: st.bio,
      phone: st.phone,
      location: st.location,
      links: st.links,
      projects: st.projects,
      experience: st.experience,
      education: st.education,
      certifications: st.certifications,
      achievements: st.achievements.filter(Boolean),
      theme: st.theme,
      resume_public: Boolean(st.resume_public ?? p.resumePublic),
      skills: skills.value.split(',').map((x) => x.trim()).filter(Boolean),
    };
    try {
      const r = await api('/profile', { method: 'PUT', body });
      me = r.me; await loadBase(); updateNav(); toast('Saved ✓ — looking good');
      Object.assign(p, r.profile);
      updateCompleteness();
    } catch (ex) { err.textContent = ex.message; form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }
    saveBtn.disabled = false;
  });

  updateCompleteness();

  const del = h('div', { class: 'danger' }, 'Want out? ', h('button', { type: 'button', onclick: async () => {
    if (!confirm('Delete your page and account for good? This can’t be undone.')) return;
    try { await api('/account', { method: 'DELETE' }); me = null; await loadBase(); updateNav(); toast('Account deleted'); location.hash = '#/'; } catch (ex) { toast(ex.message); }
  } }, 'Delete my account'));

  const el = h('section', { class: 'formpage' }, split(h('h1'), 'Your page', 40), h('div', { class: 'rv in' }, form, del));
  return { el, theme: p.theme };
}

/* resize + crop an uploaded photo to a small square JPEG data-URL */
function shrink(file, size) {
  return new Promise((ok, no) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const s = Math.min(img.width, img.height), g = c.getContext('2d');
      g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url); ok(c.toDataURL('image/jpeg', .82));
    };
    img.onerror = no; img.src = url;
  });
}

function shrinkToBlob(file, size) {
  return new Promise((ok, no) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const s = Math.min(img.width, img.height), g = c.getContext('2d');
      g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? ok(b) : no(new Error('Canvas toBlob failed'))), 'image/jpeg', 0.82);
    };
    img.onerror = no; img.src = url;
  });
}

function shrinkShotToBlob(file, maxW = 1200, maxH = 750) {
  return new Promise((ok, no) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxW || h > maxH) {
        const ratio = Math.min(maxW / w, maxH / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? ok(b) : no(new Error('Canvas toBlob failed'))), 'image/jpeg', 0.80);
    };
    img.onerror = no; img.src = url;
  });
}

/* resize an uploaded project screenshot to max 580x360 while preserving aspect ratio */
function shrinkShot(file, maxW = 580, maxH = 360) {
  return new Promise((ok, no) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxW || h > maxH) {
        const ratio = Math.min(maxW / w, maxH / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', .78));
    };
    img.onerror = no; img.src = url;
  });
}

function shrinkToBlob(file, size) {
  return new Promise((ok, no) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const s = Math.min(img.width, img.height), g = c.getContext('2d');
      g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? ok(b) : no(new Error('Canvas toBlob failed'))), 'image/jpeg', 0.82);
    };
    img.onerror = no; img.src = url;
  });
}

function shrinkShotToBlob(file, maxW = 1200, maxH = 750) {
  return new Promise((ok, no) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxW || h > maxH) {
        const ratio = Math.min(maxW / w, maxH / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? ok(b) : no(new Error('Canvas toBlob failed'))), 'image/jpeg', 0.80);
    };
    img.onerror = no; img.src = url;
  });
}

/* ---------- router ---------- */
function updateNav() {
  const a = $('#navAuth span');
  a.textContent = me ? 'Log out' : 'Log in';
  $('#navAuth').setAttribute('href', me ? '#/logout' : '#/login');
  $('#navMe span').textContent = me ? 'My page' : 'Join';
  $('#navMe').setAttribute('href', me ? '#/me' : '#/signup');
}
function markNav(hash) {
  $$('.pill').forEach((p) => p.classList.remove('on'));
  if (hash.startsWith('#/crew')) $('[data-nav=crew]').classList.add('on');
  else if (hash === '#/me' || hash === '#/edit' || (me && hash === '#/u/' + me.username)) $('[data-nav=me]').classList.add('on');
}

let busy = false, current = null;
async function route(first) {
  const hash = location.hash || '#/';
  if (hash === current) return;
  if (busy) { location.hash = current || '#/'; return; }
  busy = true;

  // redirects
  if (hash === '#/logout') {
    try { await api('/logout', { method: 'POST' }); } catch {}
    me = null; await loadBase().catch(() => {}); updateNav(); toast('Logged out. See you!');
    busy = false; current = null; location.replace('#/'); return;
  }
  if (hash === '#/me') { busy = false; location.hash = me ? '#/u/' + me.username : '#/signup'; return; }
  if ((hash === '#/login' || hash === '#/signup') && me) { busy = false; location.hash = '#/u/' + me.username; return; }
  if (hash === '#/edit' && !me) { busy = false; location.hash = '#/login'; return; }

  current = hash;
  const wait = first ? Promise.resolve() : pixel('in');
  let out;
  try {
    if (hash === '#/' || hash === '#/crew') { await loadBase().catch(() => {}); out = homeView(); }
    else if (hash === '#/login' || hash === '#/signup') {
      await loadBase().catch(() => {});
      out = googleAuthView();
    }
    else if (hash === '#/password-login') {
      await loadBase().catch(() => {});
      out = authView('login');
    }
    else if (hash === '#/edit') out = await editView();
    else if (hash.startsWith('#/u/')) out = await profileView(hash.slice(4));
    else out = notFound();
  } catch (ex) {
    if (ex.status === 401) { me = null; updateNav(); busy = false; current = null; location.hash = '#/login'; return; }
    out = { el: h('section', { class: 'center' }, h('h1', {}, 'Oops'), h('p', {}, ex.message)), theme: 0 };
  }
  await wait;
  const view = $('#view');
  view.classList.remove('ready'); view.replaceChildren(out.el);
  setTheme(out.theme); markNav(hash);
  document.title = (out.title ? out.title + ' — ' : '') + CLASS_NAME;
  scrollTo({ top: 0, behavior: 'instant' }); lastY = 0; vy = 0;
  if (hash === '#/crew') requestAnimationFrame(() => scrollTo({ top: $('#crew').offsetTop - 70, behavior: 'instant' }));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  view.classList.add('ready'); observe(view);
  await (first ? Promise.resolve() : pixel('out'));
  busy = false;
}
addEventListener('hashchange', () => route());

/* ---------- boot ---------- */
(async function boot() {
  buildPx();
  const introP = $('#intro p');
  if (introP) introP.textContent = CLASS_NAME;
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { sizeInk(); if (!busy) buildPx(); }, 150); });
  const numEl = $('#introNum'); const t0 = performance.now();
  const counter = () => { const p = Math.min(1, (performance.now() - t0) / 1100); numEl.textContent = Math.round(p * p * 100); if (p < 1) requestAnimationFrame(counter); };
  counter();
  await loadBase().catch(() => {}); updateNav();
  requestAnimationFrame(loop);
  await route(true);
  await new Promise((r) => setTimeout(r, Math.max(0, 1150 - (performance.now() - t0))));
  // dissolve the intro away with the pixel grid
  px.style.setProperty('--c', '#0b0b0b'); px.classList.add('on');
  cells.forEach((c) => { c.style.opacity = 1; c.style.background = Math.random() < .12 ? '#FFD60A' : ''; });
  $('#intro').classList.add('done');
  await (reduce ? Promise.resolve() : Promise.all(cells.map((c) => { c.style.opacity = ''; return c.animate([{ opacity: 1, transform: 'scale(1.04)' }, { opacity: 0, transform: 'scale(.4)' }], { duration: 170, delay: Math.random() * 520, fill: 'both' }).finished; })));
  px.classList.remove('on');
})();
