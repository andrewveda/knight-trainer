'use strict';

/* ============================================================
     CONFIGURATION
     ============================================================ */
const CONFIG = {
  REPO_BASE: 'https://raw.githubusercontent.com/andrewveda/knight-trainer/main/data',
  CACHE_LIMIT: 30,
  AUTO_MOVE_DELAY: 480,
  AUTO_ADVANCE_DELAY: 1400,
  STOCKFISH_URL: 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js',
  ENGINE_DEPTH: 14,
};

const IS_TOUCH_DEVICE = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0);

/* ============================================================
     STATE
     ============================================================ */
const state = {
  cache: new Map(),
  themesMeta: null,
  currentTheme: null,
  currentDifficulty: 'easy',
  currentPuzzle: null,
  chess: null,
  board: null,
  boardResizeWired: false,
  solving: false,
  moveCursor: 0,
  fenHistory: [],
  sanHistory: [],
  viewIndex: 0,
  boardOrientation: 'white',
  puzzleStartTime: null,
  sessionSolved: 0,
  settings: loadSettings(),
  stats: loadStats(),
  favorites: loadJSON('knt_favorites', []),
  recents: loadJSON('knt_recents', []),
  selectedSquare: null,
  legalTargets: [],
  sf: null,
  sfMode: null,
  sfBestLine: {},
  analysisMode: false,
};

function getPromotionPieceUI(color) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('promoOverlay');
    overlay.innerHTML = '';
    overlay.classList.remove('hidden');

    ['q', 'r', 'b', 'n'].forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      btn.style.cssText = 'width: 70px; height: 70px; border-radius: 14px; background: var(--bg2);';
      
      const img = document.createElement('img');
      img.src = pieceThemeUrl(color + p.toUpperCase());
      img.style.width = '100%';
      
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        overlay.classList.add('hidden');
        resolve(p);
      });
      overlay.appendChild(btn);
    });
  });
}

/* ============================================================
     STORAGE HELPERS
     ============================================================ */
function loadJSON(key, fallback){
  try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch(e){ return fallback; }
}
function saveJSON(key, val){
  try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){}
}
function loadSettings(){
  return loadJSON('knt_settings', {
    theme:'dark', sound:true, animations:true, coordinates:true,
    autoFlip:false, autoAdvance:false, pieceStyle:'wikipedia', boardColor:'brown'
  });
}
function saveSettings(){ saveJSON('knt_settings', state.settings); }

function loadStats(){
  return loadJSON('knt_stats', {
    totalSolved:0, totalAttempts:0, correctFirstTry:0,
    currentStreak:0, bestStreak:0, ratingSum:0, ratingCount:0,
    totalTimeMs:0, dailyDate:null, dailyCount:0
  });
}
function saveStats(){ saveJSON('knt_stats', state.stats); }

/* ============================================================
     NETWORKING & THEME PROCESSING
     ============================================================ */
async function fetchJSONCached(url){
  if(state.cache.has(url)) return state.cache.get(url);
  const res = await fetch(url);
  if(!res.ok) throw new Error('Failed to fetch ' + url + ' (' + res.status + ')');
  const data = await res.json();
  if(state.cache.size >= CONFIG.CACHE_LIMIT){
    const oldestKey = state.cache.keys().next().value;
    state.cache.delete(oldestKey);
  }
  state.cache.set(url, data);
  return data;
}

async function loadMasterThemes() {
  try {
    state.themesMeta = await fetchJSONCached(`${CONFIG.REPO_BASE}/index.json`);
    renderThemeGrid();
  } catch (e) {
    document.getElementById('themeGrid').innerHTML = `<div class="status-bar wrong">Failed to sync tactical indices.</div>`;
  }
}

async function getPuzzlePayload(theme, difficulty) {
  const url = `${CONFIG.REPO_BASE}/${theme}/${difficulty}.json`;
  const puzzles = await fetchJSONCached(url);
  const arr = Array.isArray(puzzles) ? puzzles : [];
  if (!arr.length) throw new Error('No puzzles found in ' + theme + '/' + difficulty);
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ============================================================
     UCI MOVE PARSING
     ============================================================ */
function parseUCI(uci){
  return {
    from: uci.slice(0,2),
    to: uci.slice(2,4),
    promotion: uci.length > 4 ? uci.slice(4) : 'q'
  };
}

/* ============================================================
     AUDIO ARCHITECTURE
     ============================================================ */
let audioCtx = null;
function beep(freq, duration, type='sine'){
  if(!state.settings.sound) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + duration);
  }catch(e){}
}
const sfx = {
  move: ()=>beep(450,0.08),
  correct: ()=>beep(680,0.18),
  wrong: ()=>beep(150,0.25,'square'),
  success: ()=>{beep(523,0.12);setTimeout(()=>beep(659,0.12),120);setTimeout(()=>beep(784,0.22),240);}
};

/* ============================================================
     TOAST NOTIFICATION ENGINE
     ============================================================ */
let toastTimer = null;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), 1800);
}

/* ============================================================
     SCREEN CONTROL & VIEW SWAPPING
     ============================================================ */
function showScreen(name){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.screen === name);
  });
  if(name === 'stats') renderStats();
  if(name === 'trainer' && state.board) setTimeout(()=>state.board.resize(), 50);
}
document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>showScreen(btn.dataset.screen));
});
document.getElementById('trainerBack').addEventListener('click', ()=>{
  if(state.sf) state.sf.postMessage('stop');
  clearTimeout(liveAnalysisTimer);
  showScreen('home');
});

/* ============================================================
     UI COMPONENT RENDERING (HOME SCREEN)
     ============================================================ */
function renderThemeGrid(filterText = '') {
  const grid = document.getElementById('themeGrid');
  if (!state.themesMeta) return;
  
  grid.innerHTML = '';
  const search = filterText.toLowerCase().trim();
  
  Object.keys(state.themesMeta).forEach(key => {
    if (search && !key.toLowerCase().includes(search)) return;
    
    const diffs = state.themesMeta[key];
    const totalCount = (diffs.easy || 0) + (diffs.medium || 0) + (diffs.hard || 0);
    if (totalCount === 0) return;
    
    const card = document.createElement('div');
    card.className = 'theme-card glass' + (state.currentTheme === key ? ' selected' : '');
    
    const formattedName = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
    const specificCount = diffs[state.currentDifficulty] || 0;

    card.innerHTML = `
      <div class="tname">${formattedName}</div>
      <div class="tcount">${specificCount.toLocaleString()} Puzzles (${state.currentDifficulty})</div>
    `;
    
    card.addEventListener('click', (e) => { 
      ripple(card, e); 
      state.currentTheme = key;
      document.querySelectorAll('.theme-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      startTraining(key, state.currentDifficulty); 
    });
    grid.appendChild(card);
  });
  
  if (grid.children.length === 0) {
    grid.innerHTML = `<div class="status-bar info" style="grid-column: 1/-1;">No matching tactical patterns found.</div>`;
  }
}

function ripple(el, evt){
  if(!state.settings.animations) return;
  const r = document.createElement('span');
  r.className = 'ripple';
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  r.style.width = r.style.height = size + 'px';
  r.style.left = (evt.clientX - rect.left - size/2) + 'px';
  r.style.top = (evt.clientY - rect.top - size/2) + 'px';
  el.appendChild(r);
  setTimeout(()=>r.remove(), 650);
}

document.querySelectorAll('#difficultyRow .chip').forEach(chip=>{
  chip.addEventListener('click', ()=>{
    document.querySelectorAll('#difficultyRow .chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    state.currentDifficulty = chip.dataset.diff;
    renderThemeGrid(document.getElementById('themeSearch').value);
  });
});

document.getElementById('themeSearch').addEventListener('input', (e) => {
  renderThemeGrid(e.target.value);
});

document.getElementById('chipRandom').addEventListener('click', ()=>{
  if(!state.themesMeta) return;
  const keys = Object.keys(state.themesMeta);
  const randomKey = keys[Math.floor(Math.random() * keys.length)];
  startTraining(randomKey, state.currentDifficulty);
});

document.getElementById('chipFav').addEventListener('click', ()=>{
  if(!state.favorites.length){ toast('No favorites saved yet — tap the star on a puzzle you love.'); return; }
  const fav = state.favorites[Math.floor(Math.random()*state.favorites.length)];
  startTraining(fav.theme, fav.difficulty, fav.puzzle);
});

document.getElementById('chipRecent').addEventListener('click', ()=>{
  if(!state.recents.length){ toast('No recent puzzles yet — go solve one!'); return; }
  const r = state.recents[0];
  startTraining(r.theme, r.difficulty, r.puzzle);
});

/* ============================================================
     CHESSBOARD MANAGEMENT ENGINE
     ============================================================ */
function initBoardIfNeeded(){
  if(state.board) return;
  state.board = Chessboard('board', {
    draggable: !IS_TOUCH_DEVICE,
    position: 'start',
    pieceTheme: pieceThemeUrl,
    showNotation: state.settings.coordinates,
    onDragStart, onDrop, onSnapEnd
  });
  if(!state.boardResizeWired){
    window.addEventListener('resize', ()=>state.board && state.board.resize());
    state.boardResizeWired = true;
  }

  const $boardEl = $('#board');

  $boardEl.off('click.cpt').on('click.cpt', '[data-square]', function(e) {
    const square = $(this).attr('data-square');
    if (square) onBoardSquareClick(square);
  });

  $boardEl.off('contextmenu.cpt').on('contextmenu.cpt', function(e){
    e.preventDefault();
    return false;
  });

  $boardEl.off('dragstart.cpt').on('dragstart.cpt', 'img', function(e){
    e.preventDefault();
    return false;
  });
}

function rebuildBoard(){
  if(state.board && state.board.destroy) state.board.destroy();
  state.board = null;
  initBoardIfNeeded();
  refreshBoardPosition(false);
}

function pieceThemeUrl(piece){
  const style = state.settings.pieceStyle || 'wikipedia';
  return `https://chessboardjs.com/img/chesspieces/${style}/${piece}.png`;
}

async function startTraining(themeKey, difficulty, presetPuzzle){
  showScreen('trainer');
  initBoardIfNeeded();
  state.currentTheme = themeKey;
  state.currentDifficulty = difficulty;
  
  const titleDisplay = themeKey.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
  document.getElementById('trainerTitle').textContent = titleDisplay + ' Drill';
  document.getElementById('loadingOverlay').classList.remove('hidden');
  setDragEnabled(false);
  
  try{
    const puzzle = presetPuzzle || await getPuzzlePayload(themeKey, difficulty);
    loadPuzzle(themeKey, difficulty, puzzle);
  }catch(err){
    toast('Couldn\'t load that puzzle — check your connection and try again.');
    console.error(err);
  }finally{
    document.getElementById('loadingOverlay').classList.add('hidden');
  }
}

function loadPuzzle(themeKey, difficulty, puzzle){
  state.currentTheme = themeKey;
  state.currentDifficulty = difficulty;
  state.currentPuzzle = puzzle;
  state.chess = new Chess(puzzle.f);
  state.moveCursor = 0;
  state.fenHistory = [puzzle.f];
  state.sanHistory = [];
  state.viewIndex = 0;
  state.solving = false;
  state.puzzleStartTime = Date.now();
  setDragEnabled(false);
  clearHighlights();
  state.sfBestLine = {};
  renderEnginePanel();

  const sideToSolve = state.chess.turn() === 'w' ? 'black' : 'white';
  state.boardOrientation = state.settings.autoFlip ? sideToSolve : 'white';
  state.board.orientation(state.boardOrientation);
  state.board.position(puzzle.f, false);

  renderPuzzleInfo(themeKey, difficulty, puzzle);
  renderMoveList();
  updateFavoriteButton();
  updateNavButtons();
  updateMoveDisplay();
  
  setTimeout(()=>{
    if(state.currentPuzzle !== puzzle) return;
    const puzzleMoves = puzzle.m.split(' ');
    applyMoveToBoard(puzzleMoves[0], true);
    state.moveCursor = 1;
    state.solving = true;
    setDragEnabled(true);
    toast('Your move, Knight Trainer — find the winning shot.');
  }, 600);
}

function renderPuzzleInfo(themeKey, difficulty, puzzle){
  const formatted = themeKey.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
  document.getElementById('infoPiece').textContent = formatted;
  document.getElementById('infoDifficulty').textContent = capitalize(difficulty);
  document.getElementById('infoRating').textContent = puzzle.r ?? '—';
  document.getElementById('infoId').textContent = puzzle.id ?? '—';
  document.getElementById('infoSession').textContent = state.sessionSolved;
}

function updateMoveCounter(){
  if (!state.currentPuzzle) return;
  const puzzleMoves = state.currentPuzzle.m.split(' ');
  const total = puzzleMoves.length;
  document.getElementById('infoMoveCount').textContent = `${Math.min(state.moveCursor, total)} / ${total}`;
}

function applyMoveToBoard(uci, showOnBoard){
  const mv = parseUCI(uci);
  const result = state.chess.move(mv);
  if(!result) return null;
  state.fenHistory.push(state.chess.fen());
  state.sanHistory.push(result.san);
  const wasAtLatest = state.viewIndex === state.fenHistory.length - 2;
  if(wasAtLatest){
    state.viewIndex = state.fenHistory.length - 1;
    if(showOnBoard !== false) state.board.position(state.chess.fen());
  }
  sfx.move();
  renderMoveList();
  updateMoveCounter();
  updateNavButtons();
  updateMoveDisplay();
  return result;
}

function updateMoveDisplay(flashClass){
  clearBoardArrows();
  const el = document.getElementById('statusBar');
  if(!state.chess || !state.fenHistory.length){
    el.textContent = 'Choose a puzzle to start training';
    el.className = 'status-bar info';
    return;
  }
  scheduleLiveAnalysis();
  const idx = state.viewIndex;
  if(idx <= 0){
    el.textContent = 'Starting Position';
    el.className = 'status-bar info';
    return;
  }
  const san = state.sanHistory[idx - 1];
  if(!san){ el.textContent = 'Starting Position'; el.className = 'status-bar info'; return; }
  const moveNum = Math.ceil(idx / 2);
  const isWhiteMove = idx % 2 === 1;
  el.textContent = moveNum + (isWhiteMove ? '. ' : '… ') + san;
  el.className = 'status-bar' + (flashClass ? ' ' + flashClass : '');
  if(flashClass){
    setTimeout(()=>{ if(el.textContent) el.className = 'status-bar'; }, 900);
  }
}

function setDragEnabled(enabled){
  state.dragEnabled = enabled;
}

/* ============================================================
     TARGET SELECTION & INTERACTION VALIDATION
     ============================================================ */
function squareEl(square) {
  return document.querySelector(`#board [data-square="${square}"]`);
}
function clearHighlights(){
  document.querySelectorAll('#board .sq-legal, #board .sq-legal-capture, #board .sq-selected')
    .forEach(el=>el.classList.remove('sq-legal','sq-legal-capture','sq-selected'));
  state.selectedSquare = null;
  state.legalTargets = [];
}
function viewChess(){
  const fen = state.fenHistory[state.viewIndex];
  return fen ? new Chess(fen) : new Chess();
}
function highlightLegalMoves(square){
  clearHighlights();
  const moves = viewChess().moves({square, verbose:true});
  if(!moves.length) return;
  state.selectedSquare = square;
  state.legalTargets = moves.map(m=>m.to);
  const originEl = squareEl(square);
  if(originEl) originEl.classList.add('sq-selected');
  moves.forEach(m=>{
    const el = squareEl(m.to);
    if(el) el.classList.add(m.captured ? 'sq-legal-capture' : 'sq-legal');
  });
}
function canSelect(square){
  if(!state.fenHistory.length || !state.dragEnabled) return false;
  if(state.analysisMode){
    // Allow variable selection across active analysis configurations
  }else{
    if(state.viewIndex !== state.fenHistory.length - 1) return false;
    if(!(state.solving && state.currentPuzzle)) return false;
  }
  const vc = viewChess();
  if(vc.game_over()) return false;
  const piece = vc.get(square);
  if(!piece) return false;
  return (vc.turn() === 'w') === (piece.color === 'w');
}

async function onBoardSquareClick(square){
  if(!state.fenHistory.length || !state.dragEnabled) return;

  if(!state.analysisMode){
    if(state.viewIndex !== state.fenHistory.length - 1) return;
    if(!(state.solving && state.currentPuzzle)) return;
  }

  if (canSelect(square) && square !== state.selectedSquare) {
    highlightLegalMoves(square);
    return;
  }

  if(state.selectedSquare){
    if(square === state.selectedSquare){
      clearHighlights();
      return;
    }

    const fromSquare = state.selectedSquare;
    clearHighlights();
    
    if(state.analysisMode) {
      await attemptFreeMove(fromSquare, square);
    } else {
      await attemptSolvingMove(fromSquare, square);
    }
    return;
  }

  if(canSelect(square)){
    highlightLegalMoves(square);
  }
}

function onDrop(source, target){
  clearHighlights();
  
  const currentPiece = state.chess.get(source);
  const isPromo = currentPiece && currentPiece.type === 'p' && (target[1] === '8' || target[1] === '1');
  
  if (isPromo) {
    setTimeout(async () => {
      if(state.analysisMode) {
        await attemptFreeMove(source, target);
      } else {
        await attemptSolvingMove(source, target);
      }
    }, 50);
    return undefined; 
  }

  if(state.analysisMode) {
    attemptFreeMove(source, target).then(res => { if(res === 'rejected') state.board.position(state.chess.fen()); });
  } else {
    attemptSolvingMove(source, target).then(res => { if(res === 'rejected') state.board.position(state.chess.fen()); });
  }
}

async function attemptSolvingMove(source, target){
  if(!state.dragEnabled || !state.solving) return 'rejected';
  const puzzleMoves = state.currentPuzzle.m.split(' ');
  if(!state.currentPuzzle || state.moveCursor >= puzzleMoves.length) return 'rejected';

  const expected = parseUCI(puzzleMoves[state.moveCursor]);
  const legalMoves = state.chess.moves({verbose:true});
  const isLegal = legalMoves.some(m=>m.from===source && m.to===target);
  if(!isLegal) return 'rejected';

  if(source !== expected.from || target !== expected.to){
    registerAttempt(false);
    flashSquare(target, 'sq-wrong');
    sfx.wrong();
    toast('Good try, but not the sharpest move — look again.');
    return 'rejected';
  }

  const isPromotion = (state.chess.get(source)||{}).type === 'p' && (target[1] === '8' || target[1] === '1');
  let promotionPiece = expected.promotion || 'q';
  
  if(isPromotion) {
    const turnColor = state.chess.turn();
    promotionPiece = await getPromotionPieceUI(turnColor);
    if(promotionPiece !== expected.promotion) {
      registerAttempt(false);
      sfx.wrong();
      toast('Wrong promotion piece option chosen.');
      state.board.position(state.chess.fen());
      return 'rejected';
    }
  }

  const moveObj = { from: source, to: target, promotion: promotionPiece };
  const result = state.chess.move(moveObj);
  if(!result) return 'rejected';

  state.fenHistory.push(state.chess.fen());
  state.sanHistory.push(result.san);
  state.viewIndex = state.fenHistory.length - 1;

  flashSquare(target, 'sq-correct');
  sfx.correct();
  registerAttempt(true);
  state.moveCursor++;
  state.solving = false;
  setDragEnabled(false);
  toast('That\'s the move! 🐴');
  updateMoveDisplay('correct');
  renderMoveList();
  updateMoveCounter();
  updateNavButtons();

  if(state.moveCursor >= puzzleMoves.length){
    finishPuzzle();
  }else{
    setTimeout(playNextAutoMove, CONFIG.AUTO_MOVE_DELAY);
  }
  state.board.position(state.chess.fen());
  return 'accepted';
}

async function attemptFreeMove(source, target){
  const vc = viewChess();
  if(vc.game_over()) return 'rejected';
  const legalMoves = vc.moves({verbose:true});
  const isLegal = legalMoves.some(m=>m.from===source && m.to===target);
  if(!isLegal) return 'rejected';

  const isPromotion = (vc.get(source)||{}).type === 'p' && (target[1] === '8' || target[1] === '1');
  let promotionPiece = 'q';
  
  if(isPromotion){
    promotionPiece = await getPromotionPieceUI(vc.turn());
  }

  const result = vc.move({ from: source, to: target, promotion: promotionPiece });
  if(!result) return 'rejected';

  state.fenHistory = state.fenHistory.slice(0, state.viewIndex + 1);
  state.sanHistory = state.sanHistory.slice(0, state.viewIndex);
  state.fenHistory.push(vc.fen());
  state.sanHistory.push(result.san);
  state.viewIndex = state.fenHistory.length - 1;
  state.chess = vc;
  state.solving = false;

  flashSquare(target, 'sq-correct');
  sfx.move();
  renderMoveList();
  updateMoveCounter();
  updateNavButtons();
  updateMoveDisplay();
  state.board.position(state.chess.fen());
  return 'accepted';
}

function onDragStart(source, piece){
  if(!canSelect(source)) return false;
  highlightLegalMoves(source);
  return true;
}

function onSnapEnd(){
  const fen = state.fenHistory[state.viewIndex] || (state.chess && state.chess.fen());
  if(fen) state.board.position(fen, false);
}

function playNextAutoMove(){
  const puzzleMoves = state.currentPuzzle.m.split(' ');
  if(!state.currentPuzzle || state.moveCursor >= puzzleMoves.length) return;
  clearHighlights();
  applyMoveToBoard(puzzleMoves[state.moveCursor]);
  state.moveCursor++;
  updateMoveCounter();
  if(state.moveCursor >= puzzleMoves.length){
    finishPuzzle();
  }else{
    state.solving = true;
    setDragEnabled(true);
    updateMoveDisplay();
  }
}

function flashSquare(square, cls){
  if(!state.settings.animations) return;
  const sq = document.querySelector(`#board .square-${square}`);
  if(!sq) return;
  sq.classList.add(cls);
  setTimeout(()=>sq.classList.remove(cls), 500);
}

function finishPuzzle(){
  toast('Combination cracked! 🎉');
  updateMoveDisplay('correct');
  sfx.success();
  setDragEnabled(false);
  clearHighlights();
  const elapsed = Date.now() - state.puzzleStartTime;
  recordSolve(state.currentTheme, state.currentPuzzle.r, elapsed);
  addToRecents(state.currentTheme, state.currentDifficulty, state.currentPuzzle);
  state.sessionSolved++;
  document.getElementById('infoSession').textContent = state.sessionSolved;
  if(state.settings.autoAdvance){
    setTimeout(()=>{ if(state.currentTheme) startTraining(state.currentTheme, state.currentDifficulty); }, CONFIG.AUTO_ADVANCE_DELAY);
  }
}

/* ============================================================
     STATS STORAGE & RETRIEVAL ENGINE
     ============================================================ */
function registerAttempt(correct){
  state.stats.totalAttempts++;
  if(correct) state.stats.correctFirstTry++;
  saveStats();
}
function recordSolve(theme, rating, elapsedMs){
  const s = state.stats;
  s.totalSolved++;
  s.currentStreak++;
  s.bestStreak = Math.max(s.bestStreak, s.currentStreak);
  if(typeof rating === 'number'){ s.ratingSum += rating; s.ratingCount++; }
  s.totalTimeMs += elapsedMs;
  const today = new Date().toISOString().slice(0,10);
  if(s.dailyDate !== today){ s.dailyDate = today; s.dailyCount = 0; }
  s.dailyCount++;
  saveStats();
}
function breakStreak(){
  state.stats.currentStreak = 0;
  saveStats();
}
function addToRecents(theme, difficulty, puzzle){
  state.recents = state.recents.filter(r=>r.puzzle.id !== puzzle.id);
  state.recents.unshift({ theme, difficulty, puzzle });
  state.recents = state.recents.slice(0, 20);
  saveJSON('knt_recents', state.recents);
}

/* ============================================================
     HISTORICAL CONFIGURATION REVIEW
     ============================================================ */
function renderMoveList(){
  const el = document.getElementById('moveList');
  const history = state.sanHistory || [];
  if(!history.length){ el.textContent = '—'; return; }
  el.innerHTML = '';
  history.forEach((san, i)=>{
    if(i % 2 === 0){
      const num = document.createElement('span');
      num.className = 'mnum';
      num.textContent = (Math.floor(i/2)+1) + '.';
      el.appendChild(num);
    }
    const mv = document.createElement('span');
    mv.className = 'mv' + (i + 1 === state.viewIndex ? ' current' : '');
    mv.textContent = san;
    mv.dataset.idx = i + 1;
    mv.addEventListener('click', ()=>jumpToFenIndex(i+1));
    el.appendChild(mv);
  });
}

function jumpToFenIndex(idx){
  if(!state.fenHistory.length) return;
  idx = Math.max(0, Math.min(idx, state.fenHistory.length - 1));
  state.viewIndex = idx;
  clearHighlights();
  state.board.position(state.fenHistory[idx], false);
  renderMoveList();
  updateNavButtons();
  updateMoveDisplay();
  setDragEnabled(state.analysisMode || (idx === state.fenHistory.length - 1 && state.solving));
}

function updateNavButtons(){
  const atStart = state.viewIndex <= 0;
  const atLatest = !state.fenHistory.length || state.viewIndex >= state.fenHistory.length - 1;
  document.getElementById('btnFirst').disabled = atStart;
  document.getElementById('btnPrev').disabled = atStart;
  document.getElementById('btnNextMove').disabled = atLatest;
  document.getElementById('btnLast').disabled = atLatest;
  document.getElementById('btnReset').disabled = !state.currentPuzzle;
}

document.getElementById('btnFirst').addEventListener('click', ()=>jumpToFenIndex(0));
document.getElementById('btnPrev').addEventListener('click', ()=>jumpToFenIndex(state.viewIndex - 1));
document.getElementById('btnNextMove').addEventListener('click', ()=>jumpToFenIndex(state.viewIndex + 1));
document.getElementById('btnLast').addEventListener('click', ()=>jumpToFenIndex(state.fenHistory.length - 1));

document.getElementById('btnReset').addEventListener('click', ()=>{
  if(!state.currentPuzzle) return;
  toast('Puzzle reset — go again.');
  loadPuzzle(state.currentTheme, state.currentDifficulty, state.currentPuzzle);
});

/* ============================================================
     INTERFACE COMMAND BINDINGS
     ============================================================ */
document.getElementById('btnHint').addEventListener('click', ()=>{
  if(!state.solving || !state.currentPuzzle) return toast('Pick a puzzle first — then I\'ll show you the way.');
  if(state.viewIndex !== state.fenHistory.length - 1){ toast('Jump back to the current position first.'); return; }
  const puzzleMoves = state.currentPuzzle.m.split(' ');
  const expected = parseUCI(puzzleMoves[state.moveCursor]);
  clearHighlights();
  flashSquare(expected.from, 'sq-hint');
});

document.getElementById('btnSolution').addEventListener('click', ()=>{
  if(!state.currentPuzzle) return;
  state.solving = false;
  setDragEnabled(false);
  clearHighlights();
  breakStreak();
  jumpToFenIndex(state.fenHistory.length - 1);
  playOutSolutionFromCursor();
});

function playOutSolutionFromCursor(){
  const puzzleMoves = state.currentPuzzle.m.split(' ');
  if(!state.currentPuzzle || state.moveCursor >= puzzleMoves.length){
    return;
  }
  applyMoveToBoard(puzzleMoves[state.moveCursor]);
  state.moveCursor++;
  updateMoveCounter();
  setTimeout(playOutSolutionFromCursor, CONFIG.AUTO_MOVE_DELAY);
}

document.getElementById('btnNext').addEventListener('click', ()=>{
  if(state.currentTheme) startTraining(state.currentTheme, state.currentDifficulty);
});
document.getElementById('btnFlip').addEventListener('click', ()=>{
  state.board.flip();
  state.boardOrientation = state.boardOrientation === 'white' ? 'black' : 'white';
  renderEnginePanel();
});
document.getElementById('toggleAnalysis').addEventListener('click', ()=>{
  const el = document.getElementById('toggleAnalysis');
  state.analysisMode = !state.analysisMode;
  el.classList.toggle('on', state.analysisMode);
  clearHighlights();
  if(state.analysisMode){
    setDragEnabled(true);
    toast('Free Play unlocked — try anything.');
  }else{
    setDragEnabled(state.solving);
    toast('Free Play off — back to training mode.');
  }
});

document.getElementById('btnFavorite').addEventListener('click', toggleFavorite);
function toggleFavorite(){
  if(!state.currentPuzzle) return;
  const id = state.currentPuzzle.id;
  const idx = state.favorites.findIndex(f=>f.puzzle.id === id);
  if(idx >= 0){ state.favorites.splice(idx,1); toast('Removed from favorites'); }
  else{ state.favorites.push({theme:state.currentTheme, difficulty:state.currentDifficulty, puzzle:state.currentPuzzle}); toast('Saved to favorites ⭐'); }
  saveJSON('knt_favorites', state.favorites);
  updateFavoriteButton();
}
function updateFavoriteButton(){
  const id = state.currentPuzzle && state.currentPuzzle.id;
  const isFav = state.favorites.some(f=>f.puzzle.id === id);
  document.getElementById('btnFavorite').textContent = isFav ? '★' : '☆';
}

/* ============================================================
     STOCKFISH PROCESSING AND ARROW DATA VECTOR MATH
     ============================================================ */
function squareCenterPct(square){
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10);
  let col = file, row = 8 - rank;
  if(state.boardOrientation === 'black'){ col = 7 - file; row = rank - 1; }
  return { x: (col + 0.5) / 8 * 100, y: (row + 0.5) / 8 * 100 };
}
function clearBoardArrows(){
  const svg = document.getElementById('boardArrows');
  if(svg) svg.innerHTML = '';
}
function drawArrow(from, to, color){
  const svg = document.getElementById('boardArrows');
  if(!svg || from === to) return;
  const NS = 'http://www.w3.org/2000/svg';
  const markerId = 'cptArrow-' + color.replace(/[^a-zA-Z0-9]/g, '');
  if(!svg.querySelector('#' + markerId)){
    let defs = svg.querySelector('defs');
    if(!defs){ defs = document.createElementNS(NS, 'defs'); svg.appendChild(defs); }
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', markerId);
    marker.setAttribute('markerWidth', '3');
    marker.setAttribute('markerHeight', '3');
    marker.setAttribute('refX', '1.6');
    marker.setAttribute('refY', '1.5');
    marker.setAttribute('orient', 'auto');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M0,0 L3,1.5 L0,3 z');
    path.setAttribute('fill', color);
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  const p1 = squareCenterPct(from);
  const p2 = squareCenterPct(to);
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.sqrt(dx*dx + dy*dy) || 1;
  const shorten = 5.5;
  const ex = p2.x - (dx/len) * shorten;
  const ey = p2.y - (dy/len) * shorten;
  const line = document.createElementNS(NS, 'line');
  line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
  line.setAttribute('x2', ex); line.setAttribute('y2', ey);
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '2.6');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('marker-end', 'url(#' + markerId + ')');
  svg.appendChild(line);
}

function initStockfish(){
  if(state.sf) return state.sf;
  try{
    const bootstrap = `importScripts('${CONFIG.STOCKFISH_URL}');`;
    const blobUrl = URL.createObjectURL(new Blob([bootstrap], {type:'application/javascript'}));
    const worker = new Worker(blobUrl);
    worker.onmessage = (e)=> handleEngineLine(typeof e.data === 'string' ? e.data : '');
    worker.onerror = ()=>{
      toast('Engine synchronization fault.');
      state.sf = null;
    };
    worker.postMessage('uci');
    state.sf = worker;
  }catch(err){
    state.sf = null;
  }
  return state.sf;
}

function handleEngineLine(line){
  if(!line) return;
  if(line.startsWith('info') && line.includes(' pv ')){
    const cpMatch = line.match(/score cp (-?\d+)/);
    const mateMatch = line.match(/score mate (-?\d+)/);
    const depthMatch = line.match(/\bdepth (\d+)/);
    const pvMatch = line.match(/ pv (.+)$/);
    state.sfBestLine = {
      cp: cpMatch ? parseInt(cpMatch[1], 10) : null,
      mate: mateMatch ? parseInt(mateMatch[1], 10) : null,
      depth: depthMatch ? parseInt(depthMatch[1], 10) : null,
      pv: pvMatch ? pvMatch[1].trim().split(' ') : []
    };
    renderEnginePanel();
  }else if(line.startsWith('bestmove')){
    const best = line.split(' ')[1];
    const wasContinueMode = state.sfMode === 'continue';
    state.sfMode = null;
    setEngineSearching(false);
    document.getElementById('btnStockfishGo').disabled = false;
    if(wasContinueMode && best && best !== '(none)') playFreeMove(best);
    if(wasContinueMode && state.analysisMode) setDragEnabled(true);
  }
}

function setEngineSearching(isSearching){
  const dot = document.getElementById('engineLiveDot');
  if(!dot) return;
  dot.classList.toggle('searching', isSearching);
  if(!state.analysisMode){ dot.textContent = '○ idle'; return; }
  dot.textContent = isSearching ? '● thinking…' : '● ready';
}

function renderEnginePanel(){
  const evalEl = document.getElementById('engineEval');
  const bestEl = document.getElementById('engineBest');
  const depthEl = document.getElementById('engineDepth');
  const line = state.sfBestLine || {};
  if(line.mate != null){
    evalEl.textContent = '#' + line.mate;
  }else if(line.cp != null){
    const turn = state.chess ? state.chess.turn() : 'w';
    const whiteCp = turn === 'w' ? line.cp : -line.cp;
    evalEl.textContent = (whiteCp >= 0 ? '+' : '') + (whiteCp / 100).toFixed(2);
  }else{
    evalEl.textContent = '—';
  }
  depthEl.textContent = line.depth ?? '—';
  clearBoardArrows();
  if(!state.analysisMode){
    bestEl.textContent = '—';
    return;
  }
  if(line.pv && line.pv.length && state.fenHistory.length){
    try{
      const tmp = new Chess(state.fenHistory[state.viewIndex]);
      const mv = parseUCI(line.pv[0]);
      const res = tmp.move(mv);
      bestEl.textContent = res ? res.san : line.pv[0];
      drawArrow(mv.from, mv.to, '#d4af37');
      if(line.pv[1]){
        const mv2 = parseUCI(line.pv[1]);
        if(tmp.move(mv2)) drawArrow(mv2.from, mv2.to, 'rgba(232,207,118,0.5)');
      }
    }catch(e){ bestEl.textContent = line.pv[0]; }
  }else{
    bestEl.textContent = '—';
  }
}

let liveAnalysisTimer = null;
function scheduleLiveAnalysis(){
  if(!state.analysisMode || !state.fenHistory.length || state.sfMode === 'continue') return;
  clearTimeout(liveAnalysisTimer);
  liveAnalysisTimer = setTimeout(runLiveAnalysis, 220);
}
function runLiveAnalysis(){
  if(!state.analysisMode || !state.fenHistory.length || state.sfMode === 'continue') return;
  const w = initStockfish();
  if(!w) return;
  state.sfMode = 'analyze';
  state.sfBestLine = {};
  renderEnginePanel();
  setEngineSearching(true);
  w.postMessage('stop');
  w.postMessage('position fen ' + state.fenHistory[state.viewIndex]);
  w.postMessage('go depth ' + CONFIG.ENGINE_DEPTH);
}

function playFreeMove(uciStr){
  if(!state.chess) return;
  const mv = parseUCI(uciStr);
  const result = state.chess.move(mv);
  if(!result) return;
  state.fenHistory.push(state.chess.fen());
  state.sanHistory.push(result.san);
  state.viewIndex = state.fenHistory.length - 1;
  clearHighlights();
  state.board.position(state.chess.fen());
  sfx.move();
  renderMoveList();
  updateMoveDisplay();
  updateNavButtons();
  toast('Engine plays: ' + result.san);
}

document.getElementById('btnStockfishGo').addEventListener('click', ()=>{
  if(!state.chess) return toast('Load a puzzle before calling in the engine.');
  if(state.viewIndex !== state.fenHistory.length - 1){ toast('Jump to the latest position before asking the engine.'); return; }
  const w = initStockfish();
  if(!w) return;
  state.solving = false;
  setDragEnabled(false);
  state.sfMode = 'continue';
  setEngineSearching(true);
  document.getElementById('btnStockfishGo').disabled = true;
  w.postMessage('stop');
  w.postMessage('position fen ' + state.chess.fen());
  w.postMessage('go depth ' + CONFIG.ENGINE_DEPTH);
});

document.getElementById('btnCopyFen').addEventListener('click', async ()=>{
  if(!state.fenHistory.length) return;
  const fen = state.fenHistory[state.viewIndex];
  try{ await navigator.clipboard.writeText(fen); toast('FEN copied to clipboard'); }
  catch(e){ toast(fen); }
});
document.getElementById('btnCopyPgn').addEventListener('click', async ()=>{
  if(!state.fenHistory.length) return;
  let pgn = '';
  try{
    const g = new Chess(state.fenHistory[0]);
    state.sanHistory.forEach(san=>g.move(san));
    pgn = g.pgn();
  }catch(e){ pgn = ''; }
  try{ await navigator.clipboard.writeText(pgn); toast('PGN copied to clipboard'); }
  catch(e){ toast('Couldn\'t copy the PGN — try again.'); }
});

/* ---- keyboard shortcuts ---- */
document.addEventListener('keydown', (e)=>{
  if(!document.getElementById('screen-trainer').classList.contains('active')) return;
  if(e.target && /input|textarea|select/i.test(e.target.tagName)) return;
  if(e.key === 'ArrowLeft'){ jumpToFenIndex(state.viewIndex - 1); }
  else if(e.key === 'ArrowRight'){ jumpToFenIndex(state.viewIndex + 1); }
  else if(e.key.toLowerCase() === 'h'){ document.getElementById('btnHint').click(); }
  else if(e.key.toLowerCase() === 'n'){ document.getElementById('btnNext').click(); }
});

/* ============================================================
     STATISTICS RE-CALCULATION
     ============================================================ */
function renderStats(){
  const s = state.stats;
  document.getElementById('stTotal').textContent = s.totalSolved;
  const acc = s.totalAttempts ? Math.round((s.correctFirstTry / s.totalAttempts) * 100) : 0;
  document.getElementById('stAccuracy').textContent = acc + '%';
  document.getElementById('stStreak').textContent = s.currentStreak;
  document.getElementById('stBest').textContent = s.bestStreak;
  document.getElementById('stAvgRating').textContent = s.ratingCount ? Math.round(s.ratingSum / s.ratingCount) : '—';
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('stDaily').textContent = (s.dailyDate === today) ? s.dailyCount : 0;
  document.getElementById('stTime').textContent = Math.round(s.totalTimeMs / 60000) + 'm';
  document.getElementById('stAttempts').textContent = s.totalAttempts;
}
document.getElementById('btnResetStats').addEventListener('click', ()=>{
  if(!confirm('Reset all your stats? This can\'t be undone.')) return;
  state.stats = loadStats();
  localStorage.removeItem('knt_stats');
  renderStats();
  toast('Stats cleared — fresh start.');
});

/* ============================================================
     CONFIGURATION UTILITIES
     ============================================================ */
function wireToggle(id, key, onChange){
  const el = document.getElementById(id);
  el.classList.toggle('on', !!state.settings[key]);
  el.addEventListener('click', ()=>{
    state.settings[key] = !state.settings[key];
    el.classList.toggle('on', state.settings[key]);
    saveSettings();
    if(onChange) onChange(state.settings[key]);
  });
}
wireToggle('toggleSound', 'sound');
wireToggle('toggleAnim', 'animations');
wireToggle('toggleCoords', 'coordinates', v=>{ rebuildBoard(); });
wireToggle('toggleAutoFlip', 'autoFlip');
wireToggle('toggleAutoAdvance', 'autoAdvance');

document.getElementById('selPieceStyle').value = state.settings.pieceStyle;
document.getElementById('selPieceStyle').addEventListener('change', e=>{
  state.settings.pieceStyle = e.target.value;
  saveSettings();
  rebuildBoard();
});

document.querySelectorAll('#boardColorRow .color-dot').forEach(dot=>{
  dot.addEventListener('click', ()=>{
    state.settings.boardColor = dot.dataset.c;
    saveSettings();
    applyBoardColor();
  });
});
function applyBoardColor(){
  const map = {
    brown:{light:'#f0d9b5',dark:'#b58863'},
    green:{light:'#eeeed2',dark:'#779556'},
    blue:{light:'#dee3e6',dark:'#4b6f9e'},
    gray:{light:'#e8e8e8',dark:'#6e6e6e'}
  };
  const c = map[state.settings.boardColor] || map.brown;
  document.documentElement.style.setProperty('--board-light', c.light);
  document.documentElement.style.setProperty('--board-dark', c.dark);
  document.querySelectorAll('#board [data-square-color="white"]').forEach(el=>el.style.background = c.light);
  document.querySelectorAll('#board [data-square-color="black"]').forEach(el=>el.style.background = c.dark);
}

function refreshBoardPosition(animate){
  if(!state.board) return;
  state.board.orientation(state.boardOrientation);
  if(state.fenHistory.length){
    state.board.position(state.fenHistory[state.viewIndex], !!animate);
  }
  applyBoardColor();
}

/* ============================================================
     INITIALIZATION
     ============================================================ */
function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

async function init(){
  applyBoardColor();
  updateNavButtons();
  await loadMasterThemes();

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}
init();
