// Glisser-déposer au doigt : appui long (≈0,3 s) sur un élément `draggable` puis déplacement.
// Le navigateur ne déclenche pas les événements HTML5 de glisser-déposer au toucher : on les rejoue (dragstart, dragover,
// dragleave, drop, dragend) pour que tout le code existant (colonnes, personnes, features, squads) fonctionne sans modification.
const HOLD_MS = 320, SLOP = 10, EDGE = 72, SPEED = 10, MAX_MS = 90_000;

/** Appareil dont le pointeur principal est tactile : le glisser-déposer natif du navigateur y est désactivé (il entrerait en conflit avec le nôtre). */
export const isCoarse = () => matchMedia('(pointer: coarse)').matches && 'ontouchstart' in window;

/** Marque les éléments déplaçables d'une zone : `data-dnd` pour le pont tactile ; `draggable` natif seulement avec une souris. */
export function markDraggables(root) {
  const native = !isCoarse();
  root.querySelectorAll('[draggable], [data-dnd]').forEach(el => { el.dataset.dnd = '1'; el.draggable = native; });
}

export function enableTouchDnd() {
  if (!('ontouchstart' in window)) return;
  let st = null, suppressClickUntil = 0;

  const dataTransfer = () => { const d = {}; return { setData: (k, v) => { d[k] = String(v); }, getData: k => d[k] || '', effectAllowed: 'move', dropEffect: 'move', types: [], files: [] }; };
  const fire = (el, type, x, y, related = null) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(e, { dataTransfer: { value: st.dt }, clientX: { value: x }, clientY: { value: y }, relatedTarget: { value: related } });
    el.dispatchEvent(e);
  };
  const scrollable = (el, axis) => { for (; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el), o = axis === 'y' ? cs.overflowY : cs.overflowX;
    if ((o === 'auto' || o === 'scroll') && (axis === 'y' ? el.scrollHeight > el.clientHeight + 2 : el.scrollWidth > el.clientWidth + 2)) return el;
  } return null; };

  function cancel() { if (st) { clearTimeout(st.timer); st = null; } }

  function activate() {
    if (!st) return;
    st.active = true; navigator.vibrate?.(12);
    const r = st.src.getBoundingClientRect();
    st.ghost = st.src.cloneNode(true); st.ghost.classList.add('touch-ghost');
    Object.assign(st.ghost.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, pointerEvents: 'none', zIndex: 60, margin: 0 });
    st.dx = st.x0 - r.left; st.dy = st.y0 - r.top; st.x = st.x0; st.y = st.y0;
    document.body.append(st.ghost); document.body.classList.add('touch-dragging');
    fire(st.src, 'dragstart', st.x, st.y);
    st.raf = requestAnimationFrame(loop);
    st.max = setTimeout(() => finish(false), MAX_MS);   // filet de sécurité : un glisser ne dure jamais indéfiniment
  }

  /** Boucle : défilement automatique près des bords + rafraîchissement de la cible survolée. */
  function loop() {
    if (!st?.active) return;
    const target = document.elementFromPoint(st.x, st.y);
    if (target) {
      // Les conteneurs défilants se déduisent de l'élément déplacé (le doigt peut être dans la marge, hors du conteneur)
      const vy = scrollable(st.src, 'y') || scrollable(target, 'y') || document.querySelector('#view');
      if (vy && vy !== document.body) { const r = vy.getBoundingClientRect(); const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
        if (st.y < top + EDGE) vy.scrollTop -= SPEED * (1 - (st.y - top) / EDGE); else if (st.y > bottom - EDGE) vy.scrollTop += SPEED * (1 - (bottom - st.y) / EDGE); }
      const hx = scrollable(st.src, 'x') || scrollable(target, 'x');
      if (hx) { const r = hx.getBoundingClientRect(); const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
        if (st.x < left + EDGE) hx.scrollLeft -= SPEED * (1 - (st.x - left) / EDGE); else if (st.x > right - EDGE) hx.scrollLeft += SPEED * (1 - (right - st.x) / EDGE); }
      if (target !== st.over) { if (st.over) fire(st.over, 'dragleave', st.x, st.y, target); st.over = target; }
      fire(target, 'dragover', st.x, st.y);
    }
    st.raf = requestAnimationFrame(loop);
  }

  function finish(drop) {
    if (!st) return;
    clearTimeout(st.timer); clearTimeout(st.max);
    if (st.active) {
      cancelAnimationFrame(st.raf);
      if (drop && st.over) fire(st.over, 'drop', st.x, st.y);
      else if (st.over) fire(st.over, 'dragleave', st.x, st.y, null);
      fire(st.src, 'dragend', st.x, st.y);
      st.ghost?.remove(); document.body.classList.remove('touch-dragging');
      suppressClickUntil = Date.now() + 450;      // le doigt levé ne doit pas « cliquer » (ouvrir la fiche)
    }
    st = null;
  }

  document.addEventListener('touchstart', e => {
    cancel();
    if (e.touches.length !== 1) return;
    const src = e.target.closest?.('[data-dnd]'); if (!src) return;
    const t = e.touches[0];
    st = { src, x0: t.clientX, y0: t.clientY, active: false, dt: dataTransfer(), over: null };
    st.timer = setTimeout(activate, HOLD_MS);
  }, { passive: false });   // non passif : sinon Chrome traite toute la séquence tactile comme défilable et ignore preventDefault sur touchmove

  document.addEventListener('touchmove', e => {
    if (!st) return;
    const t = e.touches[0];
    if (!st.active) { if (Math.hypot(t.clientX - st.x0, t.clientY - st.y0) > SLOP) cancel(); return; }   // le doigt a bougé trop tôt : c'est un défilement
    e.preventDefault();
    st.x = t.clientX; st.y = t.clientY;
    st.ghost.style.left = `${st.x - st.dx}px`; st.ghost.style.top = `${st.y - st.dy}px`;
  }, { passive: false });

  document.addEventListener('touchend', e => { if (st?.active) { e.preventDefault(); finish(true); } else cancel(); }, { passive: false });
  document.addEventListener('touchcancel', () => finish(false));
  // Le navigateur reprend la main (défilement, appel entrant, changement d'onglet…) : on abandonne proprement, sans rien déposer ni laisser d'état bloqué
  document.addEventListener('pointercancel', () => { if (st?.active) finish(false); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(false); });
  window.addEventListener('blur', () => finish(false));
  document.addEventListener('contextmenu', e => { if (st || e.target.closest?.('[data-dnd]')) e.preventDefault(); });
  document.addEventListener('click', e => { if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); } }, true);
}
