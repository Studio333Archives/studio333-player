

      // --- persistence header (must appear BEFORE any use) ---
  const DEBUG_GUI_SYNC = true;
  const STORAGE_KEY = 'blobPlayerState.v1';
  function log(...a){ if (DEBUG_GUI_SYNC) console.debug('[GUI]', ...a); }


  import * as THREE from "three";
  import { OrbitControls } from "three/addons/controls/OrbitControls.js";
  import { GUI } from "lil-gui";
  import { SimplexNoise } from "three/addons/math/SimplexNoise.js";

    /** Initializes renderer and attaches to container. */
  const container = document.getElementById('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.physicallyCorrectLights = true;
  container.appendChild(renderer.domElement);

    /** Creates scene and camera. */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 30000);

  camera.position.set(0, 1.6, 3.5);

    /** Adds base lights. */
  scene.add(new THREE.AmbientLight(0xffffff, 0.02));
  const rim = new THREE.DirectionalLight(0xffffff, 0.18);
  rim.position.set(-3, 2, -2);
  scene.add(rim);

  const pool = new THREE.SpotLight(0xff66cc, 4.0, 3.2, Math.PI * 0.18, 0.55, 2.0);
  pool.position.set(0, 1.6, 0);
  pool.target.position.set(0, 0, 0);
  scene.add(pool, pool.target);

    /** Builds floor fade. */
  const fadeGeo = new THREE.PlaneGeometry(40, 40);
  const fadeMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uRadius: { value: 1.6 }, uSoft: { value: 1.2 } },
    vertexShader: `varying vec2 vXZ; void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vXZ = wp.xz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: `precision highp float; uniform float uRadius,uSoft; varying vec2 vXZ; void main(){ float r=length(vXZ); float a=smoothstep(uRadius,uRadius+uSoft,r); gl_FragColor=vec4(0.,0.,0.,a); }`
  });
  const fade = new THREE.Mesh(fadeGeo, fadeMat);
  fade.rotation.x = -Math.PI*0.5; fade.position.y = 0.0005; scene.add(fade);

    /** GLSL simplex helper source. */
  const simplexGLSL = `
      vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
      vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
      float snoise(vec3 v){
        const vec2  C = vec2(1.0/6.0, 1.0/3.0);
        const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
        vec3 i  = floor(v + dot(v, C.yyy));
        vec3 x0 = v - i + dot(i, C.xxx);
        vec3 g = step(x0.yzx, x0.xyz);
        vec3 l = 1.0 - g;
        vec3 i1 = min(g.xyz, l.zxy);
        vec3 i2 = max(g.xyz, l.zxy);
        vec3 x1 = x0 - i1 + C.xxx;
        vec3 x2 = x0 - i2 + 2.0*C.xxx;
        vec3 x3 = x0 - 1.0 + 3.0*C.xxx;
        i = mod289(i);
        vec4 p = permute( permute( permute(
                  i.z + vec4(0.0, i1.z, i2.z, 1.0))
                + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                + i.x + vec4(0.0, i1.x, i2.x, 1.0));
        float n_ = 1.0/7.0;
        vec3  ns = n_ * D.wyz - D.xzx;
        vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
        vec4 x_ = floor(j * ns.z);
        vec4 y_ = floor(j - 7.0 * x_);
        vec4 x = x_ *ns.x + ns.yyyy;
        vec4 y = y_ *ns.x + ns.yyyy;
        vec4 h = 1.0 - abs(x) - abs(y);
        vec4 b0 = vec4( x.xy, y.xy );
        vec4 b1 = vec4( x.zw, y.zw );
        vec4 s0 = floor(b0)*2.0 + 1.0;
        vec4 s1 = floor(b1)*2.0 + 1.0;
        vec4 sh = -step(h, vec4(0.0));
        vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
        vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
        vec3 p0 = vec3(a0.xy,h.x);
        vec3 p1 = vec3(a0.zw,h.y);
        vec3 p2 = vec3(a1.xy,h.z);
        vec3 p3 = vec3(a1.zw,h.w);
        vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
        p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
        vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
        m = m*m;
        return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,p3)));
  }`;

    /** UI element handles. */
  const uiPanel = document.getElementById('ui');
  const webcamBtn = document.getElementById('webcamBtn');
  const imgInput  = document.getElementById('imgInput');
  const vidInput  = document.getElementById('vidInput');
  const audioInput = document.getElementById('audioInput');
  const clearBtn  = document.getElementById('clearBtn');
  const startBtn  = document.getElementById('startBtn');
  const prevBtn   = document.getElementById('prevBtn');
  const nextBtn   = document.getElementById('nextBtn');
  const loopChk   = document.getElementById('loopChk');
  const playlistSelect = document.getElementById('playlistSelect');

    /** Toggles UI (ESC). */

  let uiVisible = false;

  function applyUIVisibility(){
    uiPanel.style.display = uiVisible ? 'flex' : 'none';
    const guiRoot = document.querySelector('.lil-gui.root');
    if (guiRoot) guiRoot.style.display = uiVisible ? '' : 'none';
  }

  // document.addEventListener('keydown', (e)=>{
  //   if (e.key === 'Escape'){
  //     uiVisible = !uiVisible;
  //     applyUIVisibility();
  //   }
  // });


// --- Fullscreen toggle with UI hide/show (press "f") ---
// searchBtn: search icon button; searchBox: search panel container; playlistSel: the <select> with playlist
  const searchBtn   = document.getElementById('searchToggle');
  const searchBox   = document.getElementById('searchPanel');
  const playlistSel = document.getElementById('playlistSelect');

  let __wasUiVisible = null, __wasSearchOpen = false; // remembers search panel state across fullscreen


/** Returns true if document is currently in any vendor fullscreen mode. */
  function isFs(){
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  }

/** Requests browser fullscreen on <html>. */
  function enterFs(){
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen).call(el);
  }

/** Exits browser fullscreen. */
  function exitFs(){
    (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen).call(document);
  }

/**
 * Hides or restores UI chrome (lil-gui, bottom control cluster, search affordances).
 * When hide=true, remembers current UI visibility and hides it; when false, restores it.
 */
  function hideChrome(hide){
    if (hide){
      __wasUiVisible = uiVisible;
    // remember whether search panel was open before hiding
      __wasSearchOpen = !!(searchBox && !searchBox.classList.contains('hidden'));

      uiVisible = false;
      applyUIVisibility();

      if (searchBtn)   searchBtn.classList.add('hidden');
      if (playlistSel) playlistSel.classList.add('hidden');
    if (searchBox)   searchBox.classList.add('hidden'); // force hidden in FS
  } else {
    if (__wasUiVisible !== null){
      uiVisible = __wasUiVisible;
      __wasUiVisible = null;
    }
    applyUIVisibility();

    if (searchBtn)   searchBtn.classList.remove('hidden');
    if (playlistSel) playlistSel.classList.remove('hidden');

    // restore exactly what the user had before entering fullscreen
    if (searchBox){
      if (__wasSearchOpen){
        searchBox.classList.remove('hidden');
      } else {
        searchBox.classList.add('hidden'); // do not pop open when leaving FS
      }
    }
  }
}


/**
 * Unified key handler: ESC → toggle UI, 'f' → fullscreen, ←/→ → playlist prev/next.
 * Replaces the previous fullscreen-only keydown block and supersedes the ESC-only block.
 * Uses existing helpers: uiVisible, applyUIVisibility, isFs, enterFs, exitFs, hideChrome,
 * prevInPlaylist, nextInPlaylist, playlist, autoAdvance.
 */
document.addEventListener('keydown', (e) => {
  const key = (e.key || e.code || '').toLowerCase();

  // identify editable contexts (inputs, textareas, selects, contentEditable)
  const t = e.target;
  const tag = (t && t.tagName) ? t.tagName.toUpperCase() : '';
  const isEditable =
  !!t && (t.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');

  // treat search panel as a typing context
  const sp = document.getElementById('searchPanel');
  const searchOpen = !!(sp && !sp.classList.contains('hidden'));

  // ESC — toggle UI
  if (key === 'escape') {
    uiVisible = !uiVisible;
    applyUIVisibility();
    e.preventDefault();
    return;
  }

  // ignore all other shortcuts while typing / in search / with modifiers
  if (isEditable || searchOpen || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;

  // 'f' — fullscreen
  if (key === 'f') {
    if (!isFs()) { enterFs(); hideChrome(true); }
    else { exitFs(); hideChrome(false); }
    e.preventDefault();
    return;
  }

  // ← / → — playlist prev/next
  if (key === 'arrowleft') {
    if (Array.isArray(playlist) && playlist.length && typeof prevInPlaylist === 'function') {
      try { autoAdvance = false; } catch {}
      prevInPlaylist();
      e.preventDefault();
    }
    return;
  }
  if (key === 'arrowright') {
    if (Array.isArray(playlist) && playlist.length && typeof nextInPlaylist === 'function') {
      try { autoAdvance = false; } catch {}
      nextInPlaylist();
      e.preventDefault();
    }
    return;
  }
}, { passive: false });





/** Restores UI when fullscreen is exited by user/browser UI. */
['fullscreenchange','webkitfullscreenchange','mozfullscreenchange','MSFullscreenChange']
.forEach(ev => document.addEventListener(ev, ()=>{ if (!isFs()) hideChrome(false); }));





    /** Shared media source state. */
const source = {
  type:"none",
  tex:null,
  stream:null,
  videoEl:null,
  imageEl:null,
  audioEl:null,
  spectrumCanvas:null,
  spectrumCtx:null,
  spectrumTex:null
};

    /** Resolves possibly-relative URLs. */
function resolveUrl(u){ try{ return new URL(u, location.href).href; }catch(e){ return u; } }

    /** Checks if a <video> currently has a decodable frame. */
function videoHasFrame(v){ return v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0; }

    /** Ensures an AudioContext + Analyser are ready. */
let audioCtx = null, analyser = null, freqData = null;
let audioSrcNode = null, streamSrcNode = null, audioElNode = null;
const MEDIA_NODE = new WeakMap();
async function ensureAudioCtx(){
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.72;
  freqData = new Uint8Array(analyser.frequencyBinCount);
}

    /** Disconnects any current audio graph. */
function disconnectAudio(){
  try{ audioSrcNode && audioSrcNode.disconnect(); }catch(e){}
  try{ streamSrcNode && streamSrcNode.disconnect(); }catch(e){}
  try{ audioElNode && audioElNode.disconnect(); }catch(e){}
  audioSrcNode = streamSrcNode = audioElNode = null;
}

    /** Connects a <video> element to analyser/output. */
function connectVideoElAudio(videoEl){
  if (!videoEl || !audioCtx) return;
  disconnectAudio();
  let node = MEDIA_NODE.get(videoEl);
  if (!node){
    try{ node = audioCtx.createMediaElementSource(videoEl); MEDIA_NODE.set(videoEl, node); }catch(e){ return; }
  }
  audioSrcNode = node;
  try{ audioSrcNode.connect(analyser); audioSrcNode.connect(audioCtx.destination); }catch(e){}
}

    /** Connects a MediaStream to analyser. */
function connectStreamAudio(stream){
  if (!stream || !audioCtx) return;
  disconnectAudio();
  try{ streamSrcNode = audioCtx.createMediaStreamSource(stream); streamSrcNode.connect(analyser); }catch(e){}
}

    /** Connects an <audio> element to analyser/output. */
function connectAudioEl(audioEl){
  if (!audioEl || !audioCtx) return;
  disconnectAudio();
  let node = MEDIA_NODE.get(audioEl);
  if (!node){
    try{ node = audioCtx.createMediaElementSource(audioEl); MEDIA_NODE.set(audioEl, node); }catch(e){ return; }
  }
  audioElNode = node;
  try{ audioElNode.connect(analyser); audioElNode.connect(audioCtx.destination); }catch(e){}
}

    /** Tears down adaptive streaming controllers. */
let hls = null, dash = null;
function destroyABR(){
  if (hls){ try{ hls.destroy(); }catch(e){} hls=null; }
  if (dash){ try{ dash.reset(); }catch(e){} dash=null; }
}

    /** Wires a texture into all materials. */
function setTexture(tex){
  source.tex = tex;
  sphereMat.uniforms.uTex.value = tex;
  reflectMatBottom.uniforms.uTex.value = tex;
  reflectMatTop.uniforms.uTex.value = tex;
  spherePointsMat.uniforms.uTex.value = tex;
  const use = tex ? 1 : 0;
  sphereMat.uniforms.uUseTex.value = use;
  reflectMatBottom.uniforms.uUseTex.value = use;
  reflectMatTop.uniforms.uUseTex.value = use;
  spherePointsMat.uniforms.uUseTex.value = use;
}

    /** Stops webcam tracks and detaches from <video>. */
function stopWebcam(){
  if (source.stream){ source.stream.getTracks().forEach(t=>t.stop()); source.stream=null; }
  if (source.videoEl && source.videoEl.srcObject){ source.videoEl.srcObject = null; }
}

    /** Pauses and clears current audio element. */
function clearAudio(){
  if (source.audioEl){
    try{ source.audioEl.pause(); }catch(e){}
    source.audioEl.removeAttribute('src'); source.audioEl.load();
    source.audioEl = null;
  }
  if (source.spectrumTex){ try{ source.spectrumTex.dispose(); }catch(e){} }
  source.spectrumTex = null; source.spectrumCanvas = null; source.spectrumCtx = null;
}

    /** Clears current file video element. */
function clearVideoFile(){
  if (source.videoEl && source.type==="video"){
    try{ source.videoEl.pause(); }catch(e){}
    source.videoEl.removeAttribute('src'); source.videoEl.load();
  }
}

    /** Clears current image handle. */
function clearImage(){ source.imageEl = null; }

    /** Clears any media source, audio and texture. */
function clearSource(){
  destroyABR(); stopWebcam(); clearAudio(); disconnectAudio(); clearVideoFile(); clearImage();
  setTexture(null); source.type="none"; webcamBtn.textContent="Webcam: OFF";
}

    /** Returns a shared <video>, creating if missing. */
function getOrCreateVideo(){
  if (source.videoEl) return source.videoEl;
  const v = document.createElement('video');
  v.autoplay = true; v.playsInline = true; v.muted = false; v.loop = false;
  v.crossOrigin = "anonymous";
  source.videoEl = v;
  return v;
}

    /** Waits until a <video> can produce frames. */
async function awaitCanPlay(video){
  if (videoHasFrame(video)) return;
  await new Promise((resolve, reject)=>{
    const done=()=>{ cleanup(); resolve(); };
    const fail=()=>{ cleanup(); reject(new Error("[Media] video error")); };
    const cleanup=()=>{
      video.removeEventListener("canplay", done);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("canplay", done, { once:true });
    video.addEventListener("loadeddata", done, { once:true });
    video.addEventListener("error", fail, { once:true });
  });
}

    /** Attempts to play a media element and reports success. */
async function tryPlay(el){ try { await el.play(); return true; } catch(e){ return false; } }

    /** Builds the spectrum drawing canvas + Three texture. */
function buildSpectrumTexture(width=256, height=256){
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  source.spectrumCanvas = canvas;
  source.spectrumCtx = ctx;
  source.spectrumTex = tex;
  return tex;
}

    /** Draws the current spectrum into the spectrum canvas. */
function drawSpectrumTexture(){
  if (!source.spectrumCtx || !freqData) return;
  const ctx = source.spectrumCtx;
  const { width:w, height:h } = source.spectrumCanvas;
  ctx.fillStyle = "#000"; ctx.fillRect(0,0,w,h);
  const bins = freqData.length;
  const barW = w / bins;
  for (let i=0;i<bins;i++){
    const v = freqData[i]/255;
    const bh = v * h;
        // simple vertical bars + soft gradient
    const g = ctx.createLinearGradient(0,h-bh,0,h);
    g.addColorStop(0, `rgba(${Math.floor(255*v)},${Math.floor(255*(1-v))},255,1)`);
    g.addColorStop(1, `rgba(80,80,120,1)`);
    ctx.fillStyle = g;
    ctx.fillRect(i*barW, h-bh, Math.max(1, barW-1), bh);
  }
  if (source.spectrumTex){ source.spectrumTex.needsUpdate = true; }
}



/** URL-encodes a relative path by segments so spaces/utf8 work in fetch() and <audio>/<video>. */
function encodePath(p){ return p.split('/').map(encodeURIComponent).join('/'); }

/** Returns 'audio' | 'video' | 'image' | 'hls' | 'dash' | 'unknown' from file extension. */
function mediaTypeFromExt(path){
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (['mp3','wav','ogg','m4a','flac','aac'].includes(ext)) return 'audio';
  if (['mp4','webm','ogv','mov','m4v'].includes(ext))       return 'video';
  if (['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) return 'image';
  if (ext === 'm3u8') return 'hls';
  if (ext === 'mpd')  return 'dash';
  return 'unknown';
}

/** Parses a unix-tree style listing into absolute-ish relative file paths. */
function parseTreeToFiles(treeText){
  const files = [];
  const stack = [];           // stack[depth] = dirname at that depth
  const lines = treeText.split('\n');

  const DIR_RE  = /^([\s│]*)(?:├──|└──)\s+([^.\n\r]+)$/; // dir line (no dot in name)
  const FILE_RE = /^([\s│]*)(?:├──|└──)\s+(.+\.[A-Za-z0-9]+)$/; // file with extension

  const depthOf = (prefix)=> (prefix.match(/│/g)||[]).length;

  for (let raw of lines){
    const line = raw.replace(/\r/g,'').trimEnd();
    if (!line) continue;

    let m = line.match(DIR_RE);
    if (m){
      const depth = depthOf(m[1]);
      const name  = m[2].trim();
      stack[depth] = name;
      stack.length = depth + 1;
      continue;
    }

    m = line.match(FILE_RE);
    if (m){
      const depth = depthOf(m[1]);
      const name  = m[2].trim();
      const parts = stack.slice(0, depth+1).filter(Boolean);
      // if a directory wasn’t captured at this depth, treat as root file
      const path  = (parts.length ? parts.join('/') + '/' : '') + name;
      files.push(path);
    }
  }
  return files;
}

/** Builds playlist objects ({type,label,url}) from a file list and a base path prefix. */
function buildPlaylist(files, basePath='.'){
  const entries = [];
  for (const rel of files){
    const type = mediaTypeFromExt(rel);
    if (type === 'unknown') continue;
    const url = (basePath === '.' ? '' : (basePath.replace(/\/+$/,'') + '/')) + encodePath(rel);
    entries.push({
      type,
      label: rel,   // keep folder context in label
      url
    });
  }
  // nice-ish ordering: folders/alpha, but keep HLS/DASH first if present
  entries.sort((a,b)=>{
    const order = {hls:0, dash:1, video:2, image:3, audio:4, unknown:5};
    if (order[a.type] !== order[b.type]) return order[a.type]-order[b.type];
    return a.label.localeCompare(b.label, undefined, {numeric:true, sensitivity:'base'});
  });
  return entries;
}



/** Loads audioteka.txt (your tree dump), parses it, and fills the global playlist. */
async function loadPlaylistFromTreeFile(urlToTree, baseMediaPath='.'){
  try{
    const res = await fetch(urlToTree, { cache:'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    const files = parseTreeToFiles(text);
    const items = buildPlaylist(files, baseMediaPath);

    if (!items.length){
      console.warn('[Playlist] Tree parsed but no playable media found.');
      return false;
    }
    // mutate existing global playlist array so the rest of the app keeps references
    playlist.length = 0;
    playlist.push(...items);
    refreshPlaylistSelect();
    console.info('[Playlist] Loaded from tree:', playlist.length, 'items');
    return true;
  }catch(err){
    console.error('[Playlist] Failed to load from tree', err);
    return false;
  }
}




/** Playlist data and state (filled at runtime from audioteka.txt). */
const playlist = [];
let currentIndex = 0;
let autoAdvance = true;

/** Rebuilds the playlist <select> UI. */
function refreshPlaylistSelect(){
  playlistSelect.innerHTML = "";
  playlist.forEach((item, i)=>{
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i+1}. [${item.type}] ${item.label}`;
    playlistSelect.appendChild(opt);
  });
  if (playlist.length) playlistSelect.value = String(currentIndex);
}

/* === Point these to your actual locations === */
const BASE_MEDIA_PATH = 'media/archives';           // media root containing the files
const TREE_FILE_PATH  = 'media/archives/audioteka.txt'; // the tree listing file

// Build the playlist from the tree file
loadPlaylistFromTreeFile(TREE_FILE_PATH, BASE_MEDIA_PATH).then(async ok=>{
  if (!ok){
    console.warn('[Playlist] falling back to demo entry');
    playlist.push({
      type:'hls',
      label:'HLS test',
      url:'media/test/KuzniakTeicherHope/master.m3u8'
    });
    refreshPlaylistSelect();
  }
  // restore settings + last played (or default preset) AFTER playlist exists
  await restoreFromStorageOrPreset();
});







/** Loads a playlist entry by index and wires media/texture/audio. */
async function loadPlaylistIndex(ix){
  if (ix<0 || ix>=playlist.length){ return false; }
  autoAdvance = true;
  currentIndex = ix;
  refreshPlaylistSelect();
  schedulePersist(); // <-- persist index change immediately

  await ensureAudioCtx();
  if (audioCtx && audioCtx.state === "suspended"){
    try{ await audioCtx.resume(); }catch(e){}
  }

  const entry = playlist[ix];
  destroyABR();

  // clean up anything from the previous source
  if (entry.type!=="image"){ clearImage(); }
  if (entry.type!=="webcam"){ stopWebcam(); }
  clearAudio();
  disconnectAudio();
  setTexture(null);

  // --- Webcam ---
  if (entry.type === "webcam"){
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:"user" }, audio:true });
      const video = getOrCreateVideo();
      video.muted = true;
      video.srcObject = stream;
      await awaitCanPlay(video);
      await tryPlay(video);

      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;

      clearVideoFile();
      source.type="webcam";
      source.stream=stream;
      setTexture(tex);
      connectStreamAudio(stream);
      webcamBtn.textContent = "Webcam: ON";
      schedulePersist(); // <-- persist full state after source is set
      return true;
    }catch(e){
      console.error("[Webcam] failed", e);
      return false;
    }
  }

  // --- Image ---
  if (entry.type === "image"){
    try{
      const img = new Image(); img.crossOrigin="anonymous";
      await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; img.src = resolveUrl(entry.url); });
      const tex = new THREE.Texture(img);
      tex.needsUpdate = true;
      tex.colorSpace = THREE.SRGBColorSpace;
      source.type="image";
      source.imageEl=img;
      setTexture(tex);
      schedulePersist();
      return true;
    }catch(err){
      console.error("[Image] load failed", entry.url, err);
      return false;
    }
  }

  // --- Audio-only (mp3/wav/…): use analyser-driven spectrum canvas as the media texture ---
  if (entry.type === "audio"){
    try{
      await ensureAudioCtx();
      if (audioCtx && audioCtx.state === "suspended"){ try{ await audioCtx.resume(); }catch{} }

      destroyABR(); stopWebcam(); clearVideoFile(); clearImage(); clearAudio(); disconnectAudio(); setTexture(null);

      const audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.autoplay = true;
      audio.loop = false;
      audio.src = resolveUrl(entry.url);
      audio.onended = ()=>{ if (autoAdvance) nextInPlaylist(); };
      audio.onerror =  ()=>{ if (autoAdvance) nextInPlaylist(); };

      const ok = await tryPlay(audio);
      if (!ok) return false;

      connectAudioEl(audio);

      const tex = buildSpectrumTexture(256,256);
      source.type  = "audio";
      source.audioEl = audio;
      setTexture(tex);
      schedulePersist();
      return true;
    }catch(err){
      console.error("[Audio] setup failed", err);
      return false;
    }
  }

  // --- Video / HLS / DASH ---
  try{
    const video = getOrCreateVideo();
    video.crossOrigin = "anonymous";
    video.loop = false;

    let playOk = false;
    const url = resolveUrl(entry.url);

    if (entry.type === "hls"){
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        await awaitCanPlay(video);
        playOk = await tryPlay(video);
      } else if (window.Hls && window.Hls.isSupported()){
        hls = new window.Hls({ enableWorker:true, lowLatencyMode:true });
        hls.attachMedia(video);
        await new Promise(res=>{
          hls.on(window.Hls.Events.MEDIA_ATTACHED, ()=>{ hls.loadSource(url); });
          hls.on(window.Hls.Events.MANIFEST_PARSED, async ()=>{
            await awaitCanPlay(video);
            playOk = await tryPlay(video);
            res();
          });
        });
      } else { return false; }
    } else if (entry.type === "dash"){
      if (window.dashjs){
        dash = window.dashjs.MediaPlayer().create();
        dash.initialize(video, url, false);
        await awaitCanPlay(video);
        playOk = await tryPlay(video);
      } else { return false; }
    } else {
      // plain mp4/webm
      video.src = url;
      await awaitCanPlay(video);
      playOk = await tryPlay(video);
    }

    if (!playOk) return false;

    if (source.tex && source.tex.dispose){ try{ source.tex.dispose(); }catch(_){} }
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    source.type="video";
    source.videoEl = video;
    setTexture(tex);
    connectVideoElAudio(video);
    schedulePersist();
    return true;
  }catch(err){
    console.error("[Video] setup/texture failed", err);
    return false;
  }
}













    /** Advances to next playlist entry (with loop handling). */
function nextInPlaylist(){
  if (!Array.isArray(playlist) || playlist.length === 0) return;
  if (playlist.length === 1){ loadPlaylistIndex(0); return; }
  let nx = currentIndex + 1;
  if (nx >= playlist.length){
    if (loopChk.checked){ nx = 0; } else { loadPlaylistIndex(currentIndex); return; }
  }
  loadPlaylistIndex(nx);
}

    /** Goes to previous playlist entry (with loop handling). */
function prevInPlaylist(){
  if (!Array.isArray(playlist) || playlist.length === 0) return;
  if (playlist.length === 1){ loadPlaylistIndex(0); return; }
  let nx = currentIndex - 1;
  if (nx < 0){
    if (loopChk.checked){ nx = playlist.length - 1; } else { loadPlaylistIndex(currentIndex); return; }
  }
  loadPlaylistIndex(nx);
}

    /** Handles webcam toggle and safe texture creation. */
webcamBtn.addEventListener('click', async ()=>{
  await beginFrom('webcam');
  if (source.type !== "webcam"){
    autoAdvance = false;
    try{
      await ensureAudioCtx();
      destroyABR(); disconnectAudio(); clearVideoFile(); clearImage(); clearAudio(); stopWebcam();

      const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:"user" }, audio:true });
      const video = getOrCreateVideo();
      video.muted = true;
      video.srcObject = stream;
      await awaitCanPlay(video);
      await tryPlay(video);

      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;

      source.type = "webcam";
      source.stream = stream;
      setTexture(tex);
      connectStreamAudio(stream);
      webcamBtn.textContent = "Webcam: ON";
    }catch(e){
      console.error("[Webcam] blocked/error", e);
      webcamBtn.textContent = "Webcam blocked";
    }
  } else {
    clearSource();
  }
});


    /** Handles local image selection to texture. */
imgInput.addEventListener('change', async e=>{
  await beginFrom('image');
  const file = e.target.files?.[0]; if(!file) return;
  autoAdvance = false;

  destroyABR(); stopWebcam(); disconnectAudio(); clearAudio(); clearVideoFile(); clearImage();

  const url = URL.createObjectURL(file);
  const img = new Image(); img.crossOrigin="anonymous";
  img.onload = ()=>{
    const tex = new THREE.Texture(img);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    source.type = "image";
    source.imageEl = img;
    setTexture(tex);
  };
  img.onerror = (err)=>{ console.error("[Image] load error", err); };
  img.src = url;
});


    /** Handles local video selection with audio graph hookup. */
vidInput.addEventListener
    /** Handles local audio selection; builds spectrum texture and uses it for the blob. */
audioInput.addEventListener('change', async e=>{
  const file = e.target.files?.[0]; if(!file) return;
  autoAdvance = false;
  await ensureAudioCtx();
  if (audioCtx.state === "suspended"){ try{ await audioCtx.resume(); }catch(e){} }

  // clear first, then build spectrum
  destroyABR(); stopWebcam(); clearVideoFile(); clearImage(); clearAudio(); disconnectAudio(); setTexture(null);

  const url = URL.createObjectURL(file);
  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.autoplay = true;
  audio.loop = false;
  audio.src = url;
  const ok = await tryPlay(audio);
  if (!ok){ console.error("[Audio] play failed"); return; }

  connectAudioEl(audio);

  // now create the spectrum canvas + texture
  const tex = buildSpectrumTexture(256,256);

  source.type = "audio";
  source.audioEl = audio;
  setTexture(tex);
});


    /** Clears any active media source. */
clearBtn.addEventListener('click', ()=>{ clearSource(); });

    /** Starts audio + current playlist entry. */
startBtn.addEventListener('click', async ()=>{
  await beginFrom('start');
  await ensureAudioCtx();
  if (audioCtx && audioCtx.state === "suspended"){ try{ await audioCtx.resume(); }catch(e){} }
  autoAdvance = true;
  if (playlist.length) loadPlaylistIndex(currentIndex);
});

prevBtn.addEventListener('click', async () => {
  await beginFrom('prev');
  prevInPlaylist();
});

nextBtn.addEventListener('click', async () => {
  await beginFrom('next');
  nextInPlaylist();
});


playlistSelect.addEventListener('change', async ()=>{
  await beginFrom('playlist'); 
  const ix = parseInt(playlistSelect.value,10);
  loadPlaylistIndex(ix);
});


    /** Shared shader uniforms. */
const shared = {
  uTime: { value: 0 },
  uLightDir: { value: new THREE.Vector3(0.5, 0.9, 0.3).normalize() },
  uSaturation: { value: 1.0 }
};





    /** Blob material (solid/wire). */
const satGLSL = `vec3 sat(vec3 c, float s){ float l = dot(c, vec3(0.2126,0.7152,0.0722)); return mix(vec3(l), c, s); }`;

/* Rotating rainbow used when no source/texture is active. */
const rainbowGLSL = `
  const float PI = 3.141592653589793;
  vec3 h2rgb(float h){
    vec3 k = vec3(0.0, 4.0, 2.0);
    return clamp(abs(mod(h*6.0 + k, 6.0) - 3.0) - 1.0, 0.0, 1.0);
  }
  vec3 rainbowByAngle(float ang, float rot){
    float h = fract((ang + rot) / (2.0*PI));
    return h2rgb(h);
  }
`;

const sphereVert = `
      uniform float uTime,uAmp,uFreq,uTexStrength; uniform sampler2D uTex; uniform int uUseTex;
      varying vec3 vNormalW; varying vec3 vPosW; varying vec2 vUvV;
      ${simplexGLSL}
      float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
      void main(){
        vec3 pos = position; vUvV = uv;
        float camDisp = 0.0;
        if(uUseTex==1){ vec2 suv = vec2(1.0 - vUvV.x, vUvV.y); vec3 texel = texture2D(uTex, suv).rgb; camDisp = (0.5 - luma(texel)) * uTexStrength; }
        float n = snoise(normal*uFreq + vec3(0.0,0.0,uTime*0.25));
        float disp = n*(uAmp*0.35) + camDisp*(uAmp*1.35);
        disp = clamp(disp, -uAmp*1.35, uAmp*1.35);
        pos += normal * disp;
        vec4 worldPos = modelMatrix * vec4(pos, 1.0);
        vPosW = worldPos.xyz; vNormalW = normalize(mat3(modelMatrix)*normal);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
`;

const sphereFrag = `
      precision highp float;
      uniform vec3 uColor,uLightDir; uniform sampler2D uTex; uniform int uUseTex; uniform float uSaturation;
      uniform int uRainbowOn; uniform float uRainbowRot;
      varying vec3 vNormalW; varying vec3 vPosW; varying vec2 vUvV;
      ${satGLSL}
      ${rainbowGLSL}
      void main(){
        vec3 baseCol = uColor;
        if(uUseTex==1){
          vec2 suv=vec2(1.0 - vUvV.x, vUvV.y);
          baseCol = texture2D(uTex, suv).rgb;
        }else if(uRainbowOn==1){
          float ang = atan(vNormalW.z, vNormalW.x);
          baseCol = rainbowByAngle(ang, uRainbowRot);
        }
        baseCol = sat(baseCol, uSaturation);
        vec3 N=normalize(vNormalW), L=normalize(uLightDir);
        float lambert = max(dot(N,L),0.0);
        vec3 col = baseCol*(0.18 + 0.82*lambert);
        float fres = pow(1.0 - max(dot(N, normalize(-vPosW)), 0.0), 3.0)*0.22;
        col += fres*vec3(1.0,0.7,0.9);
        gl_FragColor = vec4(col, 1.0);
      }
`;

const sphereMat = new THREE.ShaderMaterial({
  uniforms: {
    ...shared,
    uColor: { value: new THREE.Color(0xff4fbf) },
    uAmp: { value: 0.22 },
    uFreq: { value: 1.2 },
    uTex: { value: null },
    uUseTex: { value: 0 },
    uTexStrength: { value: 1.0 },
    uRainbowOn: { value: 0 },
    uRainbowRot: { value: 0.0 }
  },
  vertexShader: sphereVert,
  fragmentShader: sphereFrag,
  wireframe: false
});

const sphereGeo = new THREE.SphereGeometry(1, 160, 160);
const sphere = new THREE.Mesh(sphereGeo, sphereMat);
sphere.position.y = 1.15;
scene.add(sphere);




    /** Reflector materials (bottom/top). */
    /** Reflector materials (bottom/top). */
const reflectVert = `
      uniform float uTime,uAmp,uFreq,uWobbleAmp,uWobbleFreq,uTexStrength; uniform sampler2D uTex; uniform int uUseTex;
      varying vec3 vPosW; varying vec3 vNormalW; varying vec2 vUvV;
      ${simplexGLSL}
      float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
      void main(){
        vec3 pos = position; vUvV = uv;
        float camDisp = 0.0;
        if(uUseTex==1){ vec2 suv = vec2(1.0 - vUvV.x, vUvV.y); vec3 texel = texture2D(uTex, suv).rgb; camDisp = (0.5 - luma(texel)) * uTexStrength; }
        float n = snoise(normal*uFreq + vec3(0.0,0.0,uTime*0.25));
        float disp = n*(uAmp*0.30) + camDisp*(uAmp*1.10);
        disp = clamp(disp, -uAmp*1.10, uAmp*1.10);
        pos += normal*disp;
        vec4 wp = modelMatrix * vec4(pos,1.0);
        float wob = snoise(vec3(wp.xz*uWobbleFreq, uTime*0.3));
        wp.x += wob*uWobbleAmp; wp.z += wob*uWobbleAmp;
        vPosW=wp.xyz; vNormalW=normalize(mat3(modelMatrix)*normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
`;
const reflectFrag = `
      precision highp float;
      uniform vec3 uColor,uLightDir; uniform float uAlpha,uR,uSoft,uSaturation; uniform sampler2D uTex; uniform int uUseTex;
      uniform int uRainbowOn; uniform float uRainbowRot;
      varying vec3 vPosW; varying vec3 vNormalW; varying vec2 vUvV;
      ${satGLSL}
      ${rainbowGLSL}
      void main(){
        vec3 baseCol=uColor;
        if(uUseTex==1){
          vec2 suv=vec2(1.0 - vUvV.x, vUvV.y);
          baseCol = texture2D(uTex, suv).rgb;
        }else if(uRainbowOn==1){
          float ang = atan(vPosW.z, vPosW.x);
          baseCol = rainbowByAngle(ang, uRainbowRot);
        }
        baseCol = sat(baseCol, uSaturation);
        vec3 N=normalize(vNormalW), L=normalize(uLightDir);
        float lambert=max(dot(N,L),0.0);
        vec3 col = baseCol*(0.10+0.90*lambert);
        float r=length(vPosW.xz), fall=1.0 - smoothstep(uR, uR+uSoft, r);
        gl_FragColor = vec4(col*0.85, uAlpha*fall);
      }
`;
function makeReflectMat(){
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uColor: { value: new THREE.Color(0xff4fbf) },
      uAmp: { value: 0.22 },
      uFreq: { value: 1.2 },
      uWobbleAmp: { value: 0.015 },
      uWobbleFreq: { value: 1.6 },
      uAlpha: { value: 0.55 },
      uR: { value: 1.6 },
      uSoft: { value: 1.0 },
      uTex: { value: null },
      uUseTex: { value: 0 },
      uTexStrength: { value: 1.0 },
      uRainbowOn: { value: 0 },
      uRainbowRot: { value: 0.0 }
    },
    vertexShader: reflectVert,
    fragmentShader: reflectFrag,
    transparent: true,
    depthWrite: true,
    blending: THREE.NormalBlending
  });
}
const reflectMatBottom = makeReflectMat();
const reflectMatTop    = makeReflectMat();
const mirrorBottom = new THREE.Mesh(new THREE.SphereGeometry(1,160,160), reflectMatBottom);
mirrorBottom.position.y=-1.15; mirrorBottom.scale.y=-1; scene.add(mirrorBottom);
const mirrorTop = new THREE.Mesh(new THREE.SphereGeometry(1,160,160), reflectMatTop);
mirrorTop.position.y=3.45; mirrorTop.scale.y=1; scene.add(mirrorTop);






    /** Point-cloud pass for blob. */
const pointsVert = `
      uniform float uTime,uAmp,uFreq,uTexStrength,uPointSize; uniform sampler2D uTex; uniform int uUseTex;
      uniform vec3 uLightDir;
      varying vec3 vNormalW; varying vec3 vPosW; varying vec2 vUvV;
      ${simplexGLSL}
      float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
      void main(){
        vec3 pos = position; vUvV = uv;
        float camDisp = 0.0;
        if(uUseTex==1){ vec2 suv = vec2(1.0 - vUvV.x, vUvV.y); vec3 texel = texture2D(uTex, suv).rgb; camDisp = (0.5 - luma(texel)) * uTexStrength; }
        float n = snoise(normal*uFreq + vec3(0.0,0.0,uTime*0.25));
        float disp = n*(uAmp*0.35) + camDisp*(uAmp*1.35);
        disp = clamp(disp, -uAmp*1.35, uAmp*1.35);
        pos += normal * disp;
        vec4 worldPos = modelMatrix * vec4(pos,1.0);
        vPosW = worldPos.xyz; vNormalW = normalize(mat3(modelMatrix)*normal);
        vec4 mv = viewMatrix * worldPos;
        gl_PointSize = uPointSize * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
`;
const pointsFrag = `
      precision highp float;
      uniform sampler2D uTex; uniform int uUseTex; uniform float uSaturation; uniform vec3 uColor; uniform vec3 uLightDir;
      uniform int uRainbowOn; uniform float uRainbowRot;
      varying vec3 vNormalW; varying vec3 vPosW; varying vec2 vUvV;
      ${satGLSL}
      ${rainbowGLSL}
      void main(){
        vec2 d = gl_PointCoord*2.0 - 1.0; float r = dot(d,d); if(r>1.0) discard;
        vec3 baseCol = uColor;
        if(uUseTex==1){
          vec2 suv=vec2(1.0 - vUvV.x, vUvV.y);
          baseCol = texture2D(uTex, suv).rgb;
        }else if(uRainbowOn==1){
          float ang = atan(vNormalW.z, vNormalW.x);
          baseCol = rainbowByAngle(ang, uRainbowRot);
        }
        baseCol = sat(baseCol, uSaturation);
        vec3 N=normalize(vNormalW), L=normalize(uLightDir);
        float lambert=max(dot(N,L),0.0);
        vec3 col = baseCol*(0.18 + 0.82*lambert);
        gl_FragColor = vec4(col,1.0);
      }
`;
const spherePointsMat = new THREE.ShaderMaterial({
  uniforms: {
    ...shared,
    uColor: { value: new THREE.Color(0xff4fbf) },
    uAmp: { value: 0.22 },
    uFreq: { value: 1.2 },
    uTex: { value: null },
    uUseTex: { value: 0 },
    uTexStrength: { value: 1.0 },
    uPointSize: { value: 2.2 },
    uRainbowOn: { value: 0 },
    uRainbowRot: { value: 0.0 }
  },
  vertexShader: pointsVert,
  fragmentShader: pointsFrag,
  transparent: true,
  depthWrite: false
});
const spherePoints = new THREE.Points(new THREE.SphereGeometry(1,160,160), spherePointsMat);
spherePoints.position.y = 1.15; spherePoints.visible=false; scene.add(spherePoints);





    /** Spectrum geometry (points + line). */
const BIN_COUNT = 128;
const specGeo = new THREE.BufferGeometry();
const specPos = new Float32Array(BIN_COUNT * 3);
const specCol = new Float32Array(BIN_COUNT * 3);
for (let i=0;i<BIN_COUNT;i++){
  const a=(i/BIN_COUNT)*Math.PI*2;
  specPos[i*3+0]=Math.cos(a)*2.0; specPos[i*3+1]=1.15; specPos[i*3+2]=Math.sin(a)*2.0;
  specCol[i*3+0]=1; specCol[i*3+1]=1; specCol[i*3+2]=1;
}
specGeo.setAttribute('position', new THREE.BufferAttribute(specPos,3));
specGeo.setAttribute('aColor', new THREE.BufferAttribute(specCol,3));
const specMat = new THREE.ShaderMaterial({
  uniforms:{ uSize:{value:10.0}, uShape:{value:0} },
  vertexShader:`uniform float uSize; attribute vec3 aColor; varying vec3 vColor; void main(){ vColor=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=uSize*(300.0/-mv.z); gl_Position=projectionMatrix*mv; }`,
  fragmentShader:`precision highp float; varying vec3 vColor; uniform int uShape;
        float sdEquilateralTri(vec2 p){ const float k=1.7320508075688772; p.x=abs(p.x)-0.5; p.y=p.y+0.28867513459481287;
          if(p.x+k*p.y>0.0) p=vec2(p.x-k*p.y,-k*p.x-p.y)/2.0; p.x-=clamp(p.x,-1.0,0.0); return -length(p)*sign(p.y); }
        float sdCross(vec2 p){ p=abs(p); float w=0.3; float d1=max(p.x-w,p.y-1.0); float d2=max(p.y-w,p.x-1.0); return min(d1,d2); }
        void main(){
          vec2 uv=gl_PointCoord*2.0-1.0; float a=0.0;
          if(uShape==0){ float r=dot(uv,uv); if(r>1.0) discard; a=smoothstep(1.0,0.7,r); }
          else if(uShape==1){ float m=max(abs(uv.x),abs(uv.y)); if(m>1.0) discard; a=smoothstep(1.0,0.7,m); }
          else if(uShape==2){ float d=sdEquilateralTri(uv); if(d>0.0) discard; a=smoothstep(0.0,-0.3,d); }
          else { float d=sdCross(uv); if(d>0.0) discard; a=smoothstep(0.0,-0.3,d); }
          gl_FragColor=vec4(vColor,a);
}`,
transparent:true, depthWrite:false
});
const spectrumPoints = new THREE.Points(specGeo, specMat); spectrumPoints.visible=false; scene.add(spectrumPoints);

    /** Spectrum line loop. */
const specGeoLine = new THREE.BufferGeometry();
const specPosLine = new Float32Array(BIN_COUNT * 3);
const specColLine = new Float32Array(BIN_COUNT * 3);
specGeoLine.setAttribute('position', new THREE.BufferAttribute(specPosLine,3));
specGeoLine.setAttribute('color', new THREE.BufferAttribute(specColLine,3));
const specLineMat = new THREE.LineBasicMaterial({ linewidth:1, vertexColors:true, transparent:true, opacity:1.0 });
const spectrumLine = new THREE.LineLoop(specGeoLine, specLineMat); spectrumLine.visible=false; scene.add(spectrumLine);

    /** Utility: HSL to RGB (0..1). */
function hslToRgb(h,s,l){ h=((h%1)+1)%1; const a=s*Math.min(l,1-l); const f=n=>{ const k=(n+h*12.0); const m=k-Math.floor(k/12.0)*12.0; return l-a*Math.max(-1.0, Math.min(m-3.0, 9.0-m, 1.0)); }; return [f(0),f(8),f(4)]; }





const particlesParent = new THREE.Group(); scene.add(particlesParent);


let pointsField = null, pGeo = null, pMat = null, P_COUNT = 600;
let vel = null;


// single active lock + hover + picking buffers
let lockedId = -1;
let hoveredId = -1;

const mousePx = { x:-1, y:-1 };
const readBuf = new Uint8Array(4);

// picking scene/rt
let pickScene = null;
let pickPoints = null;
let pickMat = null;
let pickTarget = null;



/** Pointer→world: intersect the view ray with a horizontal plane at Y.
 *  Returns a shared vector; copy if you need to keep it.
 */
const __ndc = new THREE.Vector2();
const __raycaster = new THREE.Raycaster();
const __planeY = new THREE.Plane();
const __hitY = new THREE.Vector3();

function pointerWorldAtY(clientX, clientY, y){
  const d = renderer.domElement;
  const rect = d.getBoundingClientRect();
  __ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  __ndc.y = -((clientY - rect.top)  / rect.height) * 2 + 1;

  __raycaster.setFromCamera(__ndc, camera);
  __planeY.set(new THREE.Vector3(0,1,0), -y);  // plane: y = constant
  __raycaster.ray.intersectPlane(__planeY, __hitY);
  return __hitY; // note: reused each call
}




/** Creates/refreshes the offscreen picking render target to match the canvas. */
function buildPickTarget(){
  if (pickTarget) pickTarget.dispose();
  const w = renderer.domElement.width;
  const h = renderer.domElement.height;
  pickTarget = new THREE.WebGLRenderTarget(w, h, { depthBuffer:false, stencilBuffer:false });
}






// -- picking + simulation ---------------------------------------------------

/** pickParticleUnderMouse()
 *  Renders ids to RT and reads back id under the pointer.
 *  Updates hoveredId (logs changes).
 */
/** GPU-picks the particle under the mouse and updates hoveredId. */
function pickParticleUnderMouse(){
  if (!pickScene || !pointsField || !pickTarget) return;
  if (mousePx.x < 0 || mousePx.y < 0) return;

  const dom = renderer.domElement;
  const x = Math.max(0, Math.min(dom.width  - 1, mousePx.x));
  const y = Math.max(0, Math.min(dom.height - 1, dom.height - 1 - mousePx.y)); // GL y-flip

  const oldTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(pickTarget);
  renderer.clear();
  renderer.render(pickScene, camera);
  renderer.readRenderTargetPixels(pickTarget, x, y, 1, 1, readBuf);
  renderer.setRenderTarget(oldTarget);

  const id = (readBuf[0] << 16) | (readBuf[1] << 8) | readBuf[2];
  const nextId = (id >= 0 && id < P_COUNT) ? id : -1;

  if (nextId !== hoveredId){
    hoveredId = nextId;
    if (hoveredId !== -1) console.log('[particle:hover]', hoveredId);
  }
}




/** particlesOnResize()
 *  Keep picking RT in sync with canvas size.
 */
/** Keeps the picking target in sync with canvas size. */
function particlesOnResize(){ buildPickTarget(); }



/** particlesOnFrame(dt)
 *  Orbit/swirl motion. If a particle is locked, it follows the pointer plane
 *  (inertia). Shader uniform uHoverId is set to lockedId for size boost.
 */
/** Per-frame particle motion; single locked particle follows pointer plane. */
let lockUntil = 0;




// -- pointer wiring ---------------------------------------------------------

// Description: track pointer pixels for GPU picking and plane targeting.
/** Pointer tracking + single-lock interaction. */
// Pointer tracking (single source of truth)
// const mousePx = { x:-1, y:-1, clientX:0, clientY:0 };

renderer.domElement.addEventListener('mousemove', (e)=>{
  const rect = renderer.domElement.getBoundingClientRect();
  mousePx.x = Math.floor((e.clientX - rect.left) * (renderer.domElement.width  / rect.width));
  mousePx.y = Math.floor((e.clientY - rect.top)  * (renderer.domElement.height / rect.height));
  mousePx.clientX = e.clientX;
  mousePx.clientY = e.clientY;
});
renderer.domElement.addEventListener('mouseleave', ()=>{
  mousePx.x = mousePx.y = -1;
});



renderer.domElement.addEventListener('mouseleave', ()=>{
  mousePx.x = mousePx.y = -1;
  mousePx.clientX = mousePx.clientY = undefined;
}, { passive:true });

renderer.domElement.addEventListener('pointerdown', ()=>{
  if (lockedId !== -1) return;        // only one at a time
  if (hoveredId >= 0){ lockedId = hoveredId; console.log('[particle:lock]', lockedId); }
});

renderer.domElement.addEventListener('dblclick', ()=>{
  if (hoveredId === lockedId && lockedId !== -1){
    console.log('[particle:release]', lockedId);
    lockedId = -1;
  }
}, { passive:true });




// --- Attractor System (modular, N orbiting dots + lines from center) ---
// Description: Manages any number of orbiting "attractors" (a small dot and a
// line from scene center). Each attractor gently pulls nearby ambient particles.
// API:
//   const h = addAttractor(options);
//   removeAttractor(h);
//   clearAttractors();
//   updateAttractors(dt);
// Default: call initDefaultAttractors() once to spawn a single blue attractor.

const ATTRACTORS = [];

/** addAttractor(opts)
 *  Creates one attractor (dot + line) with motion + influence settings.
 *  Returns a handle to later remove.
 *  opts: {
 *    color: 0xRRGGBB,    dotSize: number,
 *    speed: radPerSec,   rX: number, rZ: number,
 *    yBase: number,      yAmp: number,
 *    radius: number,     strength: number, dampingToward: number,
 *    phase: number
 *  }
 */
function addAttractor(opts={}){
  const p = {
    color:        0x4da3ff,
    dotSize:      0.035,
    speed:        0.55,
    rX:           2.0,
    rZ:           1.3,
    yBase:        1.15,
    yAmp:         0.35,
    radius:       0.9,
    strength:     9.0,
    dampingToward:2.5,
    phase:        Math.random()*Math.PI*2
  };
  Object.assign(p, opts);

  const group = new THREE.Group();

  const dotGeo = new THREE.SphereGeometry(p.dotSize, 16, 16);
  const dotMat = new THREE.MeshBasicMaterial({ color: p.color });
  const dot    = new THREE.Mesh(dotGeo, dotMat);
  group.add(dot);

  const lineGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(6); // 2 points
  lineGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: p.color, transparent:true, opacity:0.95 });
  const line    = new THREE.Line(lineGeo, lineMat);
  group.add(line);

  scene.add(group);

  const handle = { group, dot, line, params:p, t: p.phase };
  ATTRACTORS.push(handle);
  return handle;
}

/** removeAttractor(handle)
 *  Disposes meshes and removes from scene.
 */
function removeAttractor(h){
  const i = ATTRACTORS.indexOf(h);
  if (i === -1) return;
  scene.remove(h.group);
  h.dot.geometry.dispose(); h.dot.material.dispose();
  h.line.geometry.dispose(); h.line.material.dispose();
  ATTRACTORS.splice(i,1);
}

/** clearAttractors()
 *  Removes all attractors.
 */
function clearAttractors(){
  while (ATTRACTORS.length) removeAttractor(ATTRACTORS[0]);
}

/** updateAttractors(dt)
 *  Animates each attractor (ellipse + bob), updates its line, and applies
 *  a smooth radial pull to particles within its radius.
 */
function updateAttractors(dt){
  if (!ATTRACTORS.length) return;

  // fast outs
  if (!pGeo || !vel) return;

  const posAttr = pGeo.getAttribute('position');

  for (let a=0; a<ATTRACTORS.length; a++){
    const A = ATTRACTORS[a];
    const p = A.params;

    // 1) animate orbit + bob
    A.t += dt * p.speed;
    const x = Math.cos(A.t) * p.rX;
    const z = Math.sin(A.t * 0.97) * p.rZ;
    const y = p.yBase + Math.sin(A.t * 0.63) * p.yAmp;
    A.dot.position.set(x,y,z);

    // 2) update line (center -> dot)
    const linePos = A.line.geometry.getAttribute('position');
    linePos.setXYZ(0, 0,0,0);
    linePos.setXYZ(1, x,y,z);
    linePos.needsUpdate = true;

    // 3) influence particles
    const R2 = p.radius * p.radius;
    const arr = posAttr.array;

    for (let i=0;i<P_COUNT;i++){
      const ix = i*3;
      const dx = x - arr[ix+0];
      const dy = y - arr[ix+1];
      const dz = z - arr[ix+2];
      const d2 = dx*dx + dy*dy + dz*dz;
      if (d2 > R2) continue;

      const fall = 1.0 - (d2 / R2);               // smooth falloff 0..1
      const k    = p.strength * fall;             // pull
      const damp = p.dampingToward;               // extra damping

      vel[ix+0] += (dx * k - vel[ix+0]*damp) * dt;
      vel[ix+1] += (dy * k - vel[ix+1]*damp) * dt * 0.40; // keep ring feel
      vel[ix+2] += (dz * k - vel[ix+2]*damp) * dt;
    }
  }
}

/* ============================================================================
 * DEFAULT ATTRACTOR HANDLE + initDefaultAttractors (drop-in replacement)
 * Purpose: create and store the blue default attractor so camera mode 1 can follow it. :contentReference[oaicite:0]{index=0}
 * ========================================================================== */
let DEFAULT_ATTRACTOR = null;

function initDefaultAttractors(){
  clearAttractors();
  DEFAULT_ATTRACTOR = addAttractor({
    color: 0x4da3ff,
    dotSize: 0.035,
    speed: 0.55,
    rX: 2.0,
    rZ: 1.3,
    yBase: 1.15,
    yAmp: 0.35,
    radius: 0.9,
    strength: 9.0,
    dampingToward: 2.5
  });
}





// 
initDefaultAttractors();



addAttractor({ 
  color: 0x000000, 
  dotSize: 0.5, 
  speed: 0.01, 
  rX: 3.6, 
  rZ: 1.0, 
  yAmp: 0.25, 
  radius: 2,
  strength: 20 
});




/* ============================================================================
 * AmbientFlow v2
 * Flying emitter + ambient particles with configurable randomness, seed, life.
 *
 * WHAT THIS MODULE DOES
 * - Spawns ambient particles from a red emitter that orbits the stage.
 * - Particles inherit jitter/kick, swirl under existing forces, expire, return.
 * - Fully configurable: emission rate, jitter, kick, lifetime range, orbit path.
 * - Optional deterministic randomness via seed (stable playback & debugging).
 *
 * DEPENDENCIES PROVIDED BY HOST APP (already exist in your codebase)
 *   THREE, particlesParent, pointsField, pGeo, pMat, vel, P_COUNT, playlist,
 *   renderer, camera, pointerWorldAtY, mousePx, params.
 *
 * PUBLIC API (copy/paste this module once; call AmbientFlow.configure(...) as needed)
 *   AmbientFlow.configure(opts)  -> merge config (see CONFIG BLOCK below)
 *   AmbientFlow.setSeed(seed)    -> set deterministic seed; null = use Math.random
 *   AmbientFlow.createEmitter()  -> internal; called by buildParticles(...)
 *   AmbientFlow.updateEmitter(dt)
 *   AmbientFlow.spawnLoop(dt)
 *   AmbientFlow.state            -> internal state (mesh, life, ttl, etc.)
 * ========================================================================== */

const AmbientFlow = (() => {
  // ------------------------ CONFIG BLOCK (EDIT AS NEEDED) ------------------------
  const cfg = {
    // Emission
    emitRate: 3335,            // particles per second
    lifeMin: 20.0,            // seconds (min lifetime)
    lifeMax: 6.0,            // seconds (max lifetime)
    recycleRadius2: 0.05*0.05, // squared distance to consider "returned" to source

    // Spawn jitter & initial velocity
    spawnJitter: 0.02,       // meters; random +/- around emitter
    kickSpeed: 0.35,         // base outward horizontal impulse
    kickY: 0.10,             // vertical kick amplitude
    kickSpread: 1.0,         // multiplier for random deviation (1.0 = default)

    // Emitter orbit/path around stage center
    orbit: {
      rBase: 1.2,
      rAmp1: 0.40, rFreq1: 0.50,
      rAmp2: 0.20, rFreq2: 0.93,
      angSpeed: 0.70,
      angOscAmp: 0.30, angOscFreq: 0.25,
      yBase: 1.15,
      yAmp: 0.35, yOsc1: 0.80, yOsc2: 0.30
    },

    // Return-to-source force when lifetime expired
    returnGain: 22.0,
    returnGainY: 0.50,       // vertical factor

    // Swirl/orbit integration (these combine with existing app params)
    swirlYFactor: 0.25,      // reduce Y swirl to keep stage hugging

    // RNG seed (null = non-deterministic / Math.random)
    seed: null
  };

  // ------------------------ INTERNAL STATE (NO GLOBAL LEAKS) ---------------------
  const s = {
    mesh: null,         // THREE.Mesh for red emitter
    t: 0,               // emitter time accumulator
    spawnAcc: 0,        // emission accumulator
    life: null,         // Float32Array life remaining
    ttl:  null,         // Float32Array full lifetime
    spawnIdx: 0,        // rotating index for free slot probing
    rng: null           // function() -> [0,1) depending on seed
    };

  // ------------------------ RNG (DETERMINISTIC WITH SEED) ------------------------
    function mulberry32(seed) {
      let a = (seed >>> 0) || 1;
      return function() {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    function R() { return s.rng ? s.rng() : Math.random(); }
  function RU(a, b) { return a + (b - a) * R(); }         // uniform [a,b)
  function Rpm(scale=1) { return (R() * 2 - 1) * scale; } // [-scale,+scale]

  // ------------------------ PUBLIC: CONFIGURE + SEED -----------------------------
  function configure(overrides = {}) {
    // deep merge minimal (shallow for orbit if provided)
    Object.assign(cfg, overrides);
    if (overrides.orbit) Object.assign(cfg.orbit, overrides.orbit);
  }
  function setSeed(seed) {
    cfg.seed = (seed == null ? null : (seed|0));
    s.rng = (cfg.seed == null ? null : mulberry32(cfg.seed));
  }

  // ------------------------ EMITTER LIFECYCLE ------------------------------------
  function createEmitter() {
    if (s.mesh) return;

    s.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xff3030 })
      );
    s.mesh.position.set(cfg.orbit.yBase * 0.0, cfg.orbit.yBase, 0); // center at start
    particlesParent.add(s.mesh);

    s.life = new Float32Array(P_COUNT);
    s.ttl  = new Float32Array(P_COUNT);
    for (let i = 0; i < P_COUNT; i++) {
      s.ttl[i]  = RU(cfg.lifeMin, cfg.lifeMax);
      s.life[i] = RU(0, s.ttl[i]); // stagger
    }

    setSeed(cfg.seed); // initialize rng
    console.log('[AmbientFlow] emitter initialized', { seed: cfg.seed });
  }

  function updateEmitter(dt) {
    s.t += dt;
    const o = cfg.orbit;
    const Rm = o.rBase + o.rAmp1 * Math.sin(s.t * o.rFreq1) + o.rAmp2 * Math.sin(s.t * o.rFreq2);
    const ang = s.t * o.angSpeed + o.angOscAmp * Math.sin(s.t * o.angOscFreq);
    const y   = o.yBase + o.yAmp * Math.sin(s.t * o.yOsc1) * Math.cos(s.t * o.yOsc2);
    s.mesh.position.set(Math.cos(ang) * Rm, y, Math.sin(ang) * Rm);
  }

  // ------------------------ PARTICLE RESPAWN AT EMITTER --------------------------
  function respawnParticle(i) {
    const pos  = pGeo.getAttribute('position');
    const seedAttr = pGeo.getAttribute('seed');

    // Position: emitter + jitter
    const j = cfg.spawnJitter;
    const ex = s.mesh.position.x + Rpm(j);
    const ey = s.mesh.position.y + Rpm(j);
    const ez = s.mesh.position.z + Rpm(j);

    pos.array[i*3+0] = ex;
    pos.array[i*3+1] = ey;
    pos.array[i*3+2] = ez;

    // Initial velocity: planar push outward with spread + small vertical kick
    const dirx = Rpm(cfg.kickSpread);
    const dirz = Rpm(cfg.kickSpread);
    const nrm = Math.max(1e-4, Math.hypot(dirx, dirz));
    vel[i*3+0] = (dirx / nrm) * cfg.kickSpeed;
    vel[i*3+1] = cfg.kickY * Rpm(1);
    vel[i*3+2] = (dirz / nrm) * cfg.kickSpeed;

    // Seed: [radius, angular speed, phase] to join ambient swirl
    const r  = Math.hypot(ex, ez);
    const th = Math.atan2(ez, ex);
    seedAttr.setX(i, Math.max(0.8, r));
    seedAttr.setY(i, 0.20 + R() * 0.25);
    seedAttr.setZ(i, th);

    // Lifetime
    s.ttl[i]  = RU(cfg.lifeMin, cfg.lifeMax);
    s.life[i] = s.ttl[i];
  }

  // ------------------------ EMISSION LOOP (RECYCLE EXPIRED) ----------------------
  function spawnLoop(dt) {
    s.spawnAcc += dt * cfg.emitRate;
    let guard = 0;
    while (s.spawnAcc >= 1 && guard++ < P_COUNT) {
      let i = s.spawnIdx++ % P_COUNT;
      let tries = 0;
      while (s.life[i] > 0 && tries++ < Math.min(P_COUNT, 64)) {
        i = (s.spawnIdx++ % P_COUNT);
      }
      if (s.life[i] <= 0) respawnParticle(i);
      s.spawnAcc -= 1;
    }
  }

  return { configure, setSeed, createEmitter, updateEmitter, respawnParticle, spawnLoop, state: s, config: cfg };
})();

/* ============================================================================
 * buildParticles(count): Build geometry/material & prime lifecycle (unchanged API)
 * ========================================================================== */
function buildParticles(count) {
  if (pointsField) {
    particlesParent.remove(pointsField);
    pGeo?.dispose();
    pMat?.dispose();
  }

  P_COUNT = Math.max(count | 0, Array.isArray(playlist) ? playlist.length : 0);

  pGeo = new THREE.BufferGeometry();

  const positions = new Float32Array(P_COUNT * 3);
  const seeds     = new Float32Array(P_COUNT * 3);   // r, speed, phase
  const aSize     = new Float32Array(P_COUNT);
  const aBoost    = new Float32Array(P_COUNT);
  const aTint     = new Float32Array(P_COUNT * 3);
  const aBaseTint = new Float32Array(P_COUNT * 3);

  vel = new Float32Array(P_COUNT * 3);

  for (let i = 0; i < P_COUNT; i++) {
    const r  = 1.8 + Math.random() * 1.2;
    const th = Math.random() * Math.PI * 2;
    const y  = 1.15 + (Math.random() * 0.6 - 0.3);

    positions[i*3+0] = Math.cos(th) * r;
    positions[i*3+1] = y;
    positions[i*3+2] = Math.sin(th) * r;

    seeds[i*3+0] = r;
    seeds[i*3+1] = 0.20 + Math.random() * 0.25;
    seeds[i*3+2] = th;

    vel[i*3+0] = vel[i*3+1] = vel[i*3+2] = 0;

    aSize[i]  = 0.010;
    aBoost[i] = 10.0;

    if (i < (playlist?.length || 0)) {
      const hue = (i / Math.max(1, playlist.length));
      const c = new THREE.Color().setHSL(hue, 0.9, 0.6);
      aBaseTint[i*3+0] = c.r; aBaseTint[i*3+1] = c.g; aBaseTint[i*3+2] = c.b;
    } else {
      aBaseTint[i*3+0] = 1; aBaseTint[i*3+1] = 1; aBaseTint[i*3+2] = 1;
    }
    aTint[i*3+0] = aBaseTint[i*3+0];
    aTint[i*3+1] = aBaseTint[i*3+1];
    aTint[i*3+2] = aBaseTint[i*3+2];
  }

  pGeo.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
  pGeo.setAttribute('seed',      new THREE.BufferAttribute(seeds,     3));
  pGeo.setAttribute('aSize',     new THREE.BufferAttribute(aSize,     1));
  pGeo.setAttribute('aBoost',    new THREE.BufferAttribute(aBoost,    1));
  pGeo.setAttribute('aTint',     new THREE.BufferAttribute(aTint,     3));
  pGeo.setAttribute('aBaseTint', new THREE.BufferAttribute(aBaseTint, 3));

  const vsh = `
    uniform float uPointSizePx;
    attribute float aSize;
    attribute float aBoost;
    attribute vec3  aTint;
    varying vec3  vTint;
    void main(){
      vTint = aTint;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = (aSize * aBoost) * (300.0 / -mv.z) + uPointSizePx;
      gl_Position  = projectionMatrix * mv;
    }
  `;
  const fsh = `
    precision highp float;
    varying vec3  vTint;
    void main(){
      vec2 d = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(d,d);
      if (r2 > 1.0) discard;
      float a = smoothstep(1.0, 0.7, r2);
      gl_FragColor = vec4(vTint, a);
    }
  `;
  pMat = new THREE.ShaderMaterial({
    uniforms: { uPointSizePx: { value: 0.0 } },
    vertexShader: vsh,
    fragmentShader: fsh,
    transparent: true,
    depthWrite: false
  });

  pointsField = new THREE.Points(pGeo, pMat);
  particlesParent.add(pointsField);

  AmbientFlow.createEmitter();
}

/* ============================================================================
 * particlesOnFrame(dt): frame update (emitter path, spawn, forces, lifecycle)
 * ========================================================================== */
function particlesOnFrame(dt) {
  if (!pGeo || !pMat || !renderer || !camera) return;

  AmbientFlow.createEmitter();
  AmbientFlow.updateEmitter(dt);
  AmbientFlow.spawnLoop(dt);

  const pos   = pGeo.getAttribute('position');
  const seed  = pGeo.getAttribute('seed');
  const boost = pGeo.getAttribute('aBoost');
  const tint  = pGeo.getAttribute('aTint');
  const base  = pGeo.getAttribute('aBaseTint');

  const vpW = renderer.domElement.width;
  const vpH = renderer.domElement.height;

  const baseSpeed = params?.particleSpeedScale ?? 0.9;
  const swirl     = params?.particleSwirl ?? 0.5;
  const damping   = params?.particleDamping ?? 0.9;

  const Rpx       = 80;
  const pullK     = 16.0;
  const pullDamp  = 4.0;
  const boostMax  = 100.0;
  const boostUp   = 6.0;
  const boostDn   = 3.0;
  const tintUp    = 6.0;
  const tintDn    = 3.0;
  const hiTint    = new THREE.Color(1.0, 0.95, 0.2);

  const hasMouse  = mousePx && mousePx.x >= 0 && mousePx.y >= 0;
  const mClientX  = hasMouse ? mousePx.clientX : 0;
  const mClientY  = hasMouse ? mousePx.clientY : 0;

  const center = new THREE.Vector3(0, 1.15, 0);
  const up     = new THREE.Vector3(0, 1, 0);
  const wv     = new THREE.Vector3();
  const ndc    = new THREE.Vector3();
  const tang   = new THREE.Vector3();

  // baseline orbital + per-particle phase swirl
  for (let i = 0; i < P_COUNT; i++) {
    const ix = i * 3;
    const ph = seed.getZ(i) + dt * seed.getY(i) * baseSpeed;
    seed.setZ(i, ph);

    const px = pos.array[ix], py = pos.array[ix + 1], pz = pos.array[ix + 2];
    wv.set(px, py, pz).sub(center);
    const r = wv.length();
    if (r > 1e-4) {
      const n = wv.multiplyScalar(1.0 / r);
      tang.crossVectors(n, up).normalize();
      vel[ix]   += tang.x * swirl * dt;
      vel[ix+1] += tang.y * swirl * dt * AmbientFlow.config.swirlYFactor;
      vel[ix+2] += tang.z * swirl * dt;

      vel[ix]   += Math.cos(ph * 1.3) * 0.08 * dt;
      vel[ix+2] += Math.sin(ph * 1.1) * 0.08 * dt;
    }
  }

  // pointer interaction (visual + positional pull)
  if (hasMouse) {
    for (let i = 0; i < P_COUNT; i++) {
      const ix = i * 3;
      const wx = pos.array[ix], wy = pos.array[ix + 1], wz = pos.array[ix + 2];

      ndc.set(wx, wy, wz).project(camera);
      const sx = (ndc.x * 0.5 + 0.5) * vpW;
      const sy = (ndc.y * 0.5 + 0.5) * vpH;
      const dx = sx - mousePx.x;
      const dy = sy - mousePx.y;
      const within = (dx*dx + dy*dy) <= (Rpx*Rpx);

      if (within) {
        boost.array[i] = Math.min(boostMax, boost.array[i] + boostUp * dt);
        tint.array[ix+0] += (hiTint.r - tint.array[ix+0]) * Math.min(1.0, tintUp * dt);
        tint.array[ix+1] += (hiTint.g - tint.array[ix+1]) * Math.min(1.0, tintUp * dt);
        tint.array[ix+2] += (hiTint.b - tint.array[ix+2]) * Math.min(1.0, tintUp * dt);

        const target = pointerWorldAtY(mClientX, mClientY, wy);
        const fx = (target.x - wx) * pullK - vel[ix]   * pullDamp;
        const fz = (target.z - wz) * pullK - vel[ix+2] * pullDamp;
        vel[ix]   += fx * dt;
        vel[ix+2] += fz * dt;
      } else {
        boost.array[i] = Math.max(1.0, boost.array[i] - boostDn * dt);
        tint.array[ix+0] += (base.array[ix+0] - tint.array[ix+0]) * Math.min(1.0, tintDn * dt);
        tint.array[ix+1] += (base.array[ix+1] - tint.array[ix+1]) * Math.min(1.0, tintDn * dt);
        tint.array[ix+2] += (base.array[ix+2] - tint.array[ix+2]) * Math.min(1.0, tintDn * dt);
      }
    }
  } else {
    for (let i = 0; i < P_COUNT; i++) {
      const ix = i * 3;
      boost.array[i] = Math.max(1.0, boost.array[i] - 2.0 * dt);
      tint.array[ix+0] += (base.array[ix+0] - tint.array[ix+0]) * Math.min(1.0, 2.0 * dt);
      tint.array[ix+1] += (base.array[ix+1] - tint.array[ix+1]) * Math.min(1.0, 2.0 * dt);
      tint.array[ix+2] += (base.array[ix+2] - tint.array[ix+2]) * Math.min(1.0, 2.0 * dt);
    }
  }

  // lifetime → return-to-source → recycle near emitter
  const src = AmbientFlow.state.mesh.position;
  const gain = AmbientFlow.config.returnGain;
  const gainY = AmbientFlow.config.returnGainY;
  const rr2 = AmbientFlow.config.recycleRadius2;

  for (let i = 0; i < P_COUNT; i++) {
    AmbientFlow.state.life[i] -= dt;
    if (AmbientFlow.state.life[i] <= 0) {
      const ix = i * 3;
      const wx = pos.array[ix], wy = pos.array[ix+1], wz = pos.array[ix+2];
      const dx = src.x - wx, dy = src.y - wy, dz = src.z - wz;

      vel[ix]   += dx * gain * dt;
      vel[ix+1] += dy * gain * gainY * dt;
      vel[ix+2] += dz * gain * dt;

      if ((dx*dx + dy*dy + dz*dz) < rr2) {
        AmbientFlow.state.life[i] = 0; // eligible for spawnLoop recycle
      }
    }
  }

  // integrate + damping
  for (let i = 0; i < P_COUNT; i++) {
    const ix = i * 3;
    pos.array[ix]   += vel[ix]   * dt;
    pos.array[ix+1] += vel[ix+1] * dt;
    pos.array[ix+2] += vel[ix+2] * dt;
    vel[ix]   *= damping; vel[ix+1] *= damping; vel[ix+2] *= damping;
  }

  pos.needsUpdate   = true;
  seed.needsUpdate  = true;
  boost.needsUpdate = true;
  tint.needsUpdate  = true;

  if (pMat.uniforms && pMat.uniforms.uPointSizePx) {
    pMat.uniforms.uPointSizePx.value = 0.0;
  }
}

/* ============================================================================
 * OPTIONAL: one-time configuration examples (safe to delete after reading)
 *   AmbientFlow.configure({ emitRate: 60, lifeMin: 1.5, lifeMax: 5.0, seed: 1234 });
 *   AmbientFlow.configure({ orbit: { rBase: 1.5, angSpeed: 0.9 } });
 *   AmbientFlow.setSeed(42);
 * ========================================================================== */








buildParticles(P_COUNT)














/** GUI parameter model and bindings. */

    /** GUI parameter model and bindings. */
const params = {
  renderMode:"solid", saturation:1.0,
  pointSize:2.2, pcAudioReact:true, pcReactAmount:0.8,
  rotationSpeed:0.25, displacement_amp:0.22, noise_freq:1.2, tex_strength:1.0,
  reflection_alpha:0.55, pool_radius:1.6, pool_softness:1.2, wobble_amp:0.015, wobble_freq:1.6,
  top_reflection_alpha:0.35, top_pool_radius:1.4, top_pool_softness:0.9,
  particles:P_COUNT, particleSpeedScale:0.9, particlePushStrength:5.0, particleMargin:0.08, particleDamping:0.9, particleSwirl:0.5,
  spectrumMode:"points", spectrumSize:10.0, spectrumRadius:2.0, spectrumHeight:0.9, spectrumGain:1.0, spectrumHueShift:0.0,
  spectrumShape:"circle",
  autoShowBands:true, showThreshold:0.04, showSmoothing:0.85,

  /* ---- Starfield (persisted) ---- */
  star_count:       20000,
  star_radius:      150,
  star_thickness:   50,
  star_color:       0xDDE6FF,
  star_size:        1.2,
  star_sizeJitter:  0.8,
  star_opacity:     1.0,

  star_noiseScale:    0.08,
  star_noiseBias:     0.15,
  star_noiseStrength: 0.85,
  star_noiseDisplace: 2.0,

  star_twinkleSpeed:  0.6,
  star_twinkleAmount: 0.35,
  star_driftSpeed:    0.002,
  star_seed:          42,

  star_nebulaEnabled: true,
  star_nebulaAmount:  0.3,
  star_nebulaScale:   0.015,
  star_nebulaBias:    0.5,
  star_nebulaSmooth:  0.2,
  star_nebulaColorA:  0x9FB9FF,
  star_nebulaColorB:  0xFFA6A6,

  star_bgEnabled:    true,
  star_bgScale:      3.0,
  star_bgThreshold:  0.69,
  star_bgFalloff:    0.12,
  star_bgPower:      1.0,
  star_bgVignette:   0.5,
  star_bgColorA:     0x7aa0ff,
  star_bgColorB:     0xff8fa0
};

/* Initialize Starfield params from current Starfield.config (if present). */
(function syncStarfieldParamsFromRuntime(){
  try {
    const c = Starfield?.config;
    if (!c) return;
    params.star_count       = c.count;
    params.star_radius      = c.radius;
    params.star_thickness   = c.thickness;
    params.star_color       = c.color;
    params.star_size        = c.size;
    params.star_sizeJitter  = c.sizeJitter;
    params.star_opacity     = c.opacity;

    params.star_noiseScale    = c.noiseScale;
    params.star_noiseBias     = c.noiseBias;
    params.star_noiseStrength = c.noiseStrength;
    params.star_noiseDisplace = c.noiseDisplace;

    params.star_twinkleSpeed  = c.twinkleSpeed;
    params.star_twinkleAmount = c.twinkleAmount;
    params.star_driftSpeed    = c.driftSpeed;
    params.star_seed          = c.seed;

    params.star_nebulaEnabled = c.nebulaEnabled;
    params.star_nebulaAmount  = c.nebulaAmount;
    params.star_nebulaScale   = c.nebulaScale;
    params.star_nebulaBias    = c.nebulaBias;
    params.star_nebulaSmooth  = c.nebulaSmooth;
    params.star_nebulaColorA  = c.nebulaColorA;
    params.star_nebulaColorB  = c.nebulaColorB;

    params.star_bgEnabled   = c.bgEnabled;
    params.star_bgScale     = c.bgScale;
    params.star_bgThreshold = c.bgThreshold;
    params.star_bgFalloff   = c.bgFalloff;
    params.star_bgPower     = c.bgPower;
    params.star_bgVignette  = c.bgVignette;
    params.star_bgColorA    = c.bgColorA;
    params.star_bgColorB    = c.bgColorB;
  } catch(_) {}
})();

/* Applies model changes to Starfield when params change (GUI/programmatic). */
function applyParamSideEffects(name, value){
  if (!/^star_/.test(name)) return;

  const patch = {};
  switch (name) {
  case 'star_count':        patch.count = value|0; break;
  case 'star_radius':       patch.radius = +value; break;
  case 'star_thickness':    patch.thickness = +value; break;
  case 'star_color':        patch.color = value; break;
  case 'star_size':         patch.size = +value; break;
  case 'star_sizeJitter':   patch.sizeJitter = +value; break;
  case 'star_opacity':      patch.opacity = +value; break;

  case 'star_noiseScale':    patch.noiseScale = +value; break;
  case 'star_noiseBias':     patch.noiseBias = +value; break;
  case 'star_noiseStrength': patch.noiseStrength = +value; break;
  case 'star_noiseDisplace': patch.noiseDisplace = +value; break;

  case 'star_twinkleSpeed':  patch.twinkleSpeed = +value; break;
  case 'star_twinkleAmount': patch.twinkleAmount = +value; break;
  case 'star_driftSpeed':    patch.driftSpeed = +value; break;
  case 'star_seed':          patch.seed = (value==null || value==='') ? null : (value|0); break;

  case 'star_nebulaEnabled': patch.nebulaEnabled = !!value; break;
  case 'star_nebulaAmount':  patch.nebulaAmount = +value; break;
  case 'star_nebulaScale':   patch.nebulaScale = +value; break;
  case 'star_nebulaBias':    patch.nebulaBias = +value; break;
  case 'star_nebulaSmooth':  patch.nebulaSmooth = +value; break;
  case 'star_nebulaColorA':  patch.nebulaColorA = value; break;
  case 'star_nebulaColorB':  patch.nebulaColorB = value; break;

  case 'star_bgEnabled':    patch.bgEnabled = !!value; break;
  case 'star_bgScale':      patch.bgScale = +value; break;
  case 'star_bgThreshold':  patch.bgThreshold = +value; break;
  case 'star_bgFalloff':    patch.bgFalloff = +value; break;
  case 'star_bgPower':      patch.bgPower = +value; break;
  case 'star_bgVignette':   patch.bgVignette = +value; break;
  case 'star_bgColorA':     patch.bgColorA = value; break;
  case 'star_bgColorB':     patch.bgColorB = value; break;
  }
  Starfield.configure(patch);
}

/* Applies full Starfield config from current params (used after restore). */
function applyStarfieldFromParams(){
  Starfield.configure({
    count:        params.star_count|0,
    radius:       +params.star_radius,
    thickness:    +params.star_thickness,
    color:        params.star_color,
    size:         +params.star_size,
    sizeJitter:   +params.star_sizeJitter,
    opacity:      +params.star_opacity,

    noiseScale:    +params.star_noiseScale,
    noiseBias:     +params.star_noiseBias,
    noiseStrength: +params.star_noiseStrength,
    noiseDisplace: +params.star_noiseDisplace,

    twinkleSpeed:  +params.star_twinkleSpeed,
    twinkleAmount: +params.star_twinkleAmount,
    driftSpeed:    +params.star_driftSpeed,
    seed:          (params.star_seed==null || params.star_seed==='') ? null : (params.star_seed|0),

    nebulaEnabled: !!params.star_nebulaEnabled,
    nebulaAmount:  +params.star_nebulaAmount,
    nebulaScale:   +params.star_nebulaScale,
    nebulaBias:    +params.star_nebulaBias,
    nebulaSmooth:  +params.star_nebulaSmooth,
    nebulaColorA:  params.star_nebulaColorA,
    nebulaColorB:  params.star_nebulaColorB,

    bgEnabled:     !!params.star_bgEnabled,
    bgScale:       +params.star_bgScale,
    bgThreshold:   +params.star_bgThreshold,
    bgFalloff:     +params.star_bgFalloff,
    bgPower:       +params.star_bgPower,
    bgVignette:    +params.star_bgVignette,
    bgColorA:      params.star_bgColorA,
    bgColorB:      params.star_bgColorB
  });
}








    /** Builds the on-screen GUI. */
const gui = new GUI({ title: "Blob Controls" });

syncGuiFromParams();

const f0 = gui.addFolder("Render / Look");
f0.add(params, "renderMode", ["solid","wireframe","points"]).name("Render Mode").onChange(mode=>{
  const isPoints = (mode==="points");
  sphere.visible = !isPoints;
  sphereMat.wireframe = (mode==="wireframe");
  spherePoints.visible = isPoints;
});
f0.add(params, "saturation", 0.0, 2.0, 0.01).name("Saturation").onChange(v=>{
  sphereMat.uniforms.uSaturation.value = v;
  reflectMatBottom.uniforms.uSaturation.value = v;
  reflectMatTop.uniforms.uSaturation.value = v;
  spherePointsMat.uniforms.uSaturation.value = v;
});
f0.add(params, "pointSize", 0.05, 0.45, 0.005).name("Point Size (PC)");

const fPC = gui.addFolder("Point Cloud Audio React");
fPC.add(params, "pcAudioReact").name("Enable");
fPC.add(params, "pcReactAmount", 0.0, 3.0, 0.01).name("Amount");

const f1 = gui.addFolder("Deformation");
f1.add(params, "rotationSpeed", 0.0, 2.0, 0.01).name("Rotation Speed");
f1.add(params, "displacement_amp", 0.0, 0.8, 0.005).name("Displacement Amp").onChange(v=>{
  sphereMat.uniforms.uAmp.value = v; reflectMatBottom.uniforms.uAmp.value = v; reflectMatTop.uniforms.uAmp.value = v; spherePointsMat.uniforms.uAmp.value = v;
});
f1.add(params, "noise_freq", 0.1, 4.0, 0.01).name("Noise Freq").onChange(v=>{
  sphereMat.uniforms.uFreq.value = v; reflectMatBottom.uniforms.uFreq.value = v; reflectMatTop.uniforms.uFreq.value = v; spherePointsMat.uniforms.uFreq.value = v;
});
f1.add(params, "tex_strength", 0.0, 3.0, 0.01).name("Media Strength").onChange(v=>{
  sphereMat.uniforms.uTexStrength.value = v; reflectMatBottom.uniforms.uTexStrength.value = v; reflectMatTop.uniforms.uTexStrength.value = v; spherePointsMat.uniforms.uTexStrength.value = v;
});

const f2 = gui.addFolder("Bottom Reflector / Floor");
f2.add(params, "reflection_alpha", 0.0, 1.0, 0.01).name("Opacity").onChange(v=>{ reflectMatBottom.uniforms.uAlpha.value = v; });
f2.add(params, "pool_radius", 0.2, 5.0, 0.01).name("Bright Radius").onChange(v=>{ reflectMatBottom.uniforms.uR.value = v; });
f2.add(params, "pool_softness", 0.1, 3.0, 0.01).name("Fade Softness").onChange(v=>{ reflectMatBottom.uniforms.uSoft.value = v; });
f2.add(params, "wobble_amp", 0.0, 0.05, 0.001).name("Surface Wobble Amp").onChange(v=>{ reflectMatBottom.uniforms.uWobbleAmp.value = v; reflectMatTop.uniforms.uWobbleAmp.value = v; });
f2.add(params, "wobble_freq", 0.1, 4.0, 0.01).name("Surface Wobble Freq").onChange(v=>{ reflectMatBottom.uniforms.uWobbleFreq.value = v; reflectMatTop.uniforms.uWobbleFreq.value = v; });

const f2b = gui.addFolder("Top Reflector / Ceiling");
f2b.add(params, "top_reflection_alpha", 0.0, 1.0, 0.01).name("Opacity").onChange(v=>{ reflectMatTop.uniforms.uAlpha.value = v; });
f2b.add(params, "top_pool_radius", 0.2, 5.0, 0.01).name("Bright Radius").onChange(v=>{ reflectMatTop.uniforms.uR.value = v; });
f2b.add(params, "top_pool_softness", 0.1, 3.0, 0.01).name("Fade Softness").onChange(v=>{ reflectMatTop.uniforms.uSoft.value = v; });

const f3 = gui.addFolder("Ambient Particles");
f3.add(params, "particles", 0, 30000, 50).name("Count").onFinishChange(v=>{ buildParticles(Math.max(0, Math.floor(v))); });
f3.add(params, "particleSpeedScale", 0.0, 3.0, 0.01).name("Speed Scale");
f3.add(params, "particleSwirl", 0.0, 2.0, 0.01).name("Swirl");
f3.add(params, "particlePushStrength", 0.0, 20.0, 0.1).name("Push Strength");
f3.add(params, "particleMargin", 0.0, 0.3, 0.005).name("Surface Margin");
f3.add(params, "particleDamping", 0.7, 0.99, 0.001).name("Damping");

const f4 = gui.addFolder("Spectrum (Audio)");
f4.add(params, "spectrumMode", ["points","line"]).name("Mode");
f4.add(params, "spectrumShape", ["circle","square","triangle","cross"]).name("Point Shape").onChange(name=>{
  const map = {circle:0, square:1, triangle:2, cross:3};
  specMat.uniforms.uShape.value = map[name] ?? 0;
});
f4.add(params, "spectrumSize", 2.0, 24.0, 0.1).name("Point Size");
f4.add(params, "spectrumRadius", 1.2, 3.5, 0.01).name("Radius");
f4.add(params, "spectrumHeight", 0.2, 2.0, 0.01).name("Height Scale");
f4.add(params, "spectrumGain", 0.2, 4.0, 0.01).name("Gain");
f4.add(params, "spectrumHueShift", 0.0, 1.0, 0.001).name("Hue Shift");
f4.add(params, "autoShowBands").name("Auto Show When Audio");
f4.add(params, "showThreshold", 0.0, 0.2, 0.001).name("Show Threshold");
f4.add(params, "showSmoothing", 0.5, 0.99, 0.001).name("Show Smooth");





/* ============================================================================
 * Starfield GUI controls (binds Starfield.config live to lil-gui via params)
 * Insert this whole block RIGHT BEFORE `AmbientFlow GUI controls`.
 * ========================================================================== */
(function makeStarfieldGUI(){
  // Avoid TDZ on module-scoped `const Starfield` by probing inside try/catch.
  let ready = true;
  try { void Starfield; } catch(_) { ready = false; }
  if (!ready || !gui) { queueMicrotask(makeStarfieldGUI); return; }

  const fSF   = gui.addFolder('Starfield');           fSF.close();
  const fDist = fSF.addFolder('Distribution');        fDist.close();
  const fLook = fSF.addFolder('Appearance');          fLook.close();
  const fMot  = fSF.addFolder('Motion / Twinkle');    fMot.close();
  const fNeb  = fSF.addFolder('Nebula (per-star)');   fNeb.close();
  const fBG   = fSF.addFolder('Background Sky');      fBG.close();
  const fRnd  = fSF.addFolder('Randomness');          fRnd.close();

  // Distribution
  fDist.add(params, 'star_count', 0, 100000, 100).name('Count')
  .onChange(v => { applyParamSideEffects('star_count', v); schedulePersist(); }).listen();
  fDist.add(params, 'star_radius', 1, 2000, 1).name('Radius')
  .onChange(v => { applyParamSideEffects('star_radius', v); schedulePersist(); }).listen();
  fDist.add(params, 'star_thickness', 0, 1000, 1).name('Thickness')
  .onChange(v => { applyParamSideEffects('star_thickness', v); schedulePersist(); }).listen();

  // Appearance
  fLook.addColor(params, 'star_color').name('Tint')
  .onChange(v => { applyParamSideEffects('star_color', v); schedulePersist(); }).listen();
  fLook.add(params, 'star_size', 0.1, 6.0, 0.01).name('Size')
  .onChange(v => { applyParamSideEffects('star_size', v); schedulePersist(); }).listen();
  fLook.add(params, 'star_sizeJitter', 0.0, 2.0, 0.01).name('Size Jitter')
  .onChange(v => { applyParamSideEffects('star_sizeJitter', v); schedulePersist(); }).listen();
  fLook.add(params, 'star_opacity', 0.0, 1.0, 0.01).name('Opacity')
  .onChange(v => { applyParamSideEffects('star_opacity', v); schedulePersist(); }).listen();

  // Clustering noise
  fDist.add(params, 'star_noiseScale', 0.001, 1.0, 0.001).name('Noise Scale')
  .onChange(v => { applyParamSideEffects('star_noiseScale', v); schedulePersist(); }).listen();
  fDist.add(params, 'star_noiseBias', 0.0, 1.0, 0.001).name('Noise Bias')
  .onChange(v => { applyParamSideEffects('star_noiseBias', v); schedulePersist(); }).listen();
  fDist.add(params, 'star_noiseStrength', 0.0, 2.0, 0.001).name('Noise Strength')
  .onChange(v => { applyParamSideEffects('star_noiseStrength', v); schedulePersist(); }).listen();
  fDist.add(params, 'star_noiseDisplace', 0.0, 6.0, 0.01).name('Noise Displace')
  .onChange(v => { applyParamSideEffects('star_noiseDisplace', v); schedulePersist(); }).listen();

  // Motion / Twinkle
  fMot.add(params, 'star_twinkleSpeed', 0.0, 4.0, 0.01).name('Twinkle Speed')
  .onChange(v => { applyParamSideEffects('star_twinkleSpeed', v); schedulePersist(); }).listen();
  fMot.add(params, 'star_twinkleAmount', 0.0, 1.0, 0.001).name('Twinkle Amount')
  .onChange(v => { applyParamSideEffects('star_twinkleAmount', v); schedulePersist(); }).listen();
  fMot.add(params, 'star_driftSpeed', 0.0, 0.1, 0.0005).name('Drift Speed')
  .onChange(v => { applyParamSideEffects('star_driftSpeed', v); schedulePersist(); }).listen();

  // Nebula tint per star
  fNeb.add(params, 'star_nebulaEnabled').name('Enable')
  .onChange(v => { applyParamSideEffects('star_nebulaEnabled', v); schedulePersist(); }).listen();
  fNeb.add(params, 'star_nebulaAmount', 0.0, 1.0, 0.001).name('Amount')
  .onChange(v => { applyParamSideEffects('star_nebulaAmount', v); schedulePersist(); }).listen();
  fNeb.add(params, 'star_nebulaScale', 0.001, 0.2, 0.001).name('Scale')
  .onChange(v => { applyParamSideEffects('star_nebulaScale', v); schedulePersist(); }).listen();
  fNeb.add(params, 'star_nebulaBias', 0.0, 1.0, 0.001).name('Bias')
  .onChange(v => { applyParamSideEffects('star_nebulaBias', v); schedulePersist(); }).listen();
  fNeb.add(params, 'star_nebulaSmooth', 0.0, 1.0, 0.001).name('Smooth')
  .onChange(v => { applyParamSideEffects('star_nebulaSmooth', v); schedulePersist(); }).listen();
  fNeb.addColor(params, 'star_nebulaColorA').name('Color A')
  .onChange(v => { applyParamSideEffects('star_nebulaColorA', v); schedulePersist(); }).listen();
  fNeb.addColor(params, 'star_nebulaColorB').name('Color B')
  .onChange(v => { applyParamSideEffects('star_nebulaColorB', v); schedulePersist(); }).listen();

  // Background sky
  fBG.add(params, 'star_bgEnabled').name('Enabled')
  .onChange(v => { applyParamSideEffects('star_bgEnabled', v); schedulePersist(); }).listen();
  fBG.add(params, 'star_bgScale', 0.001, 6.0, 0.001).name('Scale')
  .onChange(v => { applyParamSideEffects('star_bgScale', v); schedulePersist(); }).listen();
  fBG.add(params, 'star_bgThreshold', 0.0, 1.0, 0.001).name('Threshold')
  .onChange(v => { applyParamSideEffects('star_bgThreshold', v); schedulePersist(); }).listen();
  fBG.add(params, 'star_bgFalloff', 0.0, 1.0, 0.001).name('Edge Falloff')
  .onChange(v => { applyParamSideEffects('star_bgFalloff', v); schedulePersist(); }).listen();
  fBG.add(params, 'star_bgPower', 0.1, 4.0, 0.01).name('Core Power')
  .onChange(v => { applyParamSideEffects('star_bgPower', v); schedulePersist(); }).listen();
  fBG.add(params, 'star_bgVignette', 0.0, 1.5, 0.01).name('Vignette')
  .onChange(v => { applyParamSideEffects('star_bgVignette', v); schedulePersist(); }).listen();
  fBG.addColor(params, 'star_bgColorA').name('Sky Color A')
  .onChange(v => { applyParamSideEffects('star_bgColorA', v); schedulePersist(); }).listen();
  fBG.addColor(params, 'star_bgColorB').name('Sky Color B')
  .onChange(v => { applyParamSideEffects('star_bgColorB', v); schedulePersist(); }).listen();

  // Randomness / Seed
  const seedProxy = { seed: (params.star_seed==null ? '' : String(params.star_seed)) };
  fRnd.add(seedProxy, 'seed').name('Seed (int or empty)')
  .onFinishChange(v => {
    const s = (typeof v === 'string' && v.trim() === '') ? null : (Number.isFinite(+v) ? (v|0) : null);
    params.star_seed = s;
    applyParamSideEffects('star_seed', s);
    seedProxy.seed = (params.star_seed==null ? '' : String(params.star_seed));
    schedulePersist();
  }).listen();

  // Auto-listen
  const all = (typeof fSF.controllersRecursive === 'function') ? fSF.controllersRecursive() : (fSF.controllers || []);
  all.forEach(c => { if (typeof c.listen === 'function') c.listen(); });
})();




/* ============================================================================
 * AmbientFlow GUI controls (binds AmbientFlow.config live to lil-gui)
 * Insert this whole block RIGHT BEFORE `gui.close()`.
 * ========================================================================== */
(function makeAmbientFlowGUI(){
  if (typeof AmbientFlow === 'undefined' || !gui) return;

  // Ensure nested object exists
  AmbientFlow.config.orbit = AmbientFlow.config.orbit || {};
  const af = AmbientFlow.config;

  // helpers
  const apply = (patch) => { AmbientFlow.configure(patch); /* no persist here to avoid init races */ };
  const clampLife = () => {
    if (af.lifeMin > af.lifeMax) { const t = af.lifeMin; af.lifeMin = af.lifeMax; af.lifeMax = t; }
  };
  const toIntOrNull = (v) => (typeof v === 'string' && v.trim() === '') ? null : (Number.isFinite(+v) ? parseInt(v,10) : null);

  const fAF     = gui.addFolder('Ambient Flow'); fAF.close();
  const fEmit   = fAF.addFolder('Emission');     fEmit.close();
  const fSpawn  = fAF.addFolder('Spawn');        fSpawn.close();
  const fOrbit  = fAF.addFolder('Orbit');        fOrbit.close();
  const fReturn = fAF.addFolder('Return');       fReturn.close();
  const fRnd    = fAF.addFolder('Randomness');   fRnd.close();

  // Emission
  fEmit.add(af, 'emitRate', 0, 300, 1).name('Emit Rate (pps)')
  .onChange(v => apply({ emitRate: v })).listen();
  fEmit.add(af, 'lifeMin', 0.1, 20, 0.05).name('Life Min (s)')
  .onChange(() => { clampLife(); apply({ lifeMin: af.lifeMin, lifeMax: af.lifeMax }); }).listen();
  fEmit.add(af, 'lifeMax', 0.1, 20, 0.05).name('Life Max (s)')
  .onChange(() => { clampLife(); apply({ lifeMin: af.lifeMin, lifeMax: af.lifeMax }); }).listen();

  // Spawn (jitter/kick)
  fSpawn.add(af, 'spawnJitter', 0.0, 0.10, 0.001).name('Spawn Jitter (m)')
  .onChange(v => apply({ spawnJitter: v })).listen();
  fSpawn.add(af, 'kickSpeed', 0.0, 2.0, 0.01).name('Kick Speed')
  .onChange(v => apply({ kickSpeed: v })).listen();
  fSpawn.add(af, 'kickY', 0.0, 1.0, 0.01).name('Kick Y')
  .onChange(v => apply({ kickY: v })).listen();
  fSpawn.add(af, 'kickSpread', 0.0, 3.0, 0.01).name('Kick Spread')
  .onChange(v => apply({ kickSpread: v })).listen();

  // Orbit
  fOrbit.add(af.orbit, 'rBase', 0.2, 4.0, 0.01).name('Radius Base')
  .onChange(v => apply({ orbit: { rBase: v } })).listen();
  fOrbit.add(af.orbit, 'rAmp1', 0.0, 2.0, 0.01).name('Radius Amp 1')
  .onChange(v => apply({ orbit: { rAmp1: v } })).listen();
  fOrbit.add(af.orbit, 'rFreq1', 0.0, 3.0, 0.01).name('Radius Freq 1')
  .onChange(v => apply({ orbit: { rFreq1: v } })).listen();
  fOrbit.add(af.orbit, 'rAmp2', 0.0, 2.0, 0.01).name('Radius Amp 2')
  .onChange(v => apply({ orbit: { rAmp2: v } })).listen();
  fOrbit.add(af.orbit, 'rFreq2', 0.0, 3.0, 0.01).name('Radius Freq 2')
  .onChange(v => apply({ orbit: { rFreq2: v } })).listen();
  fOrbit.add(af.orbit, 'angSpeed', 0.0, 3.0, 0.01).name('Angle Speed')
  .onChange(v => apply({ orbit: { angSpeed: v } })).listen();
  fOrbit.add(af.orbit, 'angOscAmp', 0.0, 2.0, 0.01).name('Angle Osc Amp')
  .onChange(v => apply({ orbit: { angOscAmp: v } })).listen();
  fOrbit.add(af.orbit, 'angOscFreq', 0.0, 3.0, 0.01).name('Angle Osc Freq')
  .onChange(v => apply({ orbit: { angOscFreq: v } })).listen();
  fOrbit.add(af.orbit, 'yBase', 0.0, 3.0, 0.01).name('Y Base')
  .onChange(v => apply({ orbit: { yBase: v } })).listen();
  fOrbit.add(af.orbit, 'yAmp', 0.0, 2.0, 0.01).name('Y Amp')
  .onChange(v => apply({ orbit: { yAmp: v } })).listen();
  fOrbit.add(af.orbit, 'yOsc1', 0.0, 3.0, 0.01).name('Y Freq 1')
  .onChange(v => apply({ orbit: { yOsc1: v } })).listen();
  fOrbit.add(af.orbit, 'yOsc2', 0.0, 3.0, 0.01).name('Y Freq 2')
  .onChange(v => apply({ orbit: { yOsc2: v } })).listen();

  // Return / Swirl
  fReturn.add(af, 'returnGain', 0.0, 60.0, 0.5).name('Return Gain')
  .onChange(v => apply({ returnGain: v })).listen();
  fReturn.add(af, 'returnGainY', 0.0, 2.0, 0.01).name('Return Gain Y')
  .onChange(v => apply({ returnGainY: v })).listen();
  fReturn.add(af, 'swirlYFactor', 0.0, 1.0, 0.01).name('Swirl Y Factor')
  .onChange(v => apply({ swirlYFactor: v })).listen();

  // Randomness / Seed
// REPLACE ONLY THIS SUBSECTION inside your AmbientFlow GUI block

// Randomness / Seed
  const seedProxy = { seed: (af.seed == null ? '' : String(af.seed)) };
  fRnd.add(seedProxy, 'seed').name('Seed (int or empty)')
  .onFinishChange(v => {
    const s = (typeof v === 'string' && v.trim() === '') ? null : (Number.isFinite(+v) ? (v|0) : null);
    AmbientFlow.setSeed(s);
    seedProxy.seed = (AmbientFlow.config.seed == null ? '' : String(AmbientFlow.config.seed));
  }).listen();


  // Auto-refresh all created controls
  const all = (typeof fAF.controllersRecursive === 'function') ? fAF.controllersRecursive() : (fAF.controllers || []);
  all.forEach(c => { if (typeof c.listen === 'function') c.listen(); });
})();













gui.close();






// INSERT directly below gui.close(): enable .listen() on all existing controllers to auto-reflect external param changes.
{
  const list = typeof gui?.controllersRecursive === 'function'
  ? gui.controllersRecursive()
  : (Array.isArray(gui?.controllers) ? gui.controllers : []);
  for (const c of list) { if (typeof c.listen === 'function') c.listen(); }
}


// --- Presets: save/load GUI + camera/target (REPLACEMENT WITH VERBOSE LOGS) ---

// local logger, always on for this block
function _g(...a){ console.log('[GUI]', ...a); }
function _warn(...a){ console.warn('[GUI]', ...a); }

// find a controller by its property key (prefer _property; fallback to displayed label)
function findControllerByName(root, key) {
  if (!root) return null;

  // Prefer official API if available (lil-gui >= 0.17).
  const list = typeof root.controllersRecursive === 'function'
  ? root.controllersRecursive()
  : (function collect(node) {
    const acc = [];
    const ctrls = []
    .concat(node.controllers || [])
    .concat(node.__controllers || [])
    .concat(node._controllers || []);
    for (const c of ctrls) acc.push(c);

      const subs = []
    .concat(node.folders || [])
    .concat(node.__folders || [])
    .concat(node._folders || [])
    .concat(node.children || []);
    for (const s of subs) {
          // some implementations keep folders in keyed objects
      if (Array.isArray(s)) { for (const x of s) acc.push(...collect(x)); continue; }
      if (s && typeof s === 'object') acc.push(...collect(s));
    }
    return acc;
  })(root);

  for (const c of list) {
    const prop = c._property ?? c.property ?? c._name;
    const name = c._name ?? c.name;
    if (prop === key || name === key) return c;
  }
  return null;
}

// set param + update lil-gui display if present, then apply side effects
function setParamAndGui(name, value) {
  const prev = params[name];
  params[name] = value;

  const ctrl = findControllerByName(gui, name);
  if (ctrl) {
    try {
      ctrl.setValue(value);
      if (typeof ctrl.updateDisplay === 'function') ctrl.updateDisplay();
      _g('setParamAndGui', { name, from: prev, to: value });
    } catch (e) {
      _warn('setParamAndGui#setValue failed', { name, error: e });
      try { if (typeof applyParamSideEffects === 'function') applyParamSideEffects(name, value); } catch (_) {}
    }
  } else {
    try { if (typeof applyParamSideEffects === 'function') applyParamSideEffects(name, value); } catch (_) {}
    _g('setParamAndGui (no controller)', { name, value });
  }

  if (typeof schedulePersist === 'function') schedulePersist();
}


// push current params into GUI (explicit, with counts)
function syncGuiFromParams() {
  if (!gui) { _warn('syncGuiFromParams: gui not ready'); return; }
  let updated = 0, missing = 0, failed = 0;

  for (const [k, v] of Object.entries(params)) {
    const c = findControllerByName(gui, k);
    if (!c) { missing++; continue; }
    try {
      c.setValue(v);
      if (typeof c.updateDisplay === 'function') c.updateDisplay();
      updated++;
    } catch (e) {
      failed++;
      _warn('syncGuiFromParams#failed', { key: k, error: e });
    }
  }
  _g('syncGuiFromParams', { updated, missing, failed });
}


// snapshot current app state
function snapshotSettings(presetName = 'preset'){
  return {
    name: presetName,
    ts: Date.now(),
    params: { ...params },
    camera: {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target:   [controls.target.x, controls.target.y, controls.target.z]
    }
  };
}

// apply snapshot -> pushes values into GUI and camera
// apply snapshot -> pushes values into GUI and camera
function applySettings(snap) {
  if (!snap || !snap.params || !snap.camera) { _warn('applySettings: invalid snapshot'); return; }

  console.group('[Restore] applySettings', snap.name ?? '');
  let setCount = 0, skipped = 0;

  for (const [k, v] of Object.entries(snap.params)) {
    if (k in params) { setParamAndGui(k, v); setCount++; }
    else { skipped++; _warn('applySettings: unknown param (ignored)', k); }
  }

  const p = Array.isArray(snap.camera.position) ? snap.camera.position : [0, 1.6, 3.5];
  const t = Array.isArray(snap.camera.target)   ? snap.camera.target   : [0, 0.9, 0];
  camera.position.set(p[0], p[1], p[2]);
  controls.target.set(t[0], t[1], t[2]);
  camera.updateProjectionMatrix();
  controls.update();

  // push GUI displays
  syncGuiFromParams();

  // ensure Starfield matches restored params (controller.setValue does not fire onChange)
  try { applyStarfieldFromParams(); } catch(_) {}

  let mismatches = 0; const rows = [];
  const all = typeof gui?.controllersRecursive === 'function' ? gui.controllersRecursive() : [];
  for (const c of all) {
    const key = c._property ?? c.property ?? c._name;
    if (!(key in params)) continue;
    const guiVal = (typeof c.getValue === 'function') ? c.getValue() : (c._object ? c._object[c._property] : undefined);
    const modelVal = params[key];
    const same = (guiVal === modelVal) ||
    (Number.isFinite(guiVal) && Number.isFinite(modelVal) && Math.abs(guiVal - modelVal) < 1e-9);
    if (!same) { mismatches++; rows.push({ key, guiVal, modelVal }); }
  }
  if (rows.length) console.table(rows);

  _g('applySettings summary', { setCount, skipped, mismatches });
  console.groupEnd();
}







/* Persist / Restore (mobile-safe, hoisted, no globals) */

var __persistTimer = 0;

const __LS_OK = (function(){
  try {
    const k = '__ls_probe__' + Math.random().toString(36).slice(2);
    localStorage.setItem(k, '1'); localStorage.removeItem(k);
    return true;
  } catch (_) { return false; }
})();

/** persistNow(): write params + camera + media to localStorage */
function persistNow(){
  if (!__LS_OK) { console.warn('[GUI] localStorage unavailable'); return; }
  try {
    const snap = {
      ts: Date.now(),
      params: { ...params },
      camera: {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target:   [controls.target.x, controls.target.y, controls.target.z]
      },
      media: (playlist && Number.isInteger(currentIndex))
      ? { index: currentIndex, url: (playlist[currentIndex]?.url || playlist[currentIndex]?.src || null) }
      : { index: 0 },
      loop: !!(typeof loopChk !== 'undefined' && loopChk && loopChk.checked)
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    console.log('[GUI] persisted');
  } catch (e) {
    console.warn('[GUI] persistNow failed', e);
  }
}

/** schedulePersist(): debounce-save to storage */
function schedulePersist(){
  clearTimeout(__persistTimer);
  __persistTimer = setTimeout(persistNow, 120);
}

/** restoreFromStorageOrPreset(): load from storage; fallback to presets/default.json */
async function restoreFromStorageOrPreset(){
  console.group('[Restore] start');
  let restored = false;

  if (__LS_OK){
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw){
        const saved = JSON.parse(raw);
        if (saved?.params && saved?.camera){
          applySettings(saved);
          if (typeof saved.loop === 'boolean' && typeof loopChk !== 'undefined' && loopChk){
            loopChk.checked = saved.loop;
          }
          if (saved.media && Number.isInteger(saved.media.index)){
            currentIndex = Math.max(0, Math.min(saved.media.index|0, Math.max(0, playlist.length-1)));
          }
          if (typeof refreshPlaylistSelect === 'function') refreshPlaylistSelect();
          restored = true;
          console.log('[GUI] restored from localStorage');
        }
      }
    } catch (e) {
      console.warn('[GUI] restore localStorage parse error', e);
    }
  } else {
    console.warn('[GUI] localStorage unavailable (private mode / blocked)');
  }

  if (!restored && typeof fetch === 'function'){
    try {
      const res = await fetch('/static/presets/default.json', { cache: 'no-store' });
      if (res.ok){
        const json = await res.json();
        if (json?.params && json?.camera){
          applySettings(json);
          if (json.media && Number.isInteger(json.media.index)){
            currentIndex = Math.max(0, Math.min(json.media.index|0, Math.max(0, playlist.length-1)));
          }
          if (typeof refreshPlaylistSelect === 'function') refreshPlaylistSelect();
          console.log('[GUI] restored default.json');
        }
      }
    } catch (e) {
      console.warn('[GUI] default preset fetch error', e);
    }
  }

  console.groupEnd();
}








// file picker UI
const presetFileInput = document.getElementById('presetFile');
presetFileInput?.addEventListener('change', async e=>{
  const file = e.target.files?.[0];
  if (!file) return;
  try{
    const text = await file.text();
    const json = JSON.parse(text);
    _g('apply from file', file.name);
    applySettings(json);
  }catch(err){ _warn('file load failed', err); }
  finally { presetFileInput.value = ''; }
});

// add preset folder actions (reuse your existing gui instance)
const fPresets = gui.addFolder('Presets');
fPresets.add({save:()=>{ 
  const name = prompt('Preset name:', 'preset') || 'preset';
  const data = snapshotSettings(name);
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  a.href = URL.createObjectURL(blob);
  a.download = `player-settings-${ts}-${name}.json`;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 0);
  _g('saved file', a.download);
}}, 'save').name('Save to file');

fPresets.add({load:()=>{ presetFileInput.click(); }}, 'load').name('Load from file');
fPresets.open();

// persist on camera change + before unload
queueMicrotask(()=>{ try{ controls?.addEventListener?.('change', schedulePersist); }catch(_){}; });
window.addEventListener('beforeunload', persistNow);
// --- end replacement block ---






applyUIVisibility();

/** Orbit controls setup. */
let controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; 
controls.enablePan=false; 
controls.minDistance=0.1; 
controls.maxDistance=24;

controls.target.set(0,0.9,0); 
//controls.maxPolarAngle = Math.PI*0.49;

controls.addEventListener('change', schedulePersist);


    /** CPU media probe canvas for luminance sampling. */
const probeCanvas = document.createElement('canvas');
const probeCtx = probeCanvas.getContext('2d', { willReadFrequently:true });
probeCanvas.width = 128; probeCanvas.height = 128;
let probePixels = null;

/** Renders the current media source into a small CPU canvas and updates `probePixels`.
 *  Supports: webcam/video (<video>), image (<img>), and audio-only (spectrum canvas).
 *  For audio-only, it downsamples the live spectrum canvas into `probeCanvas`.
 */
function updateProbe(){
  // Ensure we have a drawing context
  if (!probeCtx || !probeCanvas) { probePixels = null; return; }

  // Webcam or file video: draw the current frame if one is available
  if (source.type === "webcam" || source.type === "video"){
    const v = source.videoEl;
    if (!v || v.readyState < 2 || v.videoWidth === 0 || v.videoHeight === 0){
      probePixels = null; 
      return;
    }
    probeCtx.drawImage(v, 0, 0, probeCanvas.width, probeCanvas.height);

  // Image: draw the current image
  } else if (source.type === "image"){
    const img = source.imageEl;
    if (!img) { probePixels = null; return; }
    probeCtx.drawImage(img, 0, 0, probeCanvas.width, probeCanvas.height);

  // Audio-only: draw the generated spectrum canvas (acts as the media texture)
  } else if (source.type === "audio"){
    const spectrumCanvas = source.spectrumCanvas;
    if (!spectrumCanvas) { probePixels = null; return; }
    probeCtx.drawImage(spectrumCanvas, 0, 0, probeCanvas.width, probeCanvas.height);

  // No source: clear pixels
  } else {
    probePixels = null;
    return;
  }

  // Read back pixels for CPU-side luminance sampling
  try {
    probePixels = probeCtx.getImageData(0, 0, probeCanvas.width, probeCanvas.height).data;
  } catch (e) {
    console.warn("[Probe] getImageData failed", e);
    probePixels = null;
  }
}


    /** Converts a direction to equirect UV for sampling. */
function dirToUV(n){
  const u = 0.5 + Math.atan2(n.z, n.x)/(2*Math.PI);
  const v = 0.5 + Math.asin(THREE.MathUtils.clamp(n.y,-1,1))/Math.PI;
  return {u, v};
}

    /** CPU-side displacement sampling for particles. */
const center = new THREE.Vector3(0,1.15,0);
const tmp = new THREE.Vector3(), up = new THREE.Vector3(0,1,0);
const cpuSimplex = new SimplexNoise();
function displacedRadiusAtDir(n, time){
  const nf=sphereMat.uniforms.uFreq.value, nAmp=sphereMat.uniforms.uAmp.value, texStr=sphereMat.uniforms.uTexStrength.value;
  const noiseVal = cpuSimplex.noise3d(n.x*nf, n.y*nf + time*0.25, n.z*nf);
  const noiseDisp = noiseVal * (nAmp * 0.35);
  let texDisp = 0.0;
  if (sphereMat.uniforms.uUseTex.value === 1 && probePixels){
    const {u,v} = dirToUV(new THREE.Vector3(-n.x, n.y, n.z));
    const x = Math.min(probeCanvas.width-1, Math.max(0, Math.floor(u*probeCanvas.width)));
    const y = Math.min(probeCanvas.height-1, Math.max(0, Math.floor(v*probeCanvas.height)));
    const idx = (y*probeCanvas.width + x)*4;
    const r = probePixels[idx]/255, g = probePixels[idx+1]/255, b = probePixels[idx+2]/255;
    const l = 0.2126*r + 0.7152*g + 0.0722*b;
    texDisp = (0.5 - l) * (nAmp * 1.35) * texStr;
  }
  return 1.0 + THREE.MathUtils.clamp(noiseDisp + texDisp, -nAmp*1.35, nAmp*1.35);
}

    /** Resizes renderer and camera on window size changes. */
addEventListener('resize', () => {


  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);


  particlesOnResize();


});






/* ============================================================================
 * Starfield: procedural background stars with clustering + sparse nebula sky
 * What it does:
 *   - Builds a starfield as THREE.Points under a provided parent/group.
 *   - Supports shell radius/thickness, noise clustering, deterministic seed.
 *   - Optional twinkle and slow drift.
 *   - Black sky with sparse nebula patches rendered on an opaque BackSide dome
 *     (no scene tint, no lighting influence, visible in all tone mapping).
 *
 * Public API:
 *   Starfield.create(parent, options)   -> build (or rebuild) under parent
 *   Starfield.update(dt)                -> animate twinkle/drift per frame
 *   Starfield.configure(patch)          -> live-update; rebuild if layout changed
 *   Starfield.dispose()                 -> remove meshes and free buffers
 *   Starfield.state                     -> internals for inspection
 *   Starfield.config                    -> current config values
 * ========================================================================== */

const Starfield = (() => {
  // ---- default configuration ---------------------------------------------------
  const defaultConfig = {
    // Star distribution
    count: 2000,
    radius: 40,
    thickness: 20,
    // Star appearance
    color: 0xDDE6FF,
    size: 1.2,
    sizeJitter: 0.8,
    opacity: 1.0,
    // Clustering (accept/reject by noise + displacement)
    noiseScale: 0.08,
    noiseBias: 0.15,
    noiseStrength: 0.85,
    noiseDisplace: 2.0,
    // Motion / twinkle
    twinkleSpeed: 0.6,
    twinkleAmount: 0.35,
    driftSpeed: 0.002,
    seed: 12345,
    // Subtle per-star tinting by large-scale noise
    nebulaEnabled: true,
    nebulaAmount: 0.25,
    nebulaScale: 0.015,
    nebulaBias: 0.5,
    nebulaSmooth: 0.2,
    nebulaColorA: 0x9FB9FF,
    nebulaColorB: 0xFFA6A6,
    // Sparse nebula sky (opaque BackSide sphere; black where masked out)
    bgEnabled: true,
    bgScale: 0.04,      // lower → larger structures
    bgThreshold: 0.70,  // higher → sparser patches
    bgFalloff: 0.10,    // edge softness around threshold
    bgPower: 1.8,       // core contrast inside patches
    bgVignette: 0.25,   // gentle horizon darkening
    bgColorA: 0x7aa0ff, // cool tone
    bgColorB: 0xff8fa0  // warm tone
  };

  // ---- internal state ----------------------------------------------------------
  const s = {
    parent: null,
    points: null,
    geom: null,
    mat: null,
    bgMesh: null,
    bgGeom: null,
    bgMat: null,
    t: 0,
    rng: null,
    config: { ...defaultConfig }
  };

  // ---- deterministic RNG (mulberry32) -----------------------------------------
  function makeRng(seed){
    if (seed == null) return null;
    let a = (seed|0) || 1;
    return function() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rnd(){ return s.rng ? s.rng() : Math.random(); }
  function rndPm1(){ return rnd() * 2 - 1; }

  // ---- helpers -----------------------------------------------------------------
  function smoothstep(edge0, edge1, x){
    const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  // ---- Simplex-like 3D noise (compact) ----------------------------------------
  const Simplex = (() => {
    const p = new Uint8Array(256);
    function setSeed(seed){
      const r = makeRng(seed) || Math.random;
      for (let i=0;i<256;i++) p[i] = i;
        for (let i=255;i>0;i--) { const j=(r()*(i+1))|0; const t=p[i]; p[i]=p[j]; p[j]=t; }
      }
    setSeed(1337);
    const perm = new Uint8Array(512);
    function bake(){ for (let i=0;i<512;i++) perm[i] = p[i & 255]; }
    bake();
    function reseed(seed){ setSeed(seed==null?1337:seed); bake(); }
    function noise3D(x,y,z){
      // value-noise FBM (good enough for distribution & tint masks)
      function hash(vx,vy,vz){
        let xh = (vx*374761393)|0, yh = (vy*668265263)|0, zh = (vz*2147483647)|0;
        let h = xh ^ yh ^ zh; h = (h ^ (h>>>13)) * 1274126177; return ((h ^ (h>>>16)) >>> 0) / 4294967295;
      }
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      const xf = x - xi,       yf = y - yi,       zf = z - zi;
      const ux = xf*xf*(3-2*xf), uy = yf*yf*(3-2*yf), uz = zf*zf*(3-2*zf);
      function n(ix,iy,iz){ return hash(ix,iy,iz); }
      const n000 = n(xi,yi,zi),     n100 = n(xi+1,yi,zi);
      const n010 = n(xi,yi+1,zi),   n110 = n(xi+1,yi+1,zi);
      const n001 = n(xi,yi,zi+1),   n101 = n(xi+1,yi,zi+1);
      const n011 = n(xi,yi+1,zi+1), n111 = n(xi+1,yi+1,zi+1);
      const nx00 = n000 + (n100 - n000) * ux;
      const nx10 = n010 + (n110 - n010) * ux;
      const nx01 = n001 + (n101 - n001) * ux;
      const nx11 = n011 + (n111 - n011) * ux;
      const nxy0 = nx00 + (nx10 - nx00) * uy;
      const nxy1 = nx01 + (nx11 - nx01) * uy;
      return (nxy0 + (nxy1 - nxy0) * uz) * 2.0 - 1.0; // ~[-1,1]
    }
    return { noise3D, reseed };
  })();

  // ---- build all geometry/materials -------------------------------------------
  function build(parent){
    dispose();
    s.parent = parent;
    s.rng = makeRng(s.config.seed);
    Simplex.reseed(s.config.seed == null ? 1337 : s.config.seed);

    const {
      count, radius, thickness, noiseScale, noiseBias, noiseStrength, noiseDisplace,
      color, size, sizeJitter, opacity
    } = s.config;

    // --- Background nebula dome: opaque BackSide with sparse patches on black
    if (s.config.bgEnabled) {
      const domeR = 10000;
      s.bgGeom = new THREE.SphereGeometry(domeR, 64, 48);
      const colA = new THREE.Color(s.config.bgColorA);
      const colB = new THREE.Color(s.config.bgColorB);

      const vshBG = `
        varying vec3 vDir;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vDir = normalize(wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `;
      const fshBG = `
        precision highp float;
        varying vec3 vDir;
        uniform vec3  uA, uB;
        uniform float uScale;
        uniform float uThreshold;
        uniform float uFalloff;
        uniform float uPower;
        uniform float uVignette;

        // value-noise FBM
        float hash(vec3 p){
          p = fract(p*0.3183099 + vec3(0.1,0.2,0.3));
          p *= 17.0;
          return fract(p.x*p.y*p.z*(p.x+p.y+p.z));
        }
        float vnoise(vec3 p){
          vec3 i=floor(p), f=fract(p);
          vec3 u=f*f*(3.0-2.0*f);
          float n000=hash(i+vec3(0,0,0));
          float n100=hash(i+vec3(1,0,0));
          float n010=hash(i+vec3(0,1,0));
          float n110=hash(i+vec3(1,1,0));
          float n001=hash(i+vec3(0,0,1));
          float n101=hash(i+vec3(1,0,1));
          float n011=hash(i+vec3(0,1,1));
          float n111=hash(i+vec3(1,1,1));
          float nx00=mix(n000,n100,u.x);
          float nx10=mix(n010,n110,u.x);
          float nx01=mix(n001,n101,u.x);
          float nx11=mix(n011,n111,u.x);
          float nxy0=mix(nx00,nx10,u.y);
          float nxy1=mix(nx01,nx11,u.y);
          return mix(nxy0,nxy1,u.z);
        }
        float fbm(vec3 p){
          float a=0.5,f=1.0,s=0.0;
          for(int i=0;i<5;i++){ s+=a*vnoise(p*f); f*=2.0; a*=0.5; }
          return s;
        }
        float sstep(float e0,float e1,float x){
          float t=clamp((x-e0)/max(1e-6,e1-e0),0.0,1.0);
          return t*t*(3.0-2.0*t);
        }
        void main(){
          vec3 dir = normalize(vDir);
          float n   = fbm(dir * uScale);
          float m   = sstep(uThreshold - uFalloff, uThreshold + uFalloff, n);
          m = pow(m, uPower); // concentrate patch cores

          // gentle horizon darkening; keeps zenith brighter
          float horizon = pow(max(0.0, dir.y*0.5 + 0.5), uVignette*2.0);
          float vig = mix(1.0, 0.85, horizon);

          // color inside patches only; outside stays black
          vec3 cloud = mix(uA, uB, n) * vig;
          vec3 color = mix(vec3(0.0), cloud, m);

          // opaque write (no blending); draws first; never tints scene
          gl_FragColor = vec4(color, 1.0);
        }
      `;
      s.bgMat = new THREE.ShaderMaterial({
        uniforms: {
          uA:         { value: colA },
          uB:         { value: colB },
          uScale:     { value: s.config.bgScale },
          uThreshold: { value: s.config.bgThreshold },
          uFalloff:   { value: s.config.bgFalloff },
          uPower:     { value: s.config.bgPower },
          uVignette:  { value: s.config.bgVignette }
        },
        vertexShader:   vshBG,
        fragmentShader: fshBG,
        transparent: false,
        depthWrite: false,
        depthTest:  false,
        side: THREE.BackSide,
        toneMapped: false
      });
      s.bgMesh = new THREE.Mesh(s.bgGeom, s.bgMat);
      s.bgMesh.renderOrder = -1000; // render sky first
      s.bgMesh.frustumCulled = false;
      s.parent.add(s.bgMesh);
    }

    // --- Stars (positions/sizes/phases/colors)
    const positions = new Float32Array(count * 3);
    const sizes     = new Float32Array(count);
    const phases    = new Float32Array(count);
    const colorsArr = new Float32Array(count * 3);

    const baseCol = new THREE.Color(color);
    const colA    = new THREE.Color(s.config.nebulaColorA);
    const colB    = new THREE.Color(s.config.nebulaColorB);

    let placed = 0, guard = 0, MAX_GUARD = count * 20;
    while (placed < count && guard++ < MAX_GUARD){
      let x = rndPm1(), y = rndPm1(), z = rndPm1();
      const len = Math.hypot(x,y,z) || 1; x/=len; y/=len; z/=len;

      const t = thickness > 0 ? rnd() : 0;
      const r = radius + (t - 0.5) * thickness;

      let px = x * r, py = y * r, pz = z * r;

      const n = Simplex.noise3D(px * noiseScale, py * noiseScale, pz * noiseScale);
      const n01 = 0.5 * (n + 1.0);
      const accept = (noiseStrength <= 0) ? 1.0 : (n01 - noiseBias) * (1 / Math.max(1e-6, 1 - noiseBias));
      if (rnd() > Math.max(0, Math.min(1, accept))) continue;

      const disp = noiseDisplace * (n01 - 0.5);
      px += x * disp; py += y * disp; pz += z * disp;

      const i3 = placed * 3;
      positions[i3+0] = px;
      positions[i3+1] = py;
      positions[i3+2] = pz;

      const sj = size * (1.0 + sizeJitter * rndPm1());
      sizes[placed]  = Math.max(0.1, sj);
      phases[placed] = rnd();

      let mixRGB = baseCol.clone();
      if (s.config.nebulaEnabled) {
        const ns = s.config.nebulaScale;
        const nNeb = Simplex.noise3D(px * ns, py * ns, pz * ns);
        const nNeb01 = 0.5 * (nNeb + 1.0);
        const k = s.config.nebulaSmooth;
        const tt = smoothstep(s.config.nebulaBias - k, s.config.nebulaBias + k, nNeb01);
        const patch = colA.clone().lerp(colB, tt);
        mixRGB.lerp(patch, s.config.nebulaAmount);
      }
      colorsArr[i3+0] = mixRGB.r;
      colorsArr[i3+1] = mixRGB.g;
      colorsArr[i3+2] = mixRGB.b;

      placed++;
    }

    const finalCount = placed;
    s.geom = new THREE.BufferGeometry();
    s.geom.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, finalCount*3), 3));
    s.geom.setAttribute('aSize',    new THREE.BufferAttribute(sizes.subarray(0, finalCount), 1));
    s.geom.setAttribute('aPhase',   new THREE.BufferAttribute(phases.subarray(0, finalCount), 1));
    s.geom.setAttribute('aColor',   new THREE.BufferAttribute(colorsArr.subarray(0, finalCount*3), 3));

    const vsh = `
      uniform float uSizeBase;
      attribute float aSize;
      attribute float aPhase;
      attribute vec3  aColor;
      varying float vPhase;
      varying vec3  vColor;
      void main(){
        vPhase = aPhase;
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float distScale = 300.0 / max(1.0, -mv.z);
        gl_PointSize = max(1.0, (aSize + uSizeBase) * distScale);
        gl_Position = projectionMatrix * mv;
      }
    `;
    const fsh = `
      precision highp float;
      varying vec3  vColor;
      varying float vPhase;
      uniform float uOpacity;
      uniform float uTwinkleAmount;
      uniform float uTwinkleTime;
      void main(){
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(uv, uv);
        if (r2 > 1.0) discard;
        float soft   = 1.0 - smoothstep(0.6, 1.0, r2);
        float radial = pow(soft, 3.0);
        float tw     = 0.5 + 0.5 * sin(6.28318 * (uTwinkleTime + vPhase));
        float twMix  = mix(1.0 - uTwinkleAmount, 1.0, tw);
        gl_FragColor = vec4(vColor, uOpacity * radial * twMix);
      }
    `;
    s.mat = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity:       { value: opacity },
        uSizeBase:      { value: 0.0 },
        uTwinkleAmount: { value: s.config.twinkleAmount },
        uTwinkleTime:   { value: 0.0 }
      },
      vertexShader: vsh,
      fragmentShader: fsh,
      transparent: true,
      depthWrite: false
    });

    s.points = new THREE.Points(s.geom, s.mat);
    s.points.renderOrder = 1;
    s.points.frustumCulled = false;
    s.parent.add(s.points);
  }

  // ---- public API --------------------------------------------------------------
  function create(parent, options = {}){
    Object.assign(s.config, options);
    s.rng = makeRng(s.config.seed);
    build(parent);
  }

  function configure(patch = {}){
    const layoutKeys = [
      'count','radius','thickness','noiseScale','noiseBias','noiseStrength','noiseDisplace',
      'seed','color',
      'nebulaEnabled','nebulaAmount','nebulaScale','nebulaBias','nebulaSmooth','nebulaColorA','nebulaColorB',
      'bgEnabled','bgScale','bgThreshold','bgFalloff','bgPower','bgVignette'
    ];
    const appearanceKeys = ['size','sizeJitter','opacity','twinkleAmount'];
    let needRebuild = false, needMatUpdate = false, needBgUpdate = false;

    for (const k of Object.keys(patch)) {
      s.config[k] = patch[k];
      if (layoutKeys.includes(k)) needRebuild = true;
      if (appearanceKeys.includes(k)) needMatUpdate = true;
      if (['bgScale','bgThreshold','bgFalloff','bgPower','bgVignette','bgColorA','bgColorB'].includes(k)) needBgUpdate = true;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'seed')) {
      s.rng = makeRng(s.config.seed);
      Simplex.reseed(s.config.seed == null ? 1337 : s.config.seed);
      needRebuild = true;
    }

    if (needRebuild && s.parent) { build(s.parent); return; }

    if (needMatUpdate && s.mat) {
      s.mat.uniforms.uOpacity.value = s.config.opacity;
      s.mat.uniforms.uTwinkleAmount.value = s.config.twinkleAmount;
    }

    if (needBgUpdate && s.bgMat) {
      s.bgMat.uniforms.uScale.value     = s.config.bgScale;
      s.bgMat.uniforms.uThreshold.value = s.config.bgThreshold;
      s.bgMat.uniforms.uFalloff.value   = s.config.bgFalloff;
      s.bgMat.uniforms.uPower.value     = s.config.bgPower;
      s.bgMat.uniforms.uVignette.value  = s.config.bgVignette;
      s.bgMat.uniforms.uA.value.set(s.config.bgColorA);
      s.bgMat.uniforms.uB.value.set(s.config.bgColorB);
    }
  }

  function update(dt){
    if (!s.points || !s.mat) return;
    s.t += dt;
    s.mat.uniforms.uTwinkleTime.value = s.t * s.config.twinkleSpeed;
    if (s.config.driftSpeed !== 0) s.points.rotation.y += s.config.driftSpeed * dt;
  }

  function dispose(){
    if (s.parent && s.points) s.parent.remove(s.points);
    if (s.geom) s.geom.dispose();
    if (s.mat)  s.mat.dispose();
    if (s.parent && s.bgMesh) s.parent.remove(s.bgMesh);
    if (s.bgGeom) s.bgGeom.dispose();
    if (s.bgMat)  s.bgMat.dispose();
    s.points = s.geom = s.mat = null;
    s.bgMesh = s.bgGeom = s.bgMat = null;
  }

  return { create, update, dispose, configure, state: s, config: s.config };
})();

/* ============================================================================
 * Usage (drop-in): call once after you have a scene and a render loop
 * ========================================================================== */

Starfield.create(scene, {
  count: 20000,
  radius: 150,
  thickness: 50,
  seed: 42,
  // star tint subtlety
  nebulaEnabled: true,
  nebulaAmount: 0.3,
  // sparse, galaxy-like patches on black sky
  bgEnabled: true,
  bgScale: 3,
  bgThreshold: 0.69, // increase for sparser patches (e.g., 0.76)
  bgFalloff: 0.12,
  bgPower: 1,
  bgVignette: 0.5
});

/* In your animation loop, call:
   Starfield.update(deltaTimeSeconds);
*/




/* ============================================================================
 * CameraFly v8 — smooth look-target transitions between modes
 * What it does: replaces your entire current CameraFly block. Mode 1 looks at
 * the blue attractor (via setLookTarget), mode 9 looks at AmbientFlow emitter.
 * Switching modes blends camera path AND the look-at target fluently.
 * Keys: 0..9 start modes; ESC stops. Call CameraFly.setLookTarget(attractor).
 * ========================================================================== */
const CameraFly = (() => {
  const s = {
    active: false,
    mode: 0,
    prevMode: 0,
    t: 0,
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(0, 1.0, 0),
    blend: 1,            // 0..1 position blend
    blendDur: 1.25,
    posLerp: 0.18,
    lookLerp: 0.22,

    // look-target smoothing (separate ramp so target doesn’t “jump” on mode switch)
    lookBlend: 1,        // 0..1 look-target blend ramp
    lookBlendDur: 0.8,   // seconds for look-target ramp

    _cancelHandlersAttached: false,
    lookObj: null        // external target for mode 1 (set via setLookTarget)
  };

  const C = new THREE.Vector3(0, 1.0, 0);

  const modes = [
    // 0: top-center vertical sweep
    (t) => {
      const y = 1.6 + 0.9 * Math.sin(t * 0.6);
      return new THREE.Vector3(0, y, 0.0001);
    },
    // 1: low, gentle oval
    (t) => {
      const rX = 3.6, rZ = 4.2, sp = 0.22;
      const ang = t*sp + 0.35*Math.sin(t*0.17);
      const y   = 1.6 + 0.25*Math.sin(t*0.27);
      return new THREE.Vector3(Math.cos(ang)*rX, y, Math.sin(ang)*rZ);
    },
    // 2
    (t) => {
      const rX = 2.2, rZ = 2.8, sp = 0.38;
      const ang = t*sp + 0.6*Math.sin(t*0.11);
      const y   = 1.3 + 0.45*Math.sin(t*0.63)*Math.cos(t*0.21);
      return new THREE.Vector3(Math.cos(ang)*rX, y, Math.sin(ang)*rZ);
    },
    // 3
    (t) => {
      const baseR = 5.2 + 0.6*Math.sin(t*0.20), sp = 0.14;
      const ang = t*sp + 0.25*Math.sin(t*0.07);
      const y   = 2.2 + 0.6*Math.sin(t*0.33);
      return new THREE.Vector3(Math.cos(ang)*baseR, y, Math.sin(ang)*baseR);
    },
    // 4
    (t) => {
      const sp = 0.28, ang = t*sp;
      const ry = 1.8, rz = 3.2;
      const y  = 1.4 + ry*Math.sin(ang);
      const z  =       rz*Math.cos(ang);
      const x  = (0.6 + 0.25*Math.sin(t*0.20)) * Math.cos(ang*2.0 + 0.5*Math.sin(t*0.35));
      return new THREE.Vector3(x, y, z);
    },
    // 5
    (t) => {
      const sp = 0.42, ang = t*sp + 0.2*Math.sin(t*0.5);
      const ry = 1.2, rz = 2.2;
      const y  = 1.2 + ry*Math.sin(ang);
      const z  =       rz*Math.cos(ang);
      const x  = (0.9 + 0.35*Math.sin(t*0.27 + Math.sin(t*0.13))) * Math.sin(ang*2.6 + 0.6*Math.sin(t*0.31));
      return new THREE.Vector3(x, y, z);
    },
    // 6
    (t) => {
      const sp = 0.20, ang = t*sp, pre = 0.35*Math.sin(t*0.15);
      const ry = 2.4 + 0.4*Math.sin(t*0.18);
      const rz = 4.0 + 0.6*Math.sin(t*0.11 + 0.3);
      const y  = 1.6 + ry*Math.sin(ang + pre);
      const z  =       rz*Math.cos(ang - pre);
      const x  = (1.2 + 0.5*Math.sin(t*0.22) + 0.2*Math.sin(t*0.47)) * Math.cos(ang*1.8 + 0.8*Math.sin(t*0.19));
      return new THREE.Vector3(x, y, z);
    },
    // 7
    (t) => {
      const y  = 1.5 + 1.2*Math.sin(t*0.6);
      const r  = 3.4 + 0.4*Math.sin(t*0.21);
      const a  = 0.35*Math.sin(t*0.33);
      const x  = Math.cos(a)*r;
      const z  = Math.sin(a)*r;
      return new THREE.Vector3(x, y, z);
    },
    // 8
    (t) => {
      const r  = 6.4 + 0.7*Math.sin(t*0.18);
      const sp = 0.10;
      const ang = t*sp + 0.45*Math.sin(t*0.09);
      const y  = 1.4 + 0.25*Math.sin(t*0.38);
      return new THREE.Vector3(Math.cos(ang)*r, y, Math.sin(ang)*r);
    },
    // 9
    (t) => {
      const r  = 3.3 + 0.5*Math.sin(t*0.27);
      const sp = 0.26;
      const ang = t*sp + 0.35*Math.sin(t*0.14);
      const y  = 1.2 + 0.5*Math.sin(t*0.52)*Math.cos(t*0.19);
      return new THREE.Vector3(Math.cos(ang)*r, y, Math.sin(ang)*r);
    },
  ];

  const ease = (x) => x<0 ? 0 : x>1 ? 1 : (x<0.5 ? 4*x*x*x : 1 - Math.pow(-2*x+2,3)/2);

  function setLookTarget(obj3D){
    s.lookObj = (obj3D && obj3D.isObject3D) ? obj3D : null;
  }

  function liveTargetFor(mode){
    if (mode === 9 && typeof AmbientFlow !== 'undefined' && AmbientFlow.state?.mesh?.position){
      return AmbientFlow.state.mesh.position;               // red emitter
    }
    if (mode === 1 && s.lookObj){
      return s.lookObj.getWorldPosition ? s.lookObj.getWorldPosition(new THREE.Vector3())
                                        : s.lookObj.position; // blue attractor
                                      }
    return C; // center
  }

  function start(modeIndex) {
    const m = THREE.MathUtils.clamp(modeIndex|0, 0, modes.length-1);

    // reset look-target ramp whenever the destination “kind” changes
    const prevTarget = liveTargetFor(s.active ? s.mode : m);
    const nextTarget = liveTargetFor(m);
    const kindChanged =
      (prevTarget !== nextTarget) ||                             // reference differs (emitter/attractor/center)
      (m === 1 && !s.lookObj) || (m !== 1 && s.mode === 1);      // entering/leaving external look target

      if (!s.active) {
        s.active = true;
        s.mode = m;
        s.prevMode = m;
        s.blend = 1;
        s.lookBlend = 1;
        s.t = 0;
        s.pos.copy(camera.position);
        s.look.copy(liveTargetFor(m));
        if (controls) controls.enabled = false;
        attachCancelHandlers();
        return;
      }

      if (m !== s.mode) {
        s.prevMode = s.mode;
        s.mode = m;
        s.blend = 0;
      s.lookBlend = kindChanged ? 0 : s.lookBlend; // ramp only when target kind changes
    }
  }

  function stop() {
    if (!s.active) return;
    s.active = false;
    s.blend = 1;
    s.lookBlend = 1;
    if (controls) controls.enabled = true;
    detachCancelHandlers();
  }

  function attachCancelHandlers(){
    if (s._cancelHandlersAttached) return;
    s._onPointerDown = () => stop();
    s._onWheel = () => stop();
    renderer.domElement.addEventListener('pointerdown', s._onPointerDown, { passive: true });
    renderer.domElement.addEventListener('wheel', s._onWheel, { passive: true });
    s._cancelHandlersAttached = true;
  }
  function detachCancelHandlers(){
    if (!s._cancelHandlersAttached) return;
    renderer.domElement.removeEventListener('pointerdown', s._onPointerDown);
    renderer.domElement.removeEventListener('wheel', s._onWheel);
    s._cancelHandlersAttached = false;
  }

  function update(dt){
    if (!s.active) return;

    s.t += dt;

    // position path blend
    const pA = modes[s.prevMode](s.t);
    const pB = modes[s.mode](s.t);
    if (s.blend < 1) s.blend = Math.min(1, s.blend + dt / Math.max(0.0001, s.blendDur));
    const a = ease(s.blend);
    const targetPos = pA.lerp(pB, a);

    // look-target ramp (prevents jump to new target when modes switch)
    if (s.lookBlend < 1) s.lookBlend = Math.min(1, s.lookBlend + dt / Math.max(0.0001, s.lookBlendDur));
    const lookRamp = ease(s.lookBlend);

    const liveTarget = liveTargetFor(s.mode);

    // frame-independent lerp factors
    const pl = 1.0 - Math.pow(1.0 - s.posLerp, Math.max(1, Math.round(dt*60)));
    const llBase = 1.0 - Math.pow(1.0 - s.lookLerp, Math.max(1, Math.round(dt*60)));
    // accelerate look smoothing as ramp progresses (starts gentle, then locks)
    const ll = llBase * (0.35 + 0.65 * lookRamp);

    // move + look
    s.pos.lerp(targetPos, pl);
    s.look.lerp(liveTarget, ll);

    camera.position.copy(s.pos);
    camera.lookAt(s.look);

    if (controls && controls.target) controls.target.copy(s.look);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === '0') start(0);
    else if (e.key === '1') start(1);
    else if (e.key === '2') start(2);
    else if (e.key === '3') start(3);
    else if (e.key === '4') start(4);
    else if (e.key === '5') start(5);
    else if (e.key === '6') start(6);
    else if (e.key === '7') start(7);
    else if (e.key === '8') start(8);
    else if (e.key === '9') start(9);
    else if (e.key === 'Escape') stop();
  });

  return { start, stop, update, setLookTarget, state: s };
})();






/* ============================================================================
 * ONE-LINER HOOK (place AFTER initDefaultAttractors() call)
 * Purpose: bind camera mode 1 to follow the blue attractor’s dot. :contentReference[oaicite:4]{index=4}
 * ========================================================================== */
CameraFly.setLookTarget(DEFAULT_ATTRACTOR?.dot || null);



/* Data eraser: localStorage (key/all), IndexedDB, CacheStorage. Returns a summary. */
async function eraseAppData({ clearAllLocalStorage = false, reload = true } = {}) {
  const result = {
    localStorage: { before: 0, after: 0, removedKeys: [], clearedAll: !!clearAllLocalStorage, error: null },
    indexedDB:    { deletedNames: [], error: null },
    caches:       { deletedKeys: [], error: null }
  };

  try { if (typeof persistTimer !== 'undefined') clearTimeout(persistTimer); } catch (_) {}

  try {
    result.localStorage.before = localStorage.length;
    if (clearAllLocalStorage) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
        result.localStorage.removedKeys = keys.slice();
      localStorage.clear();
    } else if (typeof STORAGE_KEY !== 'undefined') {
      if (localStorage.getItem(STORAGE_KEY) !== null) result.localStorage.removedKeys.push(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY);
    }
    result.localStorage.after = localStorage.length;
  } catch (e) { result.localStorage.error = String(e); }

  try {
    if (indexedDB && typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      if (Array.isArray(dbs)) {
        for (const db of dbs) {
          const name = db?.name; if (!name) continue;
          await new Promise((res) => {
            const rq = indexedDB.deleteDatabase(name);
            rq.onsuccess = rq.onerror = rq.onblocked = () => res();
          });
          result.indexedDB.deletedNames.push(name);
        }
      }
    } else {
      const guess = ['localforage','keyval-store','idb-keyval','app-db','threejs-cache'];
      for (const name of guess) {
        await new Promise((res) => {
          const rq = indexedDB.deleteDatabase(name);
          rq.onsuccess = rq.onerror = rq.onblocked = () => res();
        });
      }
      result.indexedDB.deletedNames = guess;
    }
  } catch (e) { result.indexedDB.error = String(e); }

  try {
    if (typeof caches !== 'undefined' && caches?.keys) {
      const keys = await caches.keys();
      for (const k of keys) {
        const ok = await caches.delete(k);
        if (ok) result.caches.deletedKeys.push(k);
      }
    }
  } catch (e) { result.caches.error = String(e); }

  if (reload) location.reload();
  return result;
}



/* ============================================================================
 * lil-gui "Storage" folder with clear/erase action + confirm/prompt/alert UX
 * Place AFTER other GUI folders are created and BEFORE gui.close().
 * Requires: eraseAppData() defined.
 * ========================================================================== */
(function addStorageGui(){
  if (!gui) return;

  async function confirmEraseFlow(){
    // Step 1: confirm intent
    const proceed = confirm(
      'This will remove saved app data.\n\nYou can choose:\n' +
      '• KEY — remove only this app save (recommended)\n' +
      '• ALL — clear ALL localStorage keys\n\nProceed?'
      );
    if (!proceed) return;

    // Step 2: prompt choice
    const choice = (prompt('Type:\n  ALL  → clear ALL localStorage keys\n  KEY  → remove only this app save\n\nEnter your choice:', 'KEY') || '').trim().toUpperCase();
    if (choice !== 'ALL' && choice !== 'KEY') {
      alert('Cancelled: unknown choice. Use ALL or KEY.');
      return;
    }

    const clearAll = (choice === 'ALL');

    // Step 3: execute and show summary (no reload yet)
    const summary = await eraseAppData({ clearAllLocalStorage: clearAll, reload: false });

    // Step 4: result alert + reload ask
    const lines = [
      'Cleanup complete.',
      '',
      `LocalStorage: ${clearAll ? 'CLEARED ALL KEYS' : `Removed [${summary.localStorage.removedKeys.join(', ') || 'none'}]`}`,
      `LocalStorage count: ${summary.localStorage.before} → ${summary.localStorage.after}`,
      `IndexedDB deleted: ${summary.indexedDB.deletedNames.length ? summary.indexedDB.deletedNames.join(', ') : 'none'}`,
      `Caches deleted: ${summary.caches.deletedKeys.length ? summary.caches.deletedKeys.join(', ') : 'none'}`
    ];
    alert(lines.join('\n'));

    // Step 5: final reload confirm
    const reloadNow = confirm('Reload now to apply a fully clean state?');
    if (reloadNow) location.reload();
  }

  const fStorage = gui.addFolder('Storage');
  fStorage.add({ 'Erase / Reset…': confirmEraseFlow }, 'Erase / Reset…').name('Erase / Reset…');
  fStorage.open();
})();








    /** Main frame loop: animation, media updates, audio spectrum. */

let last = performance.now();
let audioVisibilityLevel = 0.0;
let __loggedVideoWarn = false;

function tick(now = performance.now()){
  const dt = (now - last) / 1000; last = now;
  shared.uTime.value += dt;

  // rotating rainbow when no source is active and no texture bound
  const __noMedia = (source.type === "none");
  const __noTex = (sphereMat.uniforms.uUseTex && sphereMat.uniforms.uUseTex.value === 0);
  const __rainbowOn = (__noMedia && __noTex) ? 1 : 0;
  const __rainbowRot = shared.uTime.value * 0.35;
  if (sphereMat.uniforms.uRainbowOn){ sphereMat.uniforms.uRainbowOn.value = __rainbowOn; sphereMat.uniforms.uRainbowRot.value = __rainbowRot; }
  if (reflectMatBottom.uniforms.uRainbowOn){ reflectMatBottom.uniforms.uRainbowOn.value = __rainbowOn; reflectMatBottom.uniforms.uRainbowRot.value = __rainbowRot; }
  if (reflectMatTop.uniforms.uRainbowOn){ reflectMatTop.uniforms.uRainbowOn.value = __rainbowOn; reflectMatTop.uniforms.uRainbowRot.value = __rainbowRot; }
  if (spherePointsMat.uniforms.uRainbowOn){ spherePointsMat.uniforms.uRainbowOn.value = __rainbowOn; spherePointsMat.uniforms.uRainbowRot.value = __rainbowRot; }

  particlesOnFrame(dt);

  updateAttractors(dt);

  Starfield.update(dt);

  const rotDelta = dt * params.rotationSpeed;
  sphere.rotation.y += rotDelta;
  mirrorBottom.rotation.y = sphere.rotation.y;
  mirrorTop.rotation.y = sphere.rotation.y;
  spherePoints.rotation.y = sphere.rotation.y;

  if (analyser && freqData){ analyser.getByteFrequencyData(freqData); }

  if (source.type === "audio"){ drawSpectrumTexture(); }

  updateProbe();

  if (pointsField){
    const pos = pGeo.getAttribute('position');
    const sd  = pGeo.getAttribute('seed');
    const baseSpeed = params.particleSpeedScale, pushStrength = params.particlePushStrength, margin = params.particleMargin;
    const damping = params.particleDamping, swirl = params.particleSwirl;

    for (let i=0;i<P_COUNT;i++){
      const ix=i*3; const px=pos.array[ix], py=pos.array[ix+1], pz=pos.array[ix+2];
      tmp.set(px,py,pz).sub(center);
      const rDist = tmp.length();
      if (rDist>1e-4){
        const n = tmp.multiplyScalar(1.0/rDist);
        const R = displacedRadiusAtDir(n, shared.uTime.value);
        const threshold = R + margin;
        if (rDist < threshold){
          const pen = (threshold - rDist), push = (pen * pushStrength);
          vel[ix]+=n.x*push*dt; vel[ix+1]+=n.y*push*dt*0.4; vel[ix+2]+=n.z*push*dt;
        }
        const tangent = new THREE.Vector3().crossVectors(n, up).normalize();
        vel[ix]+=tangent.x*swirl*dt; vel[ix+1]+=tangent.y*swirl*dt*0.25; vel[ix+2]+=tangent.z*swirl*dt;
        const sp = sd.getY(i), ph = sd.getZ(i) + dt * sp * baseSpeed; sd.setZ(i, ph);
        vel[ix]+=Math.cos(ph*1.3)*0.08*dt; vel[ix+2]+=Math.sin(ph*1.1)*0.08*dt;
      }
      pos.array[ix]+=vel[ix]*dt; pos.array[ix+1]+=vel[ix+1]*dt; pos.array[ix+2]+=vel[ix+2]*dt;
      vel[ix]*=damping; vel[ix+1]*=damping; vel[ix+2]*=damping;
    }
    pos.needsUpdate = true; sd.needsUpdate = true;
  }

  let audioLevel = 0.0;
  if (analyser && freqData){
    let sum=0, n=0; for (let i=8;i<64;i++){ sum+=freqData[i]; n++; }
    audioLevel = (sum / Math.max(1,n)) / 255;

    const p = specGeo.getAttribute('position');
    const c = specGeo.getAttribute('aColor');
    const R = params.spectrumRadius;
    specMat.uniforms.uSize.value = params.spectrumSize;

    for (let i=0;i<BIN_COUNT;i++){
      const a=(i/BIN_COUNT)*Math.PI*2.0, idx=i*3;
      const amp = (freqData[i]||0)/255.0;
      const rAdd = amp * 0.5 * params.spectrumGain;
      const yAdd = amp * params.spectrumHeight;
      const r = R + rAdd;
      p.array[idx+0]=Math.cos(a)*r; p.array[idx+1]=1.15 + yAdd; p.array[idx+2]=Math.sin(a)*r;
      const hue = (i/BIN_COUNT + params.spectrumHueShift) % 1.0;
      const [rr,gg,bb] = hslToRgb(hue, 1.0, THREE.MathUtils.clamp(0.35 + amp*0.5, 0, 1));
      c.array[idx+0]=rr; c.array[idx+1]=gg; c.array[idx+2]=bb;
      specPosLine[idx+0]=p.array[idx+0]; specPosLine[idx+1]=p.array[idx+1]; specPosLine[idx+2]=p.array[idx+2];
      specColLine[idx+0]=rr; specColLine[idx+1]=gg; specColLine[idx+2]=bb;
    }
    p.needsUpdate=true; c.needsUpdate=true;
    specGeoLine.getAttribute('position').needsUpdate=true;
    specGeoLine.getAttribute('color').needsUpdate=true;
  }

  if (params.autoShowBands){
    audioVisibilityLevel = audioVisibilityLevel * params.showSmoothing + audioLevel * (1.0 - params.showSmoothing);
    const show = audioVisibilityLevel > params.showThreshold;
    spectrumPoints.visible = show && (params.spectrumMode === "points");
    spectrumLine.visible   = show && (params.spectrumMode === "line");
  }

  const baseSize = params.pointSize;
  const pcScale = params.pcAudioReact ? (1.0 + params.pcReactAmount * audioLevel) : 1.0;
  spherePointsMat.uniforms.uPointSize.value = baseSize * pcScale;

  if (source.type==="webcam" && source.tex){ source.tex.needsUpdate = true; }
  else if (source.type==="video"){
    if (source.videoEl && videoHasFrame(source.videoEl)){
      if (source.tex) source.tex.needsUpdate = true;
    } else if (!__loggedVideoWarn){ __loggedVideoWarn = true; }
  }

  CameraFly.update(dt);

  if (controls) controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();







/** Dismisses overlay and starts first playlist item. */
/** Hides the overlay safely. */
function hideOverlay(){
  const el = document.querySelector('.ui-overlay');
  if (!el) return;
  el.style.display = 'none';
  el.setAttribute('aria-hidden', 'true');
}

/** Resumes AudioContext (if needed) and hides overlay. */
async function beginFrom(trigger /* "manual" | "webcam" | "image" | "video" | "playlist" | "gesture" */){
await ensureAudioCtx();
if (audioCtx && audioCtx.state === 'suspended'){
  try { await audioCtx.resume(); } catch {}
}
hideOverlay();

  // If the user pressed the Start button, also load the first playlist item
if (trigger === 'manual' && playlist.length){
    // fire and forget; overlay already gone
  loadPlaylistIndex(currentIndex);
}
}

document.getElementById('overlayCTA')?.addEventListener('click', () => beginFrom('manual'));

// const globalUnlock = async () => { await beginFrom('global'); };
// document.addEventListener('pointerdown', globalUnlock, { once:true, passive:true });
// document.addEventListener('keydown', globalUnlock, { once:true });

const searchToggle  = document.getElementById('searchToggle');
const searchPanel   = document.getElementById('searchPanel');
const searchInput   = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

function openSearch(){
  searchPanel.classList.remove('hidden');
  searchInput.value = '';
  renderSearchResults(playlist);
  searchInput.focus();
}
function closeSearch(){
  searchPanel.classList.add('hidden');
  searchInput.blur();
}

function renderSearchResults(items){
  const max = 500;
  searchResults.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < Math.min(items.length, max); i++){
    const it = items[i];
    const li = document.createElement('li');
    li.dataset.ix = String(it.__ix ?? i);
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = it.type;
    const label = document.createElement('span'); label.className = 'label'; label.textContent = it.label;
    li.appendChild(badge); li.appendChild(label);
    li.addEventListener('click', async ()=>{
      const ix = parseInt(li.dataset.ix, 10);
      currentIndex = ix;
      refreshPlaylistSelect();
      await loadPlaylistIndex(ix);
      closeSearch();
    });
    frag.appendChild(li);
  }
  searchResults.appendChild(frag);
}

let _searchTimer = 0;
function doFilter(q){
  const s = q.trim().toLowerCase();
  if (!s){ renderSearchResults(playlist.map((p,i)=>Object.assign({__ix:i},p))); return; }
  const hits = [];
  for (let i=0;i<playlist.length;i++){
    const p = playlist[i];
    const label = (p.label || '').toLowerCase();
    if (label.includes(s)) hits.push(Object.assign({__ix:i}, p));
  }
  renderSearchResults(hits);
}
function debounceFilter(){
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(()=>doFilter(searchInput.value), 120);
}

searchToggle.addEventListener('click', ()=>{
  if (searchPanel.classList.contains('hidden')) openSearch(); else closeSearch();
});
searchInput.addEventListener('input', debounceFilter);

document.addEventListener('keydown', (e)=>{
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey){
    e.preventDefault(); openSearch();
  } else if (e.key === 'Escape'){
    if (!searchPanel.classList.contains('hidden')) closeSearch();
  } else if (e.key === 'Enter' && !searchPanel.classList.contains('hidden')){
    const first = searchResults.querySelector('li');
    if (first) first.click();
  }
});

// keep search list fresh if playlist changes while it’s open
const _origRefresh = refreshPlaylistSelect;
refreshPlaylistSelect = function(){
  _origRefresh();
  if (!searchPanel.classList.contains('hidden')){
    doFilter(searchInput.value);
  }
};



// Mobile UI Toggle Button logic: dispatches an Escape key event (same effect as pressing ESC).
(function setupMobileUiToggle(){
  const btn = document.getElementById('uiToggleBtn');
  if(!btn) return;

  function dispatchEsc(){
    const evInit = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', evInit));
    window.dispatchEvent(new KeyboardEvent('keydown', evInit));
    document.dispatchEvent(new KeyboardEvent('keyup', evInit));
    window.dispatchEvent(new KeyboardEvent('keyup', evInit));
  }

  btn.addEventListener('click', dispatchEsc, { passive: true });
})();



// Shortcuts controller: open/close on button and hotkeys; isolates from app keybindings.
const helpBtn     = document.getElementById('helpBtn');
const helpModal   = document.getElementById('shortcutsModal');
const helpClose   = document.getElementById('helpClose');

function openShortcuts(){
  if (!helpModal) return;
  helpModal.classList.remove('hidden');
}
function closeShortcuts(){
  if (!helpModal) return;
  helpModal.classList.add('hidden');
}
function toggleShortcuts(){
  if (!helpModal) return;
  helpModal.classList.toggle('hidden');
}

// Open/close by mouse/touch
helpBtn?.addEventListener('click', toggleShortcuts);
helpClose?.addEventListener('click', closeShortcuts);
helpModal?.addEventListener('click', (e)=>{ if (e.target === helpModal) closeShortcuts(); });

// Open on '?' or 'Shift+/' ; Close with Esc when panel is open.
// Prevents leaking events to other handlers while open.
document.addEventListener('keydown', (e)=>{
  const key = e.key || e.code || '';
  const isOpen = helpModal && !helpModal.classList.contains('hidden');

  if (!isOpen && (key === '?' || (key === '/' && e.shiftKey))) {
    const t = e.target, tag = t?.tagName?.toUpperCase?.() || '';
    if (t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault(); toggleShortcuts(); return;
  }

  if (isOpen && key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation(); closeShortcuts(); return;
  }

  if (isOpen) {
    e.stopImmediatePropagation();
  }
});



/* Theme init + toggle (dark by default when no saved choice) */
/* Theme init + toggle (dark by default when no saved choice) — REPLACE THIS ENTIRE BLOCK IN player1.js */
(function(){
  const root = document.documentElement;
  const btn  = document.getElementById('themeToggle');
  const icon = btn ? btn.querySelector('img') : null;

  function getSaved(){ try { return localStorage.getItem('theme'); } catch { return null; } }
  function setSaved(v){ try { localStorage.setItem('theme', v); } catch {} }

  function currentTheme(){
    const t = root.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return sysDark ? 'dark' : 'light';
  }

  function applyTheme(t){
    const theme = (t === 'dark' || t === 'light') ? t : 'light';
    root.setAttribute('data-theme', theme);
    setSaved(theme);
    if (icon){
      if (theme === 'dark'){ icon.src = 'static/icons/sun.svg';  icon.alt = 'Light mode'; }
      else                 { icon.src = 'static/icons/moon.svg'; icon.alt = 'Dark mode'; }
    }
    // no src swap for #loginBtn; CSS handles single-asset theming
  }

  const saved = getSaved();
  if (!saved) { root.setAttribute('data-theme','dark'); setSaved('dark'); }
  applyTheme(saved || currentTheme());

  if (btn){
    btn.onclick = () => {
      const next = (currentTheme() === 'dark') ? 'light' : 'dark';
      applyTheme(next);
    };
  }
})();







// Auth + Account UI (no login overlay when already authenticated)
/* Purpose: Manage login with inline errors, keep login overlay hidden once authenticated, use native confirm for logout. */
(() => {
  const qs  = (s, r=document) => r.querySelector(s);
  const qsa = (s, r=document) => Array.from(r.querySelectorAll(s));

  const loginModal   = qs('#loginModal');
  const loginForm    = qs('#loginForm');
  const loginBtn     = qs('#loginBtn');
  const loginClose   = qs('#loginClose');
  const loginError   = qs('#loginError');

  const accountModal = qs('#accountModal');
  const accountClose = qs('#accountClose');
  const acctAvatar   = qs('#acctAvatar');
  const acctName     = qs('#acctName');
  const acctEmail    = qs('#acctEmail');
  const kvName       = qs('#kvName');
  const kvEmail      = qs('#kvEmail');
  const kvJoined     = qs('#kvJoined');
  const albumsList   = qs('#acctAlbums');
  const logoutBtn    = qs('#acctLogoutBtn');

  const tabsRoot     = accountModal ? qs('.acct-tabs', accountModal) : null;
  const tabs         = tabsRoot ? qsa('.acct-tab', tabsRoot) : [];
  const panels       = accountModal ? qsa('.acct-panel', accountModal) : [];

  if (!loginForm || !loginBtn || !loginModal || !accountModal) return;

  async function api(path, opts={}){
    const o = Object.assign({ credentials: 'same-origin' }, opts);
    const res = await fetch(path, o);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json().catch(()=>null) : null;
    if (!res.ok) throw Object.assign(new Error('HTTP '+res.status), { status: res.status, data });
    return data;
  }

  function open(el){ el.classList.remove('hidden'); }
  function close(el){ el.classList.add('hidden'); }

  function updateUserUI(user){
    const name  = user?.name || user?.username || 'User';
    const email = user?.email || '';
    const joined = user?.last_login || user?.created_at || user?.joined || '';
    if (acctAvatar) acctAvatar.src = user?.avatar_url || 'static/icons/user.svg';
    if (acctName)   acctName.textContent = name;
    if (acctEmail)  acctEmail.textContent = email;
    if (kvName)     kvName.textContent = name;
    if (kvEmail)    kvEmail.textContent = email;
    if (kvJoined)   kvJoined.textContent = joined;
  }

  function resetUserUI(){
    if (acctAvatar) acctAvatar.src = 'static/icons/user.svg';
    if (acctName)   acctName.textContent = 'Guest';
    if (acctEmail)  acctEmail.textContent = '';
    if (kvName)     kvName.textContent = '—';
    if (kvEmail)    kvEmail.textContent = '—';
    if (kvJoined)   kvJoined.textContent = '—';
    if (albumsList) albumsList.innerHTML = '';
  }

  async function loadAlbums(){
    if (!albumsList) return;
    albumsList.innerHTML = '';
    let items = [];
    try{
      const data = await api('/me/albums', { method:'GET' });
      items = Array.isArray(data?.albums) ? data.albums : [];
    } catch { items = []; }
    if (items.length === 0){
      const li = document.createElement('li');
      li.textContent = 'No albums';
      albumsList.appendChild(li);
      return;
    }
    for (const a of items){
      const li = document.createElement('li');
      li.className = 'acct-item';
      li.textContent = a.title || a.name || 'Album';
      albumsList.appendChild(li);
    }
  }

  const sessionState = { checked:false, user:null, inflight:null };
  async function ensureSession(){
    if (sessionState.checked) return sessionState.user;
    if (sessionState.inflight) return sessionState.inflight;
    sessionState.inflight = api('/me', { method:'GET' })
      .then(d => d?.user || null)
      .catch(()=>null)
      .then(u => {
        sessionState.user = u;
        sessionState.checked = true;
        sessionState.inflight = null;
        return u;
      });
    return sessionState.inflight;
  }

  function setLoginBtnBehavior(){
    if (!loginBtn) return;
    loginBtn.onclick = async () => {
      const u = sessionState.checked ? sessionState.user : await ensureSession();
      if (u) { updateUserUI(u); open(accountModal); }
      else   { open(loginModal); }
    };
  }

  if (loginClose)   loginClose.addEventListener('click', () => close(loginModal), { passive:true });
  if (accountClose) accountClose.addEventListener('click', () => close(accountModal), { passive:true });
  if (accountModal) accountModal.addEventListener('click', (e)=>{ if (e.target===accountModal) close(accountModal); }, { passive:true });

  if (logoutBtn){
    logoutBtn.addEventListener('click', async () => {
      const ok = window.confirm('Log out from this device?');
      if (!ok) return;
      try { await api('/logout', { method:'POST' }); } catch {}
      resetUserUI();
      sessionState.checked = true;
      sessionState.user = null;
      close(accountModal);
      open(loginModal);
      setLoginBtnBehavior();
    }, { passive:true });
  }

  function showLoginError(msg){
    if (!loginError) return;
    loginError.textContent = msg || 'Invalid email or password.';
    loginError.classList.remove('hidden');
  }
  function clearLoginError(){
    if (!loginError) return;
    loginError.textContent = '';
    loginError.classList.add('hidden');
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearLoginError();
    const fd = new FormData(loginForm);
    try{
      const data = await api('/login', { method:'POST', body: fd });
      const user = data?.user || null;
      if (user){
        updateUserUI(user);
        sessionState.checked = true;
        sessionState.user = user;
        close(loginModal);
        open(accountModal);
        setLoginBtnBehavior();
      } else {
        showLoginError('Invalid email or password.');
      }
    } catch (err){
      const reason = err?.data?.reason;
      if (reason === 'email')         showLoginError('No account with that email.');
      else if (reason === 'password') showLoginError('Wrong password.');
      else                            showLoginError('Invalid email or password.');
    }
  }, { passive:false });

  if (tabsRoot){
    tabs.forEach(tab => {
      tab.addEventListener('click', async () => {
        const id = tab.getAttribute('data-tab');
        if (id === 'logout'){
          const ok = window.confirm('Log out from this device?');
          if (!ok) return;
          try { await api('/logout', { method:'POST' }); } catch {}
          resetUserUI();
          sessionState.checked = true;
          sessionState.user = null;
          close(accountModal);
          open(loginModal);
          setLoginBtnBehavior();
          return;
        }
        tabs.forEach(t => { t.classList.toggle('is-active', t===tab); t.setAttribute('aria-selected', t===tab ? 'true':'false'); });
        panels.forEach(p => p.classList.toggle('is-active', p.id === 'acctPanel-'+id));
        if (id === 'albums') loadAlbums();
      }, { passive:true });
    });
  }

  (async function prime(){
    await ensureSession();                 // detect existing session on load
    setLoginBtnBehavior();                 // if logged in, button opens account overlay; login overlay never shown
  })();
})();


// Albums UI: render grid, create-first tile, empty state placeholders
(() => {
  const qs  = (s, r=document) => r.querySelector(s);
  const qsa = (s, r=document) => Array.from(r.querySelectorAll(s));
  const albumsRoot = qs('#acctAlbums');
  const tabsRoot   = qs('#accountModal .acct-tabs');
  if (!albumsRoot || !tabsRoot) return;

  async function api(path, opts={}){
    const o = Object.assign({ credentials: 'same-origin' }, opts);
    const res = await fetch(path, o);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json().catch(()=>null) : null;
    if (!res.ok) throw Object.assign(new Error('HTTP '+res.status), { status: res.status, data });
    return data;
  }

  function createTileHTML(){
    return `
      <li class="album-card create" id="albumCreateTile" role="button" tabindex="0" aria-label="Create new album">
        <div class="album-cover"><span class="plus">+</span></div>
        <div class="album-title">Create new album</div>
      </li>
    `;
  }

  function cardHTML(a){
    const cover = a?.cover_url ? `<img src="${a.cover_url}" alt="">` : '';
    const title = a?.title || '';
    return `
      <li class="album-card" data-album-id="${a.id}">
        <div class="album-cover">${cover}</div>
        <div class="album-title" title="${title}">${title}</div>
      </li>
    `;
  }

  async function fetchAlbums(){
    try{
      const d = await api('/me/albums', { method:'GET' });
      return Array.isArray(d?.albums) ? d.albums : [];
    }catch{ return []; }
  }

  async function renderAlbums(){
    const albums = await fetchAlbums();
    const hasAny = albums.length > 0;
    const tiles = [createTileHTML()].concat(hasAny ? albums.map(cardHTML) : []).join('');
    albumsRoot.innerHTML = tiles;

    if (!hasAny){
      let ghosts = '';
      for (let i=0;i<7;i++) ghosts += `<li class="album-card ghost"><div class="album-cover"></div><div class="album-title"></div></li>`;
      albumsRoot.insertAdjacentHTML('beforeend', ghosts);
    }

    bindCreate();
    bindCards();
  }

  function bindCreate(){
    const tile = qs('#albumCreateTile', albumsRoot);
    if (!tile) return;
    const create = async () => {
      const t = window.prompt('Album title:');
      if (!t) return;
      try{
        await api('/me/albums', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: t.trim() })
        });
        await renderAlbums();
      }catch{}
    };
    tile.addEventListener('click', create, { passive:true });
    tile.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); create(); }
    });
  }

  function bindCards(){
    qsa('.album-card:not(.create):not(.ghost)', albumsRoot).forEach(li => {
      li.addEventListener('click', () => {
        const id = li.getAttribute('data-album-id');
        // reserved for future detail view
      }, { passive:true });
    });
  }

  qsa('.acct-tab', tabsRoot).forEach(tab => {
    tab.addEventListener('click', async () => {
      if (tab.getAttribute('data-tab') === 'albums') await renderAlbums();
    }, { passive:true });
  });

  const active = qs('.acct-tab.is-active', tabsRoot);
  if (active && active.getAttribute('data-tab') === 'albums') renderAlbums();
})();




// // Album Editor: picker + tracks + save + player interop (sanitized paths, no 404 loops, verbose logs)
// (() => {
//   const qs=(s,r=document)=>r.querySelector(s); const qsa=(s,r=document)=>Array.from(r.querySelectorAll(s));
//   const editor = qs('#albumEditor'); if(!editor) return;

//   const appDiv = qs('#app');
//   const BASE = (appDiv?.dataset.base || 'media/archives').replace(/\/+$/,'');
//   const LOG = (...a)=>console.log('[AlbumEditor]', ...a);
//   const WARN = (...a)=>console.warn('[AlbumEditor]', ...a);
//   const ERR = (...a)=>console.error('[AlbumEditor]', ...a);

//   // DOM
//   const form = qs('#albumEditorForm', editor);
//   const panel = qs('.help-panel', editor);
//   const closeBtn = qs('#albumEditorClose', editor);
//   const coverImg = qs('#aeCoverImg', editor);
//   const coverUrl = qs('#aeCoverUrl', editor);
//   const coverFile= qs('#aeCoverFile', editor);
//   const aeId     = qs('#aeId', editor);
//   const aeTitle  = qs('#aeTitle', editor);
//   const aeDesc   = qs('#aeDesc', editor);
//   const aeVis    = qs('#aeVisibility', editor);
//   const infoToggle = qs('#aeInfoToggle', editor);

//   const tracksBox = qs('#aeTracks', editor);
//   const addTracksBtn = qs('#aeAddTracks', editor);

//   const picker = qs('#aePicker', editor);
//   const search = qs('#aeSearch', editor);
//   const results= qs('#aeResults', editor);
//   const pickClose= qs('#aePickerClose', editor);

//   const albumsRoot = qs('#acctAlbums');

//   // HTTP
//   const api = async (path, opts={})=>{
//     const o = Object.assign({ credentials:'same-origin' }, opts);
//     const res = await fetch(path, o);
//     const ct = res.headers.get('content-type')||'';
//     const data = ct.includes('application/json') ? await res.json().catch(()=>null) : null;
//     if(!res.ok) throw Object.assign(new Error('HTTP '+res.status), {status:res.status, data});
//     return data;
//   };

//   // Utils
//   function open(el){ el.classList.remove('hidden'); }
//   function close(el){ el.classList.add('hidden'); }
//   function setCover(src){ coverImg.src = src || ''; }
//   function encodePath(p){ return p.split('/').map(encodeURIComponent).join('/'); }
//   function resolveUrl(u){ try{ return new URL(u, location.href).href; }catch{ return u; } }
//   function buildUrl(rel){ return `${BASE}/${encodePath(rel)}`; }
//   function hasMediaExt(p){
//     const ext = (p.split('.').pop()||'').toLowerCase();
//     return ['mp3','wav','ogg','m4a','flac','aac','mp4','webm','ogv','mov','m4v','m3u8','mpd','jpg','jpeg','png','gif','webp','bmp'].includes(ext);
//   }
//   function sanitizePath(raw){
//     if (!raw) return '';
//     let s = String(raw)
//       .replace(/^[\s\u2500-\u257F|>]+/g,'')
//       .replace(/^(├─*|└─*|─+|┌─*|│)+\s*/g,'')
//       .replace(/\s{2,}/g,' ')
//       .trim();
//     if (s.endsWith('/')) return '';
//     return s;
//   }
//   function mediaTypeFromExt(path){
//     const ext = (path.split('.').pop()||'').toLowerCase();
//     if (['mp3','wav','ogg','m4a','flac','aac'].includes(ext)) return 'audio';
//     if (['mp4','webm','ogv','mov','m4v'].includes(ext))       return 'video';
//     if (['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) return 'image';
//     if (ext === 'm3u8') return 'hls';
//     if (ext === 'mpd')  return 'dash';
//     return 'audio';
//   }

//   // Library
//   const libState = { ready:false, items:[], filtered:[] };
//   async function ensureLibrary(){
//     if (libState.ready) return libState.items;
//     const url = appDiv?.dataset.tree;
//     if (!url) { libState.ready=true; libState.items=[]; return libState.items; }
//     const text = await fetch(url, { credentials:'same-origin', cache:'no-store' }).then(r=>r.text());
//     let files = [];
//     if (typeof parseTreeToFiles === 'function') {
//       files = parseTreeToFiles(text);
//     } else {
//       files = text.split(/\r?\n/).map(s=>sanitizePath(s)).filter(Boolean).filter(hasMediaExt);
//     }
//     libState.items = files.map(p=>({ path:p, label:(p.split('/').pop()||p) }));
//     libState.ready = true;
//     LOG('library loaded', libState.items.length, 'items');
//     return libState.items;
//   }

//   // State
//   const state = {
//     tracks: [],          // [{label, path}]
//     current: null,
//     dirty: false,
//     playingUrl: null
//   };
//   function markDirty(){ state.dirty = true; }

//   // Dirty guard
//   ['input','change','keyup','paste'].forEach(ev=>{
//     form.addEventListener(ev, (e)=>{
//       if (e.target && (e.target.closest('#albumEditorForm') || e.target.closest('#aePicker'))) markDirty();
//     }, { passive:true });
//   });
//   window.addEventListener('beforeunload', (e)=>{
//     if (state.dirty){ e.preventDefault(); e.returnValue=''; }
//   });
//   function requestClose(){
//     if (!state.dirty) { close(editor); return; }
//     if (window.confirm('Discard unsaved changes?')){ state.dirty=false; close(editor); }
//   }
//   closeBtn.addEventListener('click', requestClose, { passive:true });
//   editor.addEventListener('click', (e)=>{ if (e.target===editor) requestClose(); }, { passive:true });
//   editor.addEventListener('keydown', (e)=>{ if (e.key==='Escape'){ e.stopPropagation(); requestClose(); } }, { passive:false });

//   // Tracks render
//   function renderTracks(list){
//     tracksBox.innerHTML = '';
//     list.forEach((t,idx)=>{
//       const rel = sanitizePath(t.path);
//       if (!rel) return;
//       const url = buildUrl(rel);
//       const isPlaying = (state.playingUrl && resolveUrl(state.playingUrl) === resolveUrl(url));

//       const li = document.createElement('div');
//       li.className = 'ae-track'; li.draggable = true;
//       li.dataset.idx = String(idx);
//       li.dataset.path = rel;

//       li.innerHTML = `
//         <div class="grip">⋮⋮</div>
//         <div class="title" title="${t.label}">${String(idx+1).padStart(2,'0')}. ${t.label}</div>
//         <div class="ae-row-actions">
//           <button class="play" type="button">${isPlaying ? 'PLAYING' : 'Play'}</button>
//           <button class="rm" type="button">Remove</button>
//         </div>
//       `;
//       tracksBox.appendChild(li);
//     });
//     bindDnD(); bindTrackRowActions();
//   }

//   // Track row actions
//   function bindTrackRowActions(){
//     qsa('.ae-track', tracksBox).forEach(li=>{
//       const idx = Number(li.dataset.idx);
//       const rel = String(li.dataset.path||'');
//       const url = buildUrl(rel);
//       const playBtn = li.querySelector('.play');
//       const rmBtn   = li.querySelector('.rm');

//       playBtn.addEventListener('click', async (e)=>{
//         e.stopPropagation();
//         await playUrl(url, { origin:'tracks', idx });
//         refreshPlayingUI();
//       }, { passive:false });

//       rmBtn.addEventListener('click', ()=>{
//         state.tracks.splice(idx,1);
//         markDirty();
//         renderTracks(state.tracks);
//       }, { passive:true });
//     });
//   }

//   // DnD
//   function bindDnD(){
//     let src=null;
//     tracksBox.addEventListener('dragstart',e=>{
//       const li = e.target.closest('.ae-track'); if(!li) return;
//       src = Number(li.dataset.idx); e.dataTransfer.effectAllowed='move';
//     });
//     tracksBox.addEventListener('dragover',e=>{
//       if(src==null) return; e.preventDefault(); e.dataTransfer.dropEffect='move';
//     });
//     tracksBox.addEventListener('drop',e=>{
//       if(src==null) return; e.preventDefault();
//       const li = e.target.closest('.ae-track'); if(!li) return;
//       const dst = Number(li.dataset.idx);
//       if (dst===src) { src=null; return; }
//       const item = state.tracks.splice(src,1)[0];
//       state.tracks.splice(dst,0,item);
//       src=null; markDirty(); renderTracks(state.tracks);
//     });
//     tracksBox.addEventListener('dragend',()=>{ src=null; });
//   }

//   // Picker
//   function openPicker(){ open(picker); search.value=''; renderResults(libState.items); search.focus(); }
//   function closePicker(){ close(picker); }

//   function isInTracks(rel){ return state.tracks.some(t => sanitizePath(t.path) === sanitizePath(rel)); }

//   function renderResults(list){
//     results.innerHTML = '';
//     list.forEach((it)=>{
//       const rel = sanitizePath(it.path);
//       if (!rel || !hasMediaExt(rel)) return;

//       const url = buildUrl(rel);
//       const isDup = isInTracks(rel);
//       const isPlaying = (state.playingUrl && resolveUrl(state.playingUrl) === resolveUrl(url));

//       const li = document.createElement('li');
//       li.dataset.path = rel;
//       if (isPlaying) li.classList.add('is-playing');
//       li.innerHTML = `
//         <div class="title" title="${rel}">${it.label}</div>
//         <div class="ae-row-actions">
//           <button class="play" type="button">${isPlaying ? 'PLAYING' : 'Play'}</button>
//           <button class="add" type="button" ${isDup ? 'disabled' : ''}>${isDup ? 'ADDED' : 'ADD'}</button>
//         </div>
//       `;

//       const playBtn = li.querySelector('.play');
//       const addBtn  = li.querySelector('.add');

//       li.addEventListener('click', (e)=>{
//         if (e.target === playBtn || e.target === addBtn) return;
//         if (!isInTracks(rel)){
//           state.tracks.push({ label: it.label, path: rel });
//           markDirty();
//           renderTracks(state.tracks);
//           addBtn.disabled = true; addBtn.textContent = 'ADDED';
//         }
//       }, { passive:true });

//       playBtn.addEventListener('click', async (e)=>{
//         e.stopPropagation();
//         await playUrl(url, { origin:'picker' });
//         refreshPlayingUI();
//       }, { passive:false });

//       addBtn.addEventListener('click', (e)=>{
//         e.stopPropagation();
//         if (addBtn.disabled) return;
//         state.tracks.push({ label: it.label, path: rel });
//         markDirty();
//         renderTracks(state.tracks);
//         addBtn.disabled = true; addBtn.textContent = 'ADDED';
//       }, { passive:true });

//       results.appendChild(li);
//     });
//   }

//   search.addEventListener('input', ()=>{
//     const q = search.value.trim().toLowerCase();
//     libState.filtered = !q ? libState.items :
//       libState.items.filter(it => {
//         const rel = sanitizePath(it.path);
//         return rel && (it.label.toLowerCase().includes(q) || rel.toLowerCase().includes(q));
//       });
//     renderResults(libState.filtered);
//   });
//   pickClose.addEventListener('click', ()=> closePicker(), { passive:true });
//   addTracksBtn.addEventListener('click', async ()=>{ await ensureLibrary(); openPicker(); }, { passive:true });

//   // Info
//   infoToggle.addEventListener('click', ()=>{
//     const expanded = infoToggle.getAttribute('aria-expanded') === 'true';
//     infoToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
//     aeDesc.style.display = expanded ? 'none' : 'block';
//     infoToggle.textContent = expanded ? 'Expand' : 'Collapse';
//     markDirty();
//   }, { passive:true });

//   // Cover URL
//   coverUrl.addEventListener('change', async ()=>{
//     const src = coverUrl.value.trim();
//     setCover(src);
//     markDirty();
//     const id = aeId.value;
//     if (!id) return;
//     try{
//       await api(`/me/albums/${encodeURIComponent(id)}`, {
//         method:'POST',
//         headers:{ 'Content-Type': 'application/json' },
//         body: JSON.stringify({ cover_url: src })
//       });
//       state.dirty = false;
//     }catch{}
//   }, { passive:true });

//   // Cover upload
//   coverFile.addEventListener('change', async ()=>{
//     const f = coverFile.files && coverFile.files[0]; if(!f) return;
//     const id = aeId.value; if(!id) return;
//     const fd = new FormData(); fd.append('file', f);
//     try{
//       const d = await api(`/me/albums/${encodeURIComponent(id)}/cover`, { method:'POST', body: fd });
//       setCover(d?.cover_url || '');
//       coverUrl.value = d?.cover_url || '';
//       state.dirty = false;
//     }catch{}
//   });

//   // Save
//   form.addEventListener('submit', async (e)=>{
//     e.preventDefault();
//     const albumId = aeId.value;
//     const cleanTracks = state.tracks
//       .map(t => ({ label: t.label, path: sanitizePath(t.path) }))
//       .filter(t => t.path && hasMediaExt(t.path));
//     const body = {
//       title: aeTitle.value.trim(),
//       description_md: aeDesc.value,
//       visibility: aeVis.value,
//       cover_url: coverImg.src || coverUrl.value || '',
//       metadata: { tracks: cleanTracks }
//     };
//     try{
//       await api(`/me/albums/${encodeURIComponent(albumId)}`, {
//         method:'POST',
//         headers:{ 'Content-Type': 'application/json' },
//         body: JSON.stringify(body)
//       });
//       state.dirty = false;
//       close(editor);
//       document.dispatchEvent(new CustomEvent('albums:refresh'));
//     }catch(err){
//       ERR('save failed', err);
//       alert('Save failed.');
//     }
//   }, { passive:false });

//   // Load album
//   async function loadAlbum(id){
//     const { album } = await api(`/me/albums/${encodeURIComponent(id)}`, { method:'GET' });
//     state.current = album;
//     aeId.value = album.id;
//     aeTitle.value = album.title || '';
//     aeDesc.value = album.description_md || '';
//     aeVis.value = album.visibility || 'private';
//     coverUrl.value = album.cover_url || '';
//     setCover(album.cover_url || '');

//     const tr = (album.metadata && Array.isArray(album.metadata.tracks)) ? album.metadata.tracks : [];
//     state.tracks = tr.map(t => {
//       const rel = sanitizePath(t.path || '');
//       const label = t.label || (rel.split('/').pop() || 'Track');
//       return { label, path: rel };
//     }).filter(x => x.path);
//     state.dirty = false;
//     renderTracks(state.tracks);
//     refreshPlayingUI();
//     LOG('album loaded', album.id, 'tracks:', state.tracks.length);
//   }

//   // Open editor from albums grid
//   if (albumsRoot){
//     albumsRoot.addEventListener('click', async (e)=>{
//       const li = e.target.closest('.album-card');
//       if (!li || li.classList.contains('create') || li.classList.contains('ghost')) return;
//       const id = li.getAttribute('data-album-id');
//       if (!id) return;
//       await loadAlbum(id);
//       open(editor);
//     }, { passive:true });
//   }

//   // Refresh albums grid after save
//   document.addEventListener('albums:refresh', async ()=>{
//     const tab = qs('.acct-tab[data-tab="albums"]');
//     if (tab) tab.click();
//   }, { passive:true });

//   // Player
//   async function headOk(url){
//     try{
//       const r = await fetch(url, { method:'HEAD', cache:'no-store' });
//       return r.ok;
//     }catch(e){
//       return false;
//     }
//   }

//   async function playUrl(url, ctx={}){
//     const hookOk = (typeof loadPlaylistIndex === 'function') && Array.isArray(playlist);
//     if (!hookOk){
//       WARN('no compatible player hook found', { hasLoad: typeof loadPlaylistIndex, hasPlaylist: Array.isArray(playlist) });
//       return;
//     }

//     const abs = resolveUrl(url);
//     LOG('play request', { from: ctx.origin||'unknown', url: abs });

//     const ok = await headOk(abs);
//     if (!ok){
//       WARN('HEAD 404, aborting play (no retry loop)', abs);
//       return;
//     }

//     // Same as current? just repaint UI.
//     if (state.playingUrl && resolveUrl(state.playingUrl) === abs){
//       refreshPlayingUI();
//       return;
//     }

//     // Ensure playlist entry exists
//     let idx = playlist.findIndex(p => resolveUrl(p.url) === abs);
//     if (idx === -1){
//       const label = decodeURIComponent(abs.split('/').pop() || 'Track');
//       playlist.push({ type: mediaTypeFromExt(abs), label, url: abs });
//       if (typeof refreshPlaylistSelect === 'function') refreshPlaylistSelect();
//       idx = playlist.length - 1;
//       LOG('appended temp playlist entry', { idx, label });
//     }

//     try{
//       const okLoad = await loadPlaylistIndex(idx);
//       if (okLoad === false){ WARN('loadPlaylistIndex returned false', { idx, url: abs }); return; }
//       state.playingUrl = abs;
//       refreshPlayingUI();
//       LOG('playing', { idx, url: abs });
//     }catch(err){
//       ERR('play failed', err);
//     }
//   }

//   // PLAY/PLAYING repaint
//   function refreshPlayingUI(){
//     qsa('#aeResults li', editor).forEach(li=>{
//       const rel = String(li.dataset.path||'');
//       const url = buildUrl(rel);
//       const on = state.playingUrl && resolveUrl(url) === resolveUrl(state.playingUrl);
//       const playBtn = li.querySelector('.play');
//       li.classList.toggle('is-playing', !!on);
//       if (playBtn) playBtn.textContent = on ? 'PLAYING' : 'Play';
//     });
//     qsa('.ae-track', tracksBox).forEach(li=>{
//       const rel = String(li.dataset.path||'');
//       const url = buildUrl(rel);
//       const on = state.playingUrl && resolveUrl(url) === resolveUrl(state.playingUrl);
//       const btn = li.querySelector('.play');
//       if (btn) btn.textContent = on ? 'PLAYING' : 'Play';
//     });
//   }
// })();


// // Album Editor: picker + tracks + save + player interop (sanitized paths, no 404 loops, verbose logs)
// (() => {
//   const qs=(s,r=document)=>r.querySelector(s); const qsa=(s,r=document)=>Array.from(r.querySelectorAll(s));
//   const editor = qs('#albumEditor'); if(!editor) return;

//   const appDiv = qs('#app');
//   const BASE = (appDiv?.dataset.base || 'media/archives').replace(/\/+$/,'');
//   const LOG = (...a)=>console.log('[AlbumEditor]', ...a);
//   const WARN = (...a)=>console.warn('[AlbumEditor]', ...a);
//   const ERR = (...a)=>console.error('[AlbumEditor]', ...a);

//   // DOM
//   const form = qs('#albumEditorForm', editor);
//   const panel = qs('.help-panel', editor);
//   const closeBtn = qs('#albumEditorClose', editor);
//   const coverImg = qs('#aeCoverImg', editor);
//   const coverUrl = qs('#aeCoverUrl', editor);
//   const coverFile= qs('#aeCoverFile', editor);
//   const aeId     = qs('#aeId', editor);
//   const aeTitle  = qs('#aeTitle', editor);
//   const aeDesc   = qs('#aeDesc', editor);
//   const aeVis    = qs('#aeVisibility', editor);
//   const infoToggle = qs('#aeInfoToggle', editor);

//   const tracksBox = qs('#aeTracks', editor);
//   const addTracksBtn = qs('#aeAddTracks', editor);

//   const picker = qs('#aePicker', editor);
//   const search = qs('#aeSearch', editor);
//   const results= qs('#aeResults', editor);
//   const pickClose= qs('#aePickerClose', editor);

//   const albumsRoot = qs('#acctAlbums');

//   async function api(path, opts={}){
//     const o = Object.assign({ credentials:'same-origin' }, opts);
//     const res = await fetch(path, o);
//     const ct = res.headers.get('content-type')||'';
//     const data = ct.includes('application/json') ? await res.json().catch(()=>null) : null;
//     if(!res.ok) throw Object.assign(new Error('HTTP '+res.status), {status:res.status, data});
//     return data;
//   }

//   // Purpose: Generate a self-contained SVG cover when none is set; avoids empty <img src="">
//   function genDefaultCover(title='Album'){
//     const t = (title || 'Album').slice(0, 2).toUpperCase();
//     const hue = Math.abs([...title].reduce((a,c)=>a+c.charCodeAt(0),0)) % 360;
//     const h2  = (hue + 35) % 360;
//     const svg =
//       `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
//         <defs>
//           <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
//             <stop offset="0%" stop-color="hsl(${hue},70%,45%)"/>
//             <stop offset="100%" stop-color="hsl(${h2},70%,55%)"/>
//           </linearGradient>
//         </defs>
//         <rect width="640" height="640" fill="url(#g)"/>
//         <circle cx="320" cy="320" r="220" fill="rgba(255,255,255,0.12)"/>
//         <text x="50%" y="54%" text-anchor="middle" font-family="system-ui, sans-serif" font-size="200" font-weight="700" fill="rgba(255,255,255,0.9)">${t}</text>
//       </svg>`;
//     return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
//   }

//   function open(el){ el.classList.remove('hidden'); }
//   function close(el){ el.classList.add('hidden'); }
//   function setCover(src, title){
//     const safe = (src && src.trim()) ? src : genDefaultCover(title || aeTitle?.value || 'Album');
//     coverImg.src = safe;
//   }
//   function encodePath(p){ return p.split('/').map(encodeURIComponent).join('/'); }
//   function resolveUrl(u){ try{ return new URL(u, location.href).href; }catch{ return u; } }
//   function buildUrl(rel){ return `${BASE}/${encodePath(rel)}`; }
//   function hasMediaExt(p){
//     const ext = (p.split('.').pop()||'').toLowerCase();
//     return ['mp3','wav','ogg','m4a','flac','aac','mp4','webm','ogv','mov','m4v','m3u8','mpd','jpg','jpeg','png','gif','webp','bmp'].includes(ext);
//   }
//   function sanitizePath(raw){
//     if (!raw) return '';
//     let s = String(raw)
//       .replace(/^[\s\u2500-\u257F|>]+/g,'')
//       .replace(/^(├─*|└─*|─+|┌─*|│)+\s*/g,'')
//       .replace(/\s{2,}/g,' ')
//       .trim();
//     if (s.endsWith('/')) return '';
//     return s;
//   }
//   function mediaTypeFromExt(path){
//     const ext = (path.split('.').pop()||'').toLowerCase();
//     if (['mp3','wav','ogg','m4a','flac','aac'].includes(ext)) return 'audio';
//     if (['mp4','webm','ogv','mov','m4v'].includes(ext))       return 'video';
//     if (['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) return 'image';
//     if (ext === 'm3u8') return 'hls';
//     if (ext === 'mpd')  return 'dash';
//     return 'audio';
//   }

//   const libState = { ready:false, items:[], filtered:[] };
//   async function ensureLibrary(){
//     if (libState.ready) return libState.items;
//     const url = appDiv?.dataset.tree;
//     if (!url) { libState.ready=true; libState.items=[]; return libState.items; }
//     const text = await fetch(url, { credentials:'same-origin', cache:'no-store' }).then(r=>r.text());
//     let files = [];
//     if (typeof parseTreeToFiles === 'function') {
//       files = parseTreeToFiles(text);
//     } else {
//       files = text.split(/\r?\n/).map(s=>sanitizePath(s)).filter(Boolean).filter(hasMediaExt);
//     }
//     libState.items = files.map(p=>({ path:p, label:(p.split('/').pop()||p) }));
//     libState.ready = true;
//     LOG('library loaded', libState.items.length, 'items');
//     return libState.items;
//   }

//   const state = { tracks: [], current: null, dirty: false, playingUrl: null };
//   function markDirty(){ state.dirty = true; }

//   ['input','change','keyup','paste'].forEach(ev=>{
//     form.addEventListener(ev, (e)=>{
//       if (e.target && (e.target.closest('#albumEditorForm') || e.target.closest('#aePicker'))) markDirty();
//     }, { passive:true });
//   });
//   window.addEventListener('beforeunload', (e)=>{
//     if (state.dirty){ e.preventDefault(); e.returnValue=''; }
//   });
//   function requestClose(){
//     if (!state.dirty) { close(editor); return; }
//     if (window.confirm('Discard unsaved changes?')){ state.dirty=false; close(editor); }
//   }
//   closeBtn.addEventListener('click', requestClose, { passive:true });
//   editor.addEventListener('click', (e)=>{ if (e.target===editor) requestClose(); }, { passive:true });
//   editor.addEventListener('keydown', (e)=>{ if (e.key==='Escape'){ e.stopPropagation(); requestClose(); } }, { passive:false });

//   function renderTracks(list){
//     tracksBox.innerHTML = '';
//     list.forEach((t,idx)=>{
//       const rel = sanitizePath(t.path);
//       if (!rel) return;
//       const url = buildUrl(rel);
//       const isPlaying = (state.playingUrl && resolveUrl(state.playingUrl) === resolveUrl(url));
//       const li = document.createElement('div');
//       li.className = 'ae-track'; li.draggable = true;
//       li.dataset.idx = String(idx);
//       li.dataset.path = rel;
//       li.innerHTML = `
//         <div class="grip">⋮⋮</div>
//         <div class="title" title="${t.label}">${String(idx+1).padStart(2,'0')}. ${t.label}</div>
//         <div class="ae-row-actions">
//           <button class="play" type="button">${isPlaying ? 'PLAYING' : 'Play'}</button>
//           <button class="rm" type="button">Remove</button>
//         </div>
//       `;
//       tracksBox.appendChild(li);
//     });
//     bindDnD(); bindTrackRowActions();
//   }

//   function bindTrackRowActions(){
//     qsa('.ae-track', tracksBox).forEach(li=>{
//       const idx = Number(li.dataset.idx);
//       const rel = String(li.dataset.path||'');
//       const url = buildUrl(rel);
//       const playBtn = li.querySelector('.play');
//       const rmBtn   = li.querySelector('.rm');
//       playBtn.addEventListener('click', async (e)=>{
//         e.stopPropagation();
//         await playUrl(url, { origin:'tracks', idx });
//         refreshPlayingUI();
//       }, { passive:false });
//       rmBtn.addEventListener('click', ()=>{
//         state.tracks.splice(idx,1);
//         markDirty();
//         renderTracks(state.tracks);
//       }, { passive:true });
//     });
//   }

//   function bindDnD(){
//     let src=null;
//     tracksBox.addEventListener('dragstart',e=>{
//       const li = e.target.closest('.ae-track'); if(!li) return;
//       src = Number(li.dataset.idx); e.dataTransfer.effectAllowed='move';
//     });
//     tracksBox.addEventListener('dragover',e=>{
//       if(src==null) return; e.preventDefault(); e.dataTransfer.dropEffect='move';
//     });
//     tracksBox.addEventListener('drop',e=>{
//       if(src==null) return; e.preventDefault();
//       const li = e.target.closest('.ae-track'); if(!li) return;
//       const dst = Number(li.dataset.idx);
//       if (dst===src) { src=null; return; }
//       const item = state.tracks.splice(src,1)[0];
//       state.tracks.splice(dst,0,item);
//       src=null; markDirty(); renderTracks(state.tracks);
//     });
//     tracksBox.addEventListener('dragend',()=>{ src=null; });
//   }

//   function openPicker(){ open(picker); search.value=''; renderResults(libState.items); search.focus(); }
//   function closePicker(){ close(picker); }
//   function isInTracks(rel){ return state.tracks.some(t => sanitizePath(t.path) === sanitizePath(rel)); }

//   function renderResults(list){
//     results.innerHTML = '';
//     list.forEach((it)=>{
//       const rel = sanitizePath(it.path);
//       if (!rel || !hasMediaExt(rel)) return;
//       const url = buildUrl(rel);
//       const isDup = isInTracks(rel);
//       const isPlaying = (state.playingUrl && resolveUrl(state.playingUrl) === resolveUrl(url));
//       const li = document.createElement('li');
//       li.dataset.path = rel;
//       if (isPlaying) li.classList.add('is-playing');
//       li.innerHTML = `
//         <div class="title" title="${rel}">${it.label}</div>
//         <div class="ae-row-actions">
//           <button class="play" type="button">${isPlaying ? 'PLAYING' : 'Play'}</button>
//           <button class="add" type="button" ${isDup ? 'disabled' : ''}>${isDup ? 'ADDED' : 'ADD'}</button>
//         </div>
//       `;
//       const playBtn = li.querySelector('.play');
//       const addBtn  = li.querySelector('.add');
//       li.addEventListener('click', (e)=>{
//         if (e.target === playBtn || e.target === addBtn) return;
//         if (!isInTracks(rel)){
//           state.tracks.push({ label: it.label, path: rel });
//           markDirty();
//           renderTracks(state.tracks);
//           addBtn.disabled = true; addBtn.textContent = 'ADDED';
//         }
//       }, { passive:true });
//       playBtn.addEventListener('click', async (e)=>{
//         e.stopPropagation();
//         await playUrl(url, { origin:'picker' });
//         refreshPlayingUI();
//       }, { passive:false });
//       addBtn.addEventListener('click', (e)=>{
//         e.stopPropagation();
//         if (addBtn.disabled) return;
//         state.tracks.push({ label: it.label, path: rel });
//         markDirty();
//         renderTracks(state.tracks);
//         addBtn.disabled = true; addBtn.textContent = 'ADDED';
//       }, { passive:true });
//       results.appendChild(li);
//     });
//   }

//   search.addEventListener('input', ()=>{
//     const q = search.value.trim().toLowerCase();
//     libState.filtered = !q ? libState.items :
//       libState.items.filter(it => {
//         const rel = sanitizePath(it.path);
//         return rel && (it.label.toLowerCase().includes(q) || rel.toLowerCase().includes(q));
//       });
//     renderResults(libState.filtered);
//   });
//   pickClose.addEventListener('click', ()=> closePicker(), { passive:true });
//   addTracksBtn.addEventListener('click', async ()=>{ await ensureLibrary(); openPicker(); }, { passive:true });

//   infoToggle.addEventListener('click', ()=>{
//     const expanded = infoToggle.getAttribute('aria-expanded') === 'true';
//     infoToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
//     aeDesc.style.display = expanded ? 'none' : 'block';
//     infoToggle.textContent = expanded ? 'Expand' : 'Collapse';
//     markDirty();
//   }, { passive:true });

//   coverUrl.addEventListener('change', async ()=>{
//     const src = coverUrl.value.trim();
//     setCover(src, aeTitle.value);
//     markDirty();
//     const id = aeId.value; if (!id) return;
//     try{
//       await api(`/me/albums/${encodeURIComponent(id)}`, {
//         method:'POST',
//         headers:{ 'Content-Type': 'application/json' },
//         body: JSON.stringify({ cover_url: src })
//       });
//       state.dirty = false;
//     }catch{}
//   }, { passive:true });

//   coverFile.addEventListener('change', async ()=>{
//     const f = coverFile.files && coverFile.files[0]; if(!f) return;
//     const id = aeId.value; if(!id) return;
//     const fd = new FormData(); fd.append('file', f);
//     try{
//       const d = await api(`/me/albums/${encodeURIComponent(id)}/cover`, { method:'POST', body: fd });
//       setCover(d?.cover_url || '', aeTitle.value);
//       coverUrl.value = d?.cover_url || '';
//       state.dirty = false;
//     }catch{}
//   });

//   form.addEventListener('submit', async (e)=>{
//     e.preventDefault();
//     const albumId = aeId.value;
//     const cleanTracks = state.tracks
//       .map(t => ({ label: t.label, path: sanitizePath(t.path) }))
//       .filter(t => t.path && hasMediaExt(t.path));
//     const body = {
//       title: aeTitle.value.trim(),
//       description_md: aeDesc.value,
//       visibility: aeVis.value,
//       cover_url: coverImg.src || coverUrl.value || '',
//       metadata: { tracks: cleanTracks }
//     };
//     try{
//       await api(`/me/albums/${encodeURIComponent(albumId)}`, {
//         method:'POST',
//         headers:{ 'Content-Type': 'application/json' },
//         body: JSON.stringify(body)
//       });
//       state.dirty = false;
//       close(editor);
//       document.dispatchEvent(new CustomEvent('albums:refresh'));
//     }catch(err){
//       ERR('save failed', err);
//       alert('Save failed.');
//     }
//   }, { passive:false });

//   async function loadAlbum(id){
//     const { album } = await api(`/me/albums/${encodeURIComponent(id)}`, { method:'GET' });
//     state.current = album;
//     aeId.value = album.id;
//     aeTitle.value = album.title || '';
//     aeDesc.value = album.description_md || '';
//     aeVis.value = album.visibility || 'private';
//     coverUrl.value = album.cover_url || '';
//     setCover(album.cover_url || '', album.title);
//     const tr = (album.metadata && Array.isArray(album.metadata.tracks)) ? album.metadata.tracks : [];
//     state.tracks = tr.map(t => {
//       const rel = sanitizePath(t.path || '');
//       const label = t.label || (rel.split('/').pop() || 'Track');
//       return { label, path: rel };
//     }).filter(x => x.path);
//     state.dirty = false;
//     renderTracks(state.tracks);
//     refreshPlayingUI();
//     LOG('album loaded', album.id, 'tracks:', state.tracks.length);
//   }

//   if (albumsRoot){
//     albumsRoot.addEventListener('click', async (e)=>{
//       const li = e.target.closest('.album-card');
//       if (!li || li.classList.contains('create') || li.classList.contains('ghost')) return;
//       const id = li.getAttribute('data-album-id');
//       if (!id) return;
//       await loadAlbum(id);
//       open(editor);
//     }, { passive:true });
//   }

//   document.addEventListener('albums:refresh', async ()=>{
//     const tab = qs('.acct-tab[data-tab="albums"]');
//     if (tab) tab.click();
//   }, { passive:true });

//   async function headOk(url){
//     try{
//       const r = await fetch(url, { method:'HEAD', cache:'no-store' });
//       return r.ok;
//     }catch(e){
//       return false;
//     }
//   }

//   async function playUrl(url, ctx={}){
//     const hookOk = (typeof loadPlaylistIndex === 'function') && Array.isArray(playlist);
//     if (!hookOk){
//       WARN('no compatible player hook found', { hasLoad: typeof loadPlaylistIndex, hasPlaylist: Array.isArray(playlist) });
//       return;
//     }
//     const abs = resolveUrl(url);
//     LOG('play request', { from: ctx.origin||'unknown', url: abs });
//     const ok = await headOk(abs);
//     if (!ok){
//       WARN('HEAD 404, aborting play (no retry loop)', abs);
//       return;
//     }
//     if (state.playingUrl && resolveUrl(state.playingUrl) === abs){
//       refreshPlayingUI();
//       return;
//     }
//     let idx = playlist.findIndex(p => resolveUrl(p.url) === abs);
//     if (idx === -1){
//       const label = decodeURIComponent(abs.split('/').pop() || 'Track');
//       playlist.push({ type: mediaTypeFromExt(abs), label, url: abs });
//       if (typeof refreshPlaylistSelect === 'function') refreshPlaylistSelect();
//       idx = playlist.length - 1;
//       LOG('appended temp playlist entry', { idx, label });
//     }
//     try{
//       const okLoad = await loadPlaylistIndex(idx);
//       if (okLoad === false){ WARN('loadPlaylistIndex returned false', { idx, url: abs }); return; }
//       state.playingUrl = abs;
//       refreshPlayingUI();
//       LOG('playing', { idx, url: abs });
//     }catch(err){
//       ERR('play failed', err);
//     }
//   }

//   function refreshPlayingUI(){
//     qsa('#aeResults li', editor).forEach(li=>{
//       const rel = String(li.dataset.path||'');
//       const url = buildUrl(rel);
//       const on = state.playingUrl && resolveUrl(url) === resolveUrl(state.playingUrl);
//       const playBtn = li.querySelector('.play');
//       li.classList.toggle('is-playing', !!on);
//       if (playBtn) playBtn.textContent = on ? 'PLAYING' : 'Play';
//     });
//     qsa('.ae-track', tracksBox).forEach(li=>{
//       const rel = String(li.dataset.path||'');
//       const url = buildUrl(rel);
//       const on = state.playingUrl && resolveUrl(url) === resolveUrl(state.playingUrl);
//       const btn = li.querySelector('.play');
//       if (btn) btn.textContent = on ? 'PLAYING' : 'Play';
//     });
//   }
// })();




// Album Editor: picker + tracks + save + player interop (sanitized paths, no 404 loops, verbose logs)
(() => {
  const qs=(s,r=document)=>r.querySelector(s); const qsa=(s,r=document)=>Array.from(r.querySelectorAll(s));
  const editor = qs('#albumEditor'); if(!editor) return;

  const appDiv = qs('#app');
  const BASE = (appDiv?.dataset.base || 'media/archives').replace(/\/+$/,'');
  const LOG = (...a)=>console.log('[AlbumEditor]', ...a);
  const WARN = (...a)=>console.warn('[AlbumEditor]', ...a);
  const ERR = (...a)=>console.error('[AlbumEditor]', ...a);

  // DOM
  const form = qs('#albumEditorForm', editor);
  const closeBtn = qs('#albumEditorClose', editor);
  const coverImg = qs('#aeCoverImg', editor);
  const coverUrl = qs('#aeCoverUrl', editor);
  const coverFile= qs('#aeCoverFile', editor);
  const aeId     = qs('#aeId', editor);
  const aeTitle  = qs('#aeTitle', editor);
  const aeBand   = qs('#aeBand', editor);
  const aeDesc   = qs('#aeDesc', editor);
  const aeVis    = qs('#aeVisibility', editor);
  const infoToggle = qs('#aeInfoToggle', editor);

  const tracksBox = qs('#aeTracks', editor);
  const addTracksBtn = qs('#aeAddTracks', editor);

  const picker = qs('#aePicker', editor);
  const search = qs('#aeSearch', editor);
  const results= qs('#aeResults', editor);
  const pickClose= qs('#aePickerClose', editor);

  const albumsRoot = qs('#acctAlbums');

  async function api(path, opts={}){
    const o = Object.assign({ credentials:'same-origin' }, opts);
    const res = await fetch(path, o);
    const ct = res.headers.get('content-type')||'';
    const data = ct.includes('application/json') ? await res.json().catch(()=>null) : null;
    if(!res.ok) throw Object.assign(new Error('HTTP '+res.status), {status:res.status, data});
    return data;
  }

  function genDefaultCover(title='Album'){
    const t = (title || 'Album').slice(0, 2).toUpperCase();
    const hue = Math.abs([...title].reduce((a,c)=>a+c.charCodeAt(0),0)) % 360;
    const h2  = (hue + 35) % 360;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="hsl(${hue},70%,45%)"/><stop offset="100%" stop-color="hsl(${h2},70%,55%)"/>
        </linearGradient></defs>
        <rect width="640" height="640" fill="url(#g)"/>
        <circle cx="320" cy="320" r="220" fill="rgba(255,255,255,0.12)"/>
        <text x="50%" y="54%" text-anchor="middle" font-family="system-ui, sans-serif" font-size="200" font-weight="700" fill="rgba(255,255,255,0.9)">${t}</text>
      </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  function open(el){ el.classList.remove('hidden'); }
  function close(el){ el.classList.add('hidden'); }
  function setCover(src, title){
    const safe = (src && src.trim()) ? src : genDefaultCover(title || aeTitle?.value || 'Album');
    coverImg.src = safe;
  }
  function encodePath(p){ return p.split('/').map(encodeURIComponent).join('/'); }
  function resolveUrl(u){ try{ return new URL(u, location.href).href; }catch{ return u; } }
  function buildUrl(rel){ return `${BASE}/${encodePath(rel)}`; }
  function hasMediaExt(p){
    const ext = (p.split('.').pop()||'').toLowerCase();
    return ['mp3','wav','ogg','m4a','flac','aac','mp4','webm','ogv','mov','m4v','m3u8','mpd','jpg','jpeg','png','gif','webp','bmp'].includes(ext);
  }
  function sanitizePath(raw){
    if (!raw) return '';
    let s = String(raw)
      .replace(/^[\s\u2500-\u257F|>]+/g,'')
      .replace(/^(├─*|└─*|─+|┌─*|│)+\s*/g,'')
      .replace(/\s{2,}/g,' ')
      .trim();
    if (s.endsWith('/')) return '';
    return s;
  }
  function mediaTypeFromExt(path){
    const ext = (path.split('.').pop()||'').toLowerCase();
    if (['mp3','wav','ogg','m4a','flac','aac'].includes(ext)) return 'audio';
    if (['mp4','webm','ogv','mov','m4v'].includes(ext))       return 'video';
    if (['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) return 'image';
    if (ext === 'm3u8') return 'hls';
    if (ext === 'mpd')  return 'dash';
    return 'audio';
  }

  const libState = { ready:false, items:[], filtered:[] };
  async function ensureLibrary(){
    if (libState.ready) return libState.items;
    const url = appDiv?.dataset.tree;
    if (!url) { libState.ready=true; libState.items=[]; return libState.items; }
    const text = await fetch(url, { credentials:'same-origin', cache:'no-store' }).then(r=>r.text());
    let files = [];
    if (typeof parseTreeToFiles === 'function') {
      files = parseTreeToFiles(text);
    } else {
      files = text.split(/\r?\n/).map(s=>sanitizePath(s)).filter(Boolean).filter(hasMediaExt);
    }
    libState.items = files.map(p=>({ path:p, label:(p.split('/').pop()||p) }));
    libState.ready = true;
    LOG('library loaded', libState.items.length, 'items');
    return libState.items;
  }

  const state = { tracks: [], current: null, dirty: false, playingUrl: null };
  function markDirty(){ state.dirty = true; }

  ['input','change','keyup','paste'].forEach(ev=>{
    form.addEventListener(ev, (e)=>{
      if (e.target && (e.target.closest('#albumEditorForm') || e.target.closest('#aePicker'))) markDirty();
    }, { passive:true });
  });
  window.addEventListener('beforeunload', (e)=>{
    if (state.dirty){ e.preventDefault(); e.returnValue=''; }
  });
  function requestClose(){
    if (!state.dirty) { close(editor); return; }
    if (window.confirm('Discard unsaved changes?')){ state.dirty=false; close(editor); }
  }
  closeBtn.addEventListener('click', requestClose, { passive:true });
  editor.addEventListener('click', (e)=>{ if (e.target===editor) requestClose(); }, { passive:true });
  editor.addEventListener('keydown', (e)=>{ if (e.key==='Escape'){ e.stopPropagation(); requestClose(); } }, { passive:false });

  function renderTracks(list){
    tracksBox.innerHTML = '';
    list.forEach((t,idx)=>{
      const rel = sanitizePath(t.path);
      if (!rel) return;
      const url = buildUrl(rel);
      const isPlaying = (state.playingUrl && resolveUrl(state.playingUrl) === resolveUrl(url));
      const li = document.createElement('div');
      li.className = 'ae-track'; li.draggable = true;
      li.dataset.idx = String(idx);
      li.dataset.path = rel;
      li.innerHTML = `
        <div class="grip">⋮⋮</div>
        <div class="title" title="${t.label}">${String(idx+1).padStart(2,'0')}. ${t.label}</div>
        <div class="ae-row-actions">
          <button class="play" type="button">${isPlaying ? 'PLAYING' : 'Play'}</button>
          <button class="rm" type="button">Remove</button>
        </div>
      `;
      tracksBox.appendChild(li);
    });
    bindDnD(); bindTrackRowActions();
  }

  function bindTrackRowActions(){
    qsa('.ae-track', tracksBox).forEach(li=>{
      const idx = Number(li.dataset.idx);
      const rel = String(li.dataset.path||'');
      const url = buildUrl(rel);
      const playBtn = li.querySelector('.play');
      const rmBtn   = li.querySelector('.rm');
      playBtn.addEventListener('click', async (e)=>{
        e.stopPropagation();
        await playUrl(url, { origin:'tracks', idx });
        refreshPlayingUI();
      }, { passive:false });
      rmBtn.addEventListener('click', ()=>{
        state.tracks.splice(idx,1);
        markDirty();
        renderTracks(state.tracks);
      }, { passive:true });
    });
  }

  function bindDnD(){
    let src=null;
    tracksBox.addEventListener('dragstart',e=>{
      const li = e.target.closest('.ae-track'); if(!li) return;
      src = Number(li.dataset.idx); e.dataTransfer.effectAllowed='move';
    });
    tracksBox.addEventListener('dragover',e=>{
      if(src==null) return; e.preventDefault(); e.dataTransfer.dropEffect='move';
    });
    tracksBox.addEventListener('drop',e=>{
      if(src==null) return; e.preventDefault();
      const li = e.target.closest('.ae-track'); if(!li) return;
      const dst = Number(li.dataset.idx);
      if (dst===src) { src=null; return; }
      const item = state.tracks.splice(src,1)[0];
      state.tracks.splice(dst,0,item);
      src=null; markDirty(); renderTracks(state.tracks);
    });
    tracksBox.addEventListener('dragend',()=>{ src=null; });
  }

  function openPicker(){ open(picker); search.value=''; renderResults(libState.items); search.focus(); }
  function closePicker(){ close(picker); }
  function isInTracks(rel){ return state.tracks.some(t => sanitizePath(t.path) === sanitizePath(rel)); }

  function renderResults(list){
    results.innerHTML = '';
    list.forEach((it)=>{
      const rel = sanitizePath(it.path);
      if (!rel || !hasMediaExt(rel)) return;
      const url = buildUrl(rel);
      const isDup = isInTracks(rel);
      const isPlaying = (state.playingUrl && resolveUrl(state.playingUrl) === resolveUrl(url));
      const li = document.createElement('li');
      li.dataset.path = rel;
      if (isPlaying) li.classList.add('is-playing');
      li.innerHTML = `
        <div class="title" title="${rel}">${it.label}</div>
        <div class="ae-row-actions">
          <button class="play" type="button">${isPlaying ? 'PLAYING' : 'Play'}</button>
          <button class="add" type="button" ${isDup ? 'disabled' : ''}>${isDup ? 'ADDED' : 'ADD'}</button>
        </div>
      `;
      const playBtn = li.querySelector('.play');
      const addBtn  = li.querySelector('.add');
      li.addEventListener('click', (e)=>{
        if (e.target === playBtn || e.target === addBtn) return;
        if (!isInTracks(rel)){
          state.tracks.push({ label: it.label, path: rel });
          markDirty();
          renderTracks(state.tracks);
          addBtn.disabled = true; addBtn.textContent = 'ADDED';
        }
      }, { passive:true });
      playBtn.addEventListener('click', async (e)=>{
        e.stopPropagation();
        await playUrl(url, { origin:'picker' });
        refreshPlayingUI();
      }, { passive:false });
      addBtn.addEventListener('click', (e)=>{
        e.stopPropagation();
        if (addBtn.disabled) return;
        state.tracks.push({ label: it.label, path: rel });
        markDirty();
        renderTracks(state.tracks);
        addBtn.disabled = true; addBtn.textContent = 'ADDED';
      }, { passive:true });
      results.appendChild(li);
    });
  }

  search.addEventListener('input', ()=>{
    const q = search.value.trim().toLowerCase();
    libState.filtered = !q ? libState.items :
      libState.items.filter(it => {
        const rel = sanitizePath(it.path);
        return rel && (it.label.toLowerCase().includes(q) || rel.toLowerCase().includes(q));
      });
    renderResults(libState.filtered);
  });
  pickClose.addEventListener('click', ()=> closePicker(), { passive:true });
  addTracksBtn.addEventListener('click', async ()=>{ await ensureLibrary(); openPicker(); }, { passive:true });

  infoToggle.addEventListener('click', ()=>{
    const expanded = infoToggle.getAttribute('aria-expanded') === 'true';
    infoToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    aeDesc.style.display = expanded ? 'none' : 'block';
    infoToggle.textContent = expanded ? 'Expand' : 'Collapse';
    markDirty();
  }, { passive:true });

  coverUrl.addEventListener('change', async ()=>{
    const src = coverUrl.value.trim();
    setCover(src, aeTitle.value || aeBand?.value);
    markDirty();
    const id = aeId.value; if (!id) return;
    try{
      await api(`/me/albums/${encodeURIComponent(id)}`, {
        method:'POST',
        headers:{ 'Content-Type': 'application/json' },
        body: JSON.stringify({ cover_url: src })
      });
      state.dirty = false;
    }catch{}
  }, { passive:true });

  coverFile.addEventListener('change', async ()=>{
    const f = coverFile.files && coverFile.files[0]; if(!f) return;
    const id = aeId.value; if(!id) return;
    const fd = new FormData(); fd.append('file', f);
    try{
      const d = await api(`/me/albums/${encodeURIComponent(id)}/cover`, { method:'POST', body: fd });
      setCover(d?.cover_url || '', aeTitle.value || aeBand?.value);
      coverUrl.value = d?.cover_url || '';
      state.dirty = false;
    }catch{}
  });

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const albumId = aeId.value;
    const cleanTracks = state.tracks
      .map(t => ({ label: t.label, path: sanitizePath(t.path) }))
      .filter(t => t.path && hasMediaExt(t.path));
    const body = {
      title: aeTitle.value.trim(),
      subtitle: (aeBand?.value || '').trim(),
      description_md: aeDesc.value,
      visibility: aeVis.value,
      cover_url: coverImg.src || coverUrl.value || '',
      metadata: { tracks: cleanTracks }
    };
    try{
      await api(`/me/albums/${encodeURIComponent(albumId)}`, {
        method:'POST',
        headers:{ 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      state.dirty = false;
      close(editor);
      document.dispatchEvent(new CustomEvent('albums:refresh'));
    }catch(err){
      console.error('[AlbumEditor] save failed', err);
      alert('Save failed.');
    }
  }, { passive:false });

  async function loadAlbum(id){
    const { album } = await api(`/me/albums/${encodeURIComponent(id)}`, { method:'GET' });
    state.current = album;
    aeId.value = album.id;
    aeTitle.value = album.title || '';
    if (aeBand) aeBand.value = album.subtitle || '';
    aeDesc.value = album.description_md || '';
    aeVis.value = album.visibility || 'private';
    coverUrl.value = album.cover_url || '';
    setCover(album.cover_url || '', album.title || album.subtitle);

    const tr = (album.metadata && Array.isArray(album.metadata.tracks)) ? album.metadata.tracks : [];
    state.tracks = tr.map(t => {
      const rel = sanitizePath(t.path || '');
      const label = t.label || (rel.split('/').pop() || 'Track');
      return { label, path: rel };
    }).filter(x => x.path);
    state.dirty = false;
    renderTracks(state.tracks);
    refreshPlayingUI();
  }

  if (albumsRoot){
    albumsRoot.addEventListener('click', async (e)=>{
      const li = e.target.closest('.album-card');
      if (!li || li.classList.contains('create') || li.classList.contains('ghost')) return;
      const id = li.getAttribute('data-album-id');
      if (!id) return;
      await loadAlbum(id);
      open(editor);
    }, { passive:true });
  }

  document.addEventListener('albums:refresh', async ()=>{
    const tab = qs('.acct-tab[data-tab="albums"]');
    if (tab) tab.click();
  }, { passive:true });

  async function headOk(url){
    try{
      const r = await fetch(url, { method:'HEAD', cache:'no-store' });
      return r.ok;
    }catch{ return false; }
  }

  async function playUrl(url, ctx={}){
    const hookOk = (typeof loadPlaylistIndex === 'function') && Array.isArray(playlist);
    if (!hookOk){
      console.warn('[AlbumEditor] no compatible player hook found', { hasLoad: typeof loadPlaylistIndex, hasPlaylist: Array.isArray(playlist) });
      return;
    }
    const abs = resolveUrl(url);
    const ok = await headOk(abs);
    if (!ok) return;
    if (state.playingUrl && resolveUrl(state.playingUrl) === abs){ refreshPlayingUI(); return; }
    let idx = playlist.findIndex(p => resolveUrl(p.url) === abs);
    if (idx === -1){
      const label = decodeURIComponent(abs.split('/').pop() || 'Track');
      playlist.push({ type: mediaTypeFromExt(abs), label, url: abs });
      if (typeof refreshPlaylistSelect === 'function') refreshPlaylistSelect();
      idx = playlist.length - 1;
    }
    try{
      const okLoad = await loadPlaylistIndex(idx);
      if (okLoad === false) return;
      state.playingUrl = abs;
      refreshPlayingUI();
    }catch(err){
      console.error('[AlbumEditor] play failed', err);
    }
  }

  function refreshPlayingUI(){
    qsa('#aeResults li', editor).forEach(li=>{
      const rel = String(li.dataset.path||'');
      const url = buildUrl(rel);
      const on = state.playingUrl && resolveUrl(url) === resolveUrl(state.playingUrl);
      const playBtn = li.querySelector('.play');
      li.classList.toggle('is-playing', !!on);
      if (playBtn) playBtn.textContent = on ? 'PLAYING' : 'Play';
    });
    qsa('.ae-track', tracksBox).forEach(li=>{
      const rel = String(li.dataset.path||'');
      const url = buildUrl(rel);
      const on = state.playingUrl && resolveUrl(url) === resolveUrl(state.playingUrl);
      const btn = li.querySelector('.play');
      if (btn) btn.textContent = on ? 'PLAYING' : 'Play';
    });
  }
})();

