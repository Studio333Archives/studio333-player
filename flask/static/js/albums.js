// albums.js — streamlined UI, instant search, album title header, "playlist name" = variant
const $ = s => document.querySelector(s);
const api = (u, opt = {}) =>
  fetch(u, opt).then(r => (r.ok ? r.json() : r.text().then(t => { throw new Error(t); })));

const qInp            = $("#q");
const resultsBox      = $("#results");
const tracksOl        = $("#tracks");
const albTitle        = $("#albTitle");
const albSlug         = $("#albSlug");
const albCreateBtn    = $("#albCreateBtn");
const albumSelect     = $("#albumSelect");
const loadAlbumBtn    = $("#loadAlbumBtn");
const addSelectedBtn  = $("#addSelectedBtn");
const saveOrderBtn    = $("#saveOrderBtn");
const currentAlbTitle = $("#currentAlbumTitle");
const variantName     = $("#variantName");

let currentAlbumId = null;
let currentTracks  = [];  // [{id, position, media_id, title, rel_path}...]
let lastQuery      = "";
let navIndex       = -1;
let lastResults    = [];

// ---- utils ----
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function setDisabled(el, flag){ if (el) el.disabled = !!flag; }

// ---- results rendering ----
function renderResults(items){
  resultsBox.innerHTML = "";
  lastResults = items.slice(0);
  navIndex = -1;

  if (!items.length){
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = lastQuery ? "No matches." : "Type to search…";
    resultsBox.appendChild(empty);
    updateAddButtonState();
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach((it, i)=>{
    const row = document.createElement("label");
    row.className = "row";
    row.dataset.index = String(i);
    // IMPORTANT: value is rel_path (server resolves to real media UUID)
    row.innerHTML = `
      <input type="checkbox" class="pick" value="${escapeHtml(it.rel_path)}">
      <span class="title">${escapeHtml(it.title || "(untitled)")}</span>
      <span class="path">${escapeHtml(it.rel_path || "")}</span>
      <span class="kind">${it.kind || ""}</span>
    `;
    frag.appendChild(row);
  });
  resultsBox.appendChild(frag);
  updateAddButtonState();
}

function highlightNav(){
  const rows = resultsBox.querySelectorAll(".row");
  rows.forEach(r => r.classList.remove("active"));
  if (navIndex >= 0 && navIndex < rows.length){
    rows[navIndex].classList.add("active");
    rows[navIndex].scrollIntoView({ block: "nearest" });
  }
}

// ---- tracks rendering ----
function renderTracks(){
  tracksOl.innerHTML = "";
  currentTracks.sort((a,b)=>a.position-b.position);
  for (const t of currentTracks){
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.tid = t.id;
    li.innerHTML = `
      <span class="grab">↕</span>
      <span class="t">${escapeHtml(t.title || t.rel_path || "")}</span>
      <button class="rm" title="Remove">✕</button>
    `;
    tracksOl.appendChild(li);
  }
  setDisabled(saveOrderBtn, currentTracks.length === 0);
}

// ---- albums list ----
async function loadAlbums(){
  const data = await api("/api/albums");
  albumSelect.innerHTML = "";
  (data.items||[]).forEach(a=>{
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.title} (${a.slug})`;
    albumSelect.appendChild(opt);
  });
}

// ---- create album ----
albCreateBtn.addEventListener("click", async ()=>{
  const title = albTitle.value.trim();
  const slug  = albSlug.value.trim();
  if (!title || !slug) return;
  const row = await api("/api/albums", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ title, slug })
  });
  await loadAlbums();
  albumSelect.value = row.id;
  currentAlbumId = row.id;
  await openAlbum();
  qInp.focus();
});

// ---- open album ----
loadAlbumBtn.addEventListener("click", async ()=>{
  currentAlbumId = albumSelect.value || null;
  if (!currentAlbumId) return;
  await openAlbum();
  qInp.focus();
});

async function openAlbum(){
  const data = await api(`/api/albums/${currentAlbumId}`);
  currentTracks = data.tracks || [];
  renderTracks();
  currentAlbTitle.textContent = (data.album && data.album.title) ? data.album.title : "—";
  updateAddButtonState();
}

// ---- instant search (debounced on input) ----
const debounce = (fn, ms=160) => {
  let t = 0;
  return (...args)=>{
    clearTimeout(t);
    t = setTimeout(()=>fn.apply(null,args), ms);
  };
};

const runSearch = async ()=>{
  const q = qInp.value.trim();
  lastQuery = q;
  if (!q){
    renderResults([]);
    return;
  }
  const data = await api(`/api/albums/media_search?q=${encodeURIComponent(q)}&limit=1000`);
  renderResults(data.items || []);
};
const debouncedSearch = debounce(runSearch, 160);
qInp.addEventListener("input", debouncedSearch);

// keyboard navigation inside search
qInp.addEventListener("keydown", e=>{
  const rows = resultsBox.querySelectorAll(".row");
  if (e.key === "ArrowDown"){
    if (rows.length){
      navIndex = Math.min(navIndex + 1, rows.length - 1);
      highlightNav(); e.preventDefault();
    }
  } else if (e.key === "ArrowUp"){
    if (rows.length){
      navIndex = Math.max(navIndex - 1, 0);
      highlightNav(); e.preventDefault();
    }
  } else if (e.key === "Enter"){
    if (rows.length && navIndex >= 0){
      const chk = rows[navIndex].querySelector("input.pick");
      if (chk){ chk.checked = !chk.checked; updateAddButtonState(); }
      e.preventDefault();
    }
  }
});

resultsBox.addEventListener("change", e=>{
  if (e.target && e.target.classList.contains("pick")) updateAddButtonState();
});

function updateAddButtonState(){
  const any = resultsBox.querySelector('input.pick:checked');
  addSelectedBtn.disabled = !any || !currentAlbumId;
}

// ---- add selected to album (send rel_paths + variant) ----
addSelectedBtn.addEventListener("click", async ()=>{
  if (!currentAlbumId) return;
  const paths = [...resultsBox.querySelectorAll('input.pick:checked')].map(x=>x.value);
  if (!paths.length) return;
  const variant = (variantName.value || "").trim();
  await api(`/api/albums/${currentAlbumId}/tracks_from_index`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ paths, variant })
  });
  await openAlbum();
  qInp.focus();
});

// ---- remove single track (✕) ----
tracksOl.addEventListener("click", async (e)=>{
  if (!e.target.classList.contains("rm")) return;
  const li = e.target.closest("li");
  const tid = li.dataset.tid;
  await api(`/api/albums/${currentAlbumId}/tracks/${tid}`, { method:"DELETE" });
  currentTracks = currentTracks.filter(t=>t.id !== tid);
  renderTracks();
});

// ---- drag to reorder ----
let dragTid = null;
tracksOl.addEventListener("dragstart", e=>{
  const li = e.target.closest("li");
  dragTid = li?.dataset.tid || null;
  e.dataTransfer.setData("text/plain", dragTid || "");
});
tracksOl.addEventListener("dragover", e=>{ e.preventDefault(); });
tracksOl.addEventListener("drop", e=>{
  e.preventDefault();
  const dropLi = e.target.closest("li");
  if (!dragTid || !dropLi) return;
  const fromIdx = currentTracks.findIndex(t=>t.id===dragTid);
  const toIdx   = currentTracks.findIndex(t=>t.id===dropLi.dataset.tid);
  if (fromIdx<0 || toIdx<0 || fromIdx===toIdx) return;
  const [moved] = currentTracks.splice(fromIdx,1);
  currentTracks.splice(toIdx,0,moved);
  currentTracks.forEach((t,i)=>t.position = i+1);
  renderTracks();
});

// ---- save order ----
saveOrderBtn.addEventListener("click", async ()=>{
  if (!currentAlbumId) return;
  const order = [...tracksOl.querySelectorAll("li")].map(li => li.dataset.tid);
  if (!order.length) return;
  await api(`/api/albums/${currentAlbumId}/tracks/reorder`, {
    method:"PUT",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ order })
  });
  await openAlbum();
});

// ---- boot ----
(async function boot(){
  try {
    await loadAlbums();
    renderResults([]);
    updateAddButtonState();
    qInp.focus();
  } catch (e){
    console.error(e);
  }
})();
