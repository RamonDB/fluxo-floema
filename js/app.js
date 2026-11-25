(function () {
  const G = window.GALLERY;
  let session = null; // { token, login } when an editor is logged in
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- Data ---------- */
  // Published artworks live in data/artworks.json (photos in images/obras/) inside the
  // GitHub repository. Visitors read the published copy; logged-in editors read and
  // write the repository directly through the GitHub API.
  const GH = G.github;
  // Fora do GitHub Pages e do teste local (ex.: hospedagem na GoDaddy), os dados publicados e as fotos
  // são lidos direto do repositório, para os visitantes verem as mudanças sem novo upload de arquivos.
  const REMOTE_READ = GH.readFromGitHub !== false && !/^(localhost|127\.0\.0\.1|)$|\.github\.io$/i.test(location.hostname);
  const RAW_BASE = `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${GH.branch}/`;
  let works = [];
  let reorder = null; // { ids, original } while an admin is reordering the grid
  let content = {}; // overrides published in data/content.json
  let headSha = null; // latest commit read by an editor; used to show not-yet-deployed photos
  const allWorks = () => (reorder ? reorder.ids.map((id) => works.find((w) => w.id === id)).filter(Boolean) : works);

  const decodeB64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

  async function gh(path, opts = {}) {
    const url = path.startsWith("https://") ? path : `https://api.github.com/repos/${GH.owner}/${GH.repo}${path}`;
    const res = await fetch(url, {
      ...opts,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
        ...(opts.body ? { "Content-Type": "application/json" } : {})
      }
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async function readRemote() {
    const ref = await gh(`/git/ref/heads/${GH.branch}`);
    const sha = ref.object.sha;
    const commit = await gh(`/git/commits/${sha}`);
    const readJson = async (path, fallback) => {
      try {
        const file = await gh(`/contents/${path}?ref=${sha}`);
        return JSON.parse(decodeB64(file.content));
      } catch (e) {
        if (e.status !== 404) throw e;
        return fallback;
      }
    };
    const [list, rawContent] = await Promise.all([readJson("data/artworks.json", []), readJson("data/content.json", {})]);
    return {
      sha,
      treeSha: commit.tree.sha,
      list: Array.isArray(list) ? list.filter(isValidWork) : [],
      content: cleanContent(rawContent)
    };
  }

  async function existsAt(path, sha) {
    try {
      await gh(`/contents/${path}?ref=${sha}`);
      return true;
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  // Creates a single commit with the updated JSON files plus added/removed image files.
  // mutateWorks / mutateContent receive the latest published data and return the new data.
  async function commitChange({ mutateWorks, mutateContent, addFiles = [], deletePaths = [], message }) {
    const uploaded = [];
    for (const f of addFiles) {
      const blob = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content: f.base64, encoding: "base64" }) });
      uploaded.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (let attempt = 0; ; attempt++) {
      const remote = await readRemote();
      const nextWorks = mutateWorks ? mutateWorks(remote.list) : remote.list;
      const nextContent = mutateContent ? mutateContent(remote.content) : remote.content;
      const entries = [];
      const putJson = (path, data) => entries.push({ path, mode: "100644", type: "blob", content: JSON.stringify(data, null, 2) + "\n" });
      if (mutateWorks) putJson("data/artworks.json", nextWorks);
      if (mutateContent) putJson("data/content.json", nextContent);
      const existing = [];
      for (const p of deletePaths) if (await existsAt(p, remote.sha)) existing.push(p);
      const tree = await gh("/git/trees", {
        method: "POST",
        body: JSON.stringify({
          base_tree: remote.treeSha,
          tree: [...entries, ...uploaded, ...existing.map((p) => ({ path: p, mode: "100644", type: "blob", sha: null }))]
        })
      });
      const commit = await gh("/git/commits", {
        method: "POST",
        body: JSON.stringify({ message, tree: tree.sha, parents: [remote.sha] })
      });
      try {
        await gh(`/git/refs/heads/${GH.branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
        return { list: nextWorks, content: nextContent, sha: commit.sha };
      } catch (e) {
        // 422 = someone else published in the meantime; retry on top of the new commit.
        if (e.status !== 422 || attempt >= 2) throw e;
      }
    }
  }

  async function loadWorks() {
    try {
      if (session) {
        const remote = await readRemote();
        headSha = remote.sha;
        works = remote.list;
        content = remote.content;
      } else {
        const stamp = Date.now();
        // Tries the repository first (when hosted elsewhere), then the copy shipped with the site.
        const getJson = async (path) => {
          for (const base of REMOTE_READ ? [RAW_BASE, ""] : [""]) {
            try {
              const res = await fetch(`${base}${path}?t=${stamp}`, { cache: "no-store" });
              if (res.ok) return await res.json();
            } catch {}
          }
          return null;
        };
        const [data, rawContent] = await Promise.all([getJson("data/artworks.json"), getJson("data/content.json")]);
        if (Array.isArray(data)) works = data.filter(isValidWork);
        content = cleanContent(rawContent);
      }
    } catch (e) {
      console.warn("Não foi possível carregar o conteúdo publicado.", e);
      if (session && (e.status === 401 || e.status === 403)) return logout("Sua sessão expirou ou o token perdeu acesso. Entre novamente.");
    }
    renderContent();
    refresh();
  }

  const state = { filter: "all", onlyAvailable: false, currency: "BRL", list: [], index: 0, imgIndex: 0, room: false };

  const artistOf = (w) => w.artist || G.artist;
  const MAX_PHOTOS = 8;
  // Supports both the legacy single `image` field and the `images` list.
  const photosOf = (w) => (Array.isArray(w.images) ? w.images.filter(Boolean) : w.image ? [w.image] : []);
  const isSafeSrc = (s) => typeof s === "string" && /^(data:image\/|https:\/\/|images\/)/i.test(s) && !s.includes("..");
  // Editors load just-published photos from their commit (the site copy may not be updated yet);
  // visitors on external hosting load photos from the repository; otherwise the local path is used.
  const srcOf = (p) => {
    if (!p.startsWith("images/")) return p;
    if (session && headSha) return `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${headSha}/${p}`;
    return REMOTE_READ ? RAW_BASE + p : p;
  };
  const withSrc = (w) => ({ ...w, image: undefined, images: photosOf(w).map(srcOf) });

  function isValidWork(w) {
    return (
      !!w && typeof w === "object" && !!w.id && !!w.title && !!w.type && !!w.medium &&
      +w.width > 0 && +w.height > 0 && ["available", "reserved", "sold"].includes(w.status) &&
      photosOf(w).every(isSafeSrc)
    );
  }

  function cardMedia(work) {
    const w = withSrc(work);
    const photos = w.images;
    if (photos.length < 2) {
      return `<div class="card-media"><div class="card-art" style="aspect-ratio:${+w.width}/${+w.height}">${renderArtwork(w)}</div></div>`;
    }
    const label = esc(w.title);
    return `
      <div class="card-media carousel" data-count="${photos.length}">
        <div class="carousel-track" tabindex="-1">
          ${photos
            .map(
              (src, i) =>
                `<div class="carousel-slide"><img src="${esc(src)}" alt="${label} — foto ${i + 1} de ${photos.length}" loading="lazy" draggable="false" /></div>`
            )
            .join("")}
        </div>
        <button type="button" class="carousel-btn prev" data-dir="-1" aria-label="Foto anterior">‹</button>
        <button type="button" class="carousel-btn next" data-dir="1" aria-label="Próxima foto">›</button>
        <div class="carousel-dots">${photos
          .map((_, i) => `<button type="button" class="carousel-dot ${i ? "" : "active"}" data-go="${i}" aria-label="Ir para a foto ${i + 1}"></button>`)
          .join("")}</div>
      </div>`;
  }

  function carouselGo(carousel, i) {
    const track = $(".carousel-track", carousel);
    const n = +carousel.dataset.count;
    const target = (i + n) % n;
    $$(".carousel-dot", carousel).forEach((d, j) => d.classList.toggle("active", j === target));
    track.scrollTo({ left: target * track.clientWidth, behavior: "smooth" });
  }
  const carouselIndex = (carousel) => {
    const track = $(".carousel-track", carousel);
    return Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  };
  const datesOf = (w) => (w.artist ? w.artistDates || "" : G.artistDates);

  function price(work) {
    if (work.status === "sold") return "Vendida";
    const value = Number(work.priceBRL || 0) * G.rates[state.currency];
    const fmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: state.currency, maximumFractionDigits: 0 });
    return work.status === "reserved" ? `${fmt.format(value)} — Reservada` : fmt.format(value);
  }

  const inches = (cm) => {
    const v = cm / 2.54, whole = Math.floor(v), frac = Math.round((v - whole) * 8);
    const map = ["", "1/8", "1/4", "3/8", "1/2", "5/8", "3/4", "7/8"];
    return frac === 8 ? `${whole + 1}` : `${whole}${frac ? " " + map[frac] : ""}`;
  };
  const cmLine = (w) => [w.height, w.width, w.depth].filter(Boolean).join(" x ") + " cm";
  const dims = (w) => `${cmLine(w)} [${[w.height, w.width, w.depth].filter(Boolean).map(inches).join(" x ")} in]`;

  /* ---------- Filters ---------- */
  const plural = { Pintura: "Pinturas", Objeto: "Objetos", Gravura: "Gravuras", Escultura: "Esculturas", Fotografia: "Fotografias", Desenho: "Desenhos" };

  function renderFilters() {
    const types = [...new Set(allWorks().map((w) => w.type))];
    if (state.filter !== "all" && !types.includes(state.filter)) state.filter = "all";
    $("#filter-buttons").innerHTML = [["all", "Todas"], ...types.map((t) => [t, plural[t] || t])]
      .map(([v, l]) => `<button class="filter ${state.filter === v ? "active" : ""}" data-filter="${esc(v)}">${esc(l)}</button>`)
      .join("");
  }

  $("#filter-buttons").addEventListener("click", (e) => {
    const b = e.target.closest(".filter");
    if (!b || reorder) return;
    state.filter = b.dataset.filter;
    renderFilters();
    renderGrid();
  });

  /* ---------- Grid ---------- */
  function renderGrid() {
    state.list = allWorks().filter(
      (w) => (state.filter === "all" || w.type === state.filter) && (!state.onlyAvailable || w.status === "available")
    );
    const grid = $("#obras");
    if (!state.list.length) {
      grid.innerHTML = allWorks().length
        ? `<p class="empty">Nenhuma obra encontrada para este filtro.</p>`
        : `<p class="empty">Nenhuma obra publicada no momento.</p>`;
      return;
    }
    grid.innerHTML = state.list
      .map(
        (w, i) => `
      <article class="card" tabindex="0" data-index="${i}" data-id="${esc(w.id)}" aria-label="${esc(w.title)}, ${esc(w.year)}${reorder ? ". Modo de reordenação: use as setas do teclado para mover." : ""}">
        ${cardMedia(w)}
        ${
          reorder
            ? `<span class="card-handle" aria-hidden="true" title="Arraste para mover">⠿</span>
        <span class="card-move-group">
          <button type="button" class="card-move" data-move="-1" aria-label="Mover ${esc(w.title)} para antes" title="Mover para antes">←</button>
          <button type="button" class="card-move" data-move="1" aria-label="Mover ${esc(w.title)} para depois" title="Mover para depois">→</button>
        </span>`
            : isAdmin()
              ? `<button type="button" class="card-edit" data-edit="${i}" aria-label="Editar ${esc(w.title)}" title="Editar obra">✎</button>`
              : ""
        }
        <div class="card-caption">
          <p class="artist"><strong>${esc(artistOf(w))}</strong> ${esc(datesOf(w))}</p>
          <p><em>${esc(w.title)}</em>, ${esc(w.year)}</p>
          <p class="muted">${esc(String(w.medium).split(" [")[0])}</p>
          <p class="muted">${esc(cmLine(w))}</p>
          <p class="card-price ${esc(w.status)}"><span class="dot"></span>${esc(price(w))}</p>
        </div>
      </article>`
      )
      .join("");
    observeCards();
    $$(".carousel-track", grid).forEach((track) =>
      track.addEventListener(
        "scroll",
        () => {
          const carousel = track.parentElement, idx = carouselIndex(carousel);
          $$(".carousel-dot", carousel).forEach((d, j) => d.classList.toggle("active", j === idx));
        },
        { passive: true }
      )
    );
  }

  function observeCards() {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))),
      { threshold: 0.12 }
    );
    $$(".card").forEach((c) => io.observe(c));
  }

  function refresh() {
    renderFilters();
    renderGrid();
  }

  $("#obras").addEventListener("click", (e) => {
    if (reorder) {
      const mv = e.target.closest(".card-move");
      if (mv) moveCard(mv.closest(".card"), +mv.dataset.move);
      return;
    }
    const edit = e.target.closest(".card-edit");
    if (edit) {
      openEditor(state.list[+edit.dataset.edit]);
      return;
    }
    const nav = e.target.closest(".carousel-btn, .carousel-dot");
    if (nav) {
      const carousel = nav.closest(".carousel");
      carouselGo(carousel, nav.dataset.go != null ? +nav.dataset.go : carouselIndex(carousel) + +nav.dataset.dir);
      return;
    }
    const card = e.target.closest(".card");
    if (card) {
      const carousel = $(".carousel", card);
      openViewer(+card.dataset.index, carousel ? carouselIndex(carousel) : 0);
    }
  });
  $("#obras").addEventListener("keydown", (e) => {
    if (reorder) return reorderKey(e);
    if (e.target.closest(".carousel-btn, .carousel-dot, .card-edit")) return;
    const card = e.target.closest(".card");
    const carousel = card && $(".carousel", card);
    if (carousel && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      carouselGo(carousel, carouselIndex(carousel) + (e.key === "ArrowRight" ? 1 : -1));
      return;
    }
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openViewer(+card.dataset.index, carousel ? carouselIndex(carousel) : 0);
    }
  });

  $("#only-available").addEventListener("change", (e) => {
    if (reorder) {
      e.target.checked = state.onlyAvailable;
      return;
    }
    state.onlyAvailable = e.target.checked;
    renderGrid();
  });
  $("#currency").addEventListener("change", (e) => {
    state.currency = e.target.value;
    renderGrid();
    if (!$("#viewer").hidden) renderViewer();
  });

  /* ---------- Reorder artworks (admin) ---------- */
  // Order = position in data/artworks.json. Dragging works with pointer events so mouse and touch behave
  // the same (native HTML5 drag-and-drop does not work on phones). The new order is published only on "Salvar ordem".
  const reorderDirty = () => !!reorder && reorder.ids.join("|") !== reorder.original.join("|");
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gridEl = $("#obras");
  let drag = null;
  let reorderBusy = false;

  function announce(text) {
    $("#reorder-live").textContent = text;
  }

  function updateReorderBar() {
    $("#reorder-save").disabled = !reorderDirty() || reorderBusy;
    $("#reorder-cancel").disabled = reorderBusy;
    $("#reorder-hint").textContent = reorderDirty()
      ? "Ordem alterada. Salve para publicar."
      : "Arraste os cards ou use as setas do teclado.";
  }

  function enterReorder() {
    if (!isAdmin()) return openLogin();
    if (reorder) return;
    if (works.length < 2) return publishStatus("É preciso ter pelo menos 2 obras para reordenar.");
    if (state.filter !== "all" || state.onlyAvailable) {
      return publishStatus("Para reordenar, selecione o filtro “Todas” e desmarque “Somente disponíveis”.", "error");
    }
    publishStatus("");
    reorder = { ids: works.map((w) => w.id), original: works.map((w) => w.id) };
    document.body.classList.add("reordering");
    $("#reorder-bar").hidden = false;
    updateReorderBar();
    renderGrid();
  }

  function exitReorder() {
    reorder = null;
    drag = null;
    document.body.classList.remove("reordering");
    $("#reorder-bar").hidden = true;
    refresh();
  }

  function cancelReorder() {
    if (reorderBusy || drag) return;
    if (reorderDirty() && !confirm("Descartar a nova ordem das obras?")) return;
    exitReorder();
  }

  // FLIP: records positions, applies the DOM change, then animates every card from its old spot.
  function flip(mutate, exclude) {
    const cards = $$(".card", gridEl).filter((c) => c !== exclude);
    const first = new Map(cards.map((c) => [c, c.getBoundingClientRect()]));
    mutate();
    if (reduceMotion()) return;
    for (const c of cards) {
      const a = first.get(c), b = c.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if ((dx || dy) && c.animate) c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 220, easing: "ease" });
    }
  }

  function syncOrderFromDom() {
    reorder.ids = $$(".card", gridEl).map((c) => c.dataset.id);
    updateReorderBar();
  }

  function moveCard(card, dir) {
    const sibling = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
    if (!sibling || !sibling.classList.contains("card")) return;
    flip(() => (dir < 0 ? sibling.before(card) : sibling.after(card)));
    syncOrderFromDom();
    const pos = reorder.ids.indexOf(card.dataset.id) + 1;
    const title = (state.list.find((w) => w.id === card.dataset.id) || {}).title || "Obra";
    announce(`${title}: posição ${pos} de ${reorder.ids.length}.`);
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
  }

  function reorderKey(e) {
    const card = e.target.closest(".card");
    if (!card || e.target !== card || reorderBusy) return;
    const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    moveCard(card, dir);
  }

  function dropTarget() {
    const els = document.elementsFromPoint(drag.x, drag.y);
    for (const el of els) {
      const c = el.closest && el.closest(".card");
      // Cards still sliding into place are visually where they used to be; ignoring them avoids the placeholder flickering back and forth.
      if (c && c !== drag.card && c.parentElement === gridEl && !(c.getAnimations && c.getAnimations().length)) return c;
    }
    return null;
  }

  function placeOver(target) {
    // Passing over a card swaps the placeholder with it: after it when moving forward, before it when moving back.
    const forward = !!(drag.ph.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
    flip(() => (forward ? target.after(drag.ph) : target.before(drag.ph)), drag.card);
  }

  function positionDragged() {
    drag.card.style.left = `${drag.x - drag.offX}px`;
    drag.card.style.top = `${drag.y - drag.offY}px`;
  }

  // Runs every frame while dragging: auto-scroll near the viewport edges and swap with the card under the pointer.
  function dragLoop() {
    if (!drag || !drag.active) return;
    const edge = 100;
    let dy = 0;
    if (drag.y < edge) dy = -Math.ceil((edge - drag.y) / 5);
    else if (drag.y > innerHeight - edge) dy = Math.ceil((drag.y - (innerHeight - edge)) / 5);
    if (dy) window.scrollBy(0, dy);
    const t = dropTarget();
    if (t) placeOver(t);
    drag.raf = requestAnimationFrame(dragLoop);
  }

  function startDrag() {
    const { card } = drag;
    const r = card.getBoundingClientRect();
    drag.offX = drag.startX - r.left;
    drag.offY = drag.startY - r.top;
    const ph = document.createElement("div");
    ph.className = "card-placeholder";
    ph.style.height = `${r.height}px`;
    card.before(ph);
    drag.ph = ph;
    Object.assign(card.style, {
      position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
      margin: "0", zIndex: "60", transition: "none"
    });
    card.classList.add("dragging");
    drag.active = true;
    drag.raf = requestAnimationFrame(dragLoop);
  }

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    if (!d.active) return;
    const { card, ph } = d;
    const from = card.getBoundingClientRect();
    ["position", "left", "top", "width", "height", "margin", "zIndex", "transition"].forEach((p) => (card.style[p] = ""));
    card.classList.remove("dragging");
    ph.replaceWith(card);
    const to = card.getBoundingClientRect();
    if (!reduceMotion() && card.animate) {
      card.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(1.03)` }, { transform: "none" }], { duration: 180, easing: "ease-out" });
    }
    syncOrderFromDom();
    const pos = reorder.ids.indexOf(card.dataset.id) + 1;
    announce(`Obra movida para a posição ${pos} de ${reorder.ids.length}.`);
  }

  gridEl.addEventListener("pointerdown", (e) => {
    if (!reorder || reorderBusy || drag || e.button > 0 || e.target.closest(".card-move")) return;
    const card = e.target.closest(".card");
    if (!card) return;
    // On touch screens only the handle starts a drag, so the page can still be scrolled by swiping on the card.
    if (e.pointerType === "touch" && !e.target.closest(".card-handle")) return;
    if (e.pointerType !== "touch") e.preventDefault();
    drag = { card, id: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false };
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.active) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
      startDrag();
    }
    positionDragged();
  });
  ["pointerup", "pointercancel"].forEach((t) => document.addEventListener(t, (e) => drag && e.pointerId === drag.id && endDrag()));
  gridEl.addEventListener("dragstart", (e) => reorder && e.preventDefault());

  async function saveOrder() {
    if (!reorder || !reorderDirty() || reorderBusy) return;
    const ids = reorder.ids.slice();
    reorderBusy = true;
    updateReorderBar();
    $("#reorder-hint").textContent = "Publicando a nova ordem…";
    try {
      const result = await commitChange({
        message: "Reordena obras",
        mutateWorks: (list) => {
          // Applied on top of the latest published list: works added meanwhile go to the end, removed ones are skipped,
          // and the content of every work stays exactly as published.
          const byId = new Map(list.map((w) => [w.id, w]));
          const ordered = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
          const known = new Set(ids);
          return [...ordered, ...list.filter((w) => !known.has(w.id))];
        }
      });
      works = result.list;
      headSha = result.sha;
      reorderBusy = false;
      exitReorder();
      publishStatus(`Nova ordem das obras salva. ${PUBLISHED_MSG}`, "ok");
    } catch (err) {
      reorderBusy = false;
      updateReorderBar();
      $("#reorder-hint").textContent = ghErrorMessage(err);
    }
  }

  $("#btn-reorder").addEventListener("click", enterReorder);
  $("#reorder-cancel").addEventListener("click", cancelReorder);
  $("#reorder-save").addEventListener("click", saveOrder);
  window.addEventListener("beforeunload", (e) => {
    if (reorderDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  /* ---------- Dialog helpers ---------- */
  let lastFocus = null;
  function openDialog(el) {
    lastFocus = document.activeElement;
    el.hidden = false;
    document.body.classList.add("no-scroll");
  }
  function closeDialog(el) {
    el.hidden = true;
    if ($$(".viewer, .modal").every((d) => d.hidden)) document.body.classList.remove("no-scroll");
    lastFocus && lastFocus.focus();
  }
  function trapFocus(e, root) {
    const f = $$("button, input, select, textarea, label[for]", root).filter((b) => b.offsetParent && !b.disabled);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  }

  /* ---------- Viewer ---------- */
  const viewer = $("#viewer");

  function openViewer(i, imgIndex = 0) {
    state.index = i;
    state.imgIndex = imgIndex;
    state.room = false;
    openDialog(viewer);
    renderViewer();
    $("#btn-close").focus();
  }

  function step(d) {
    const n = state.list.length;
    state.index = (state.index + d + n) % n;
    state.imgIndex = 0;
    renderViewer();
  }

  function renderViewer() {
    const w = state.list[state.index];
    if (!w) return closeDialog(viewer);
    $("#viewer-count").textContent = `${state.index + 1} / ${state.list.length}`;
    $("#viewer-title").innerHTML = `<em>${esc(w.title)}</em>, ${esc(w.year)}`;

    const photos = photosOf(w).map(srcOf);
    if (photos.length) {
      state.imgIndex = Math.min(state.imgIndex, photos.length - 1);
      $("#viewer-image").innerHTML = `<img class="viewer-photo" src="${esc(photos[state.imgIndex])}" alt="${esc(w.title)} — foto ${state.imgIndex + 1} de ${photos.length}" />`;
      $("#viewer-thumbs").innerHTML =
        photos.length < 2
          ? ""
          : photos
              .map(
                (src, i) =>
                  `<button class="thumb ${i === state.imgIndex ? "active" : ""}" data-img="${i}" aria-label="Foto ${i + 1}"><img class="art-img" src="${esc(src)}" alt="" /></button>`
              )
              .join("");
    } else {
      const variants = ["main", "detail"];
      $("#viewer-image").innerHTML = `<div class="viewer-art" style="aspect-ratio:${+w.width}/${+w.height}">${renderArtwork(w, variants[state.imgIndex] || "main")}</div>`;
      $("#viewer-thumbs").innerHTML = variants
        .map(
          (v, i) => `<button class="thumb ${i === state.imgIndex ? "active" : ""}" data-img="${i}" aria-label="${i ? "Detalhe" : "Vista geral"}">${renderArtwork(w, v)}</button>`
        )
        .join("");
    }

    $("#viewer-details").innerHTML = `
      <p><strong>${esc(artistOf(w))}</strong> ${esc(datesOf(w))}</p>
      ${w.signed ? `<p>${esc(w.signed)}</p>` : ""}
      <p>${esc(w.medium)}</p>
      <p>${esc(dims(w))}</p>
      ${w.edition ? `<p>${esc(w.edition)}</p>` : ""}
      <p class="muted">(${esc(w.id)})</p>`;

    $("#viewer-price").className = `price ${esc(w.status)}`;
    $("#viewer-price").innerHTML = `<span class="dot"></span>${esc(price(w))}`;
    $("#btn-enquire").hidden = w.status === "sold";
    $("#btn-edit").hidden = !isAdmin();
    $("#btn-remove").hidden = !isAdmin();

    const section = (title, items) =>
      items && items.length ? `<h3>${title}</h3><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
    $("#viewer-extra").innerHTML = `
      ${w.description ? `<h3>Descrição</h3><p>${esc(w.description)}</p>` : ""}
      ${section("Exposições", w.exhibitions)}
      ${section("Literatura", w.literature)}`;

    // Room view: wall assumed 400 cm wide, artwork hung at eye level.
    $("#room-art").style.width = `${Math.min((w.width / 400) * 100, 90)}%`;
    $("#room-art").style.aspectRatio = `${+w.width}/${+w.height}`;
    $("#room-art").innerHTML = renderArtwork(withSrc(w));
    setRoom(state.room);
  }

  function setRoom(on) {
    state.room = on;
    $("#viewer-room").hidden = !on;
    $("#viewer-image").hidden = on;
    $("#viewer-thumbs").hidden = on;
    $("#btn-room").textContent = on ? "Ver obra" : "Ver no ambiente";
  }

  $("#viewer-thumbs").addEventListener("click", (e) => {
    const t = e.target.closest(".thumb");
    if (t) {
      state.imgIndex = +t.dataset.img;
      renderViewer();
    }
  });
  $("#btn-room").addEventListener("click", () => setRoom(!state.room));
  $("#btn-close").addEventListener("click", () => closeDialog(viewer));
  $("#btn-prev").addEventListener("click", () => step(-1));
  $("#btn-next").addEventListener("click", () => step(1));
  $("#btn-enquire").addEventListener("click", () => {
    const w = state.list[state.index];
    const subject = encodeURIComponent(`Consulta: ${artistOf(w)} — ${w.title} (${w.id})`);
    const body = encodeURIComponent(`Olá,\n\nGostaria de receber mais informações sobre a obra "${w.title}", ${w.year} (${w.id}).\n\nObrigado(a).`);
    window.location.href = `mailto:${G.email}?subject=${subject}&body=${body}`;
  });
  function publishStatus(text, kind = "") {
    const el = $("#publish-status");
    el.textContent = text;
    el.className = `publish-status ${kind}`;
    el.hidden = !text;
  }
  const PUBLISHED_MSG = "Publicado no repositório. Os visitantes verão a mudança em cerca de 1 a 2 minutos.";
  function ghErrorMessage(e) {
    if (e.status === 401) return "Token inválido ou expirado. Saia e entre novamente.";
    if (e.status === 403 || e.status === 404) return "O token não tem permissão de escrita (Contents: Read and write) neste repositório.";
    if (e.status === 409 || e.status === 422) return "O repositório mudou durante a publicação. Tente novamente.";
    return e.message && !e.status ? e.message : "Não foi possível publicar no GitHub. Verifique a conexão e tente novamente.";
  }

  $("#btn-edit").addEventListener("click", () => openEditor(state.list[state.index]));
  $("#btn-remove").addEventListener("click", async () => {
    const w = state.list[state.index];
    if (!isAdmin() || !confirm(`Remover a obra "${w.title}" do site para todos os visitantes?`)) return;
    const btn = $("#btn-remove");
    btn.disabled = true;
    btn.textContent = "Removendo…";
    try {
      const result = await commitChange({
        mutateWorks: (list) => list.filter((x) => x.id !== w.id),
        deletePaths: photosOf(w).filter((p) => p.startsWith("images/obras/")),
        message: `Remove obra ${w.id} — ${w.title}`
      });
      works = result.list;
      headSha = result.sha;
      refresh();
      publishStatus(`Obra removida. ${PUBLISHED_MSG}`, "ok");
      if (!state.list.length) return closeDialog(viewer);
      state.index = Math.min(state.index, state.list.length - 1);
      renderViewer();
    } catch (e) {
      alert(ghErrorMessage(e));
    } finally {
      btn.disabled = false;
      btn.textContent = "Remover obra";
    }
  });

  let touchX = null;
  viewer.addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
  viewer.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
    touchX = null;
  });

  /* ---------- Add artwork ---------- */
  const modal = $("#add-modal");
  const form = $("#add-form");
  const addStatus = $("#add-status");
  let pendingPhotos = []; // [{ src, width, height }] new photos; [{ path, src }] photos already published
  // Edit mode: { id, original (JSON of the work when opened), snapshot (form state), addPhotos (stashed add-mode photos) }
  let editing = null;

  function resizeImage(file, max = 1600) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Não foi possível ler "${file.name}".`));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error(`"${file.name}" não é uma imagem válida.`));
        img.onload = () => {
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * k);
          canvas.height = Math.round(img.height * k);
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve({ src: canvas.toDataURL("image/jpeg", 0.85), width: img.width, height: img.height });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function previewWork() {
    const f = form.elements;
    return {
      id: f.id.value || "preview",
      title: f.title.value || "Pré-visualização",
      width: +f.width.value || 100,
      height: +f.height.value || 100,
      images: pendingPhotos.map((p) => p.src),
      art: { kind: f.kind.value }
    };
  }
  function updatePreview() {
    const w = previewWork();
    $("#add-preview").style.aspectRatio = `${w.width}/${w.height}`;
    $("#add-preview").innerHTML = renderArtwork(w);
    $("#photo-list").innerHTML = pendingPhotos
      .map(
        (p, i) => `
        <li class="photo-item">
          <img src="${esc(p.src)}" alt="Foto ${i + 1}" />
          ${i === 0 ? `<span class="photo-cover">Capa</span>` : `<button type="button" class="photo-act" data-first="${i}" aria-label="Usar foto ${i + 1} como capa">Capa</button>`}
          <button type="button" class="photo-del" data-del="${i}" aria-label="Remover foto ${i + 1}">✕</button>
        </li>`
      )
      .join("");
    form.elements.kind.disabled = pendingPhotos.length > 0;
  }

  $("#photo-list").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]"), first = e.target.closest("[data-first]");
    if (del) pendingPhotos.splice(+del.dataset.del, 1);
    else if (first) pendingPhotos.unshift(...pendingPhotos.splice(+first.dataset.first, 1));
    else return;
    updatePreview();
    saveDraft();
  });

  function nextId(list) {
    const nums = list.map((w) => parseInt(String(w.id).replace(/\D/g, ""), 10)).filter((n) => !isNaN(n));
    return `OBR-${String(Math.max(0, ...nums) + 1).padStart(4, "0")}`;
  }

  function setAddStatus(text, kind = "") {
    addStatus.textContent = text;
    addStatus.className = `form-status ${kind}`;
  }

  /* Draft: unsaved form values (and photos, when they fit) survive closing the modal and reloading. */
  const DRAFT_KEY = "fluxo.addDraft.v1";
  const DRAFT_FIELDS = ["artist", "artistDates", "title", "year", "type", "id", "medium", "signed", "height", "width",
    "depth", "edition", "priceBRL", "status", "description", "exhibitions", "literature", "kind"];
  let draftTimer = null;

  function readDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      return d && typeof d.values === "object" ? d : null;
    } catch {
      return null;
    }
  }
  function saveDraft() {
    clearTimeout(draftTimer);
    if (editing) return; // edits are not drafts of a new artwork
    const values = Object.fromEntries(DRAFT_FIELDS.map((n) => [n, form.elements[n].value]));
    const photos = pendingPhotos.filter((p) => /^data:image\//.test(p.src));
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ values, photos }));
    } catch {
      // Photos too big for browser storage: keep only the text fields (photos stay in memory until reload).
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ values, photos: [] })); } catch {}
    }
  }
  const saveDraftSoon = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 300);
  };
  function clearDraft() {
    clearTimeout(draftTimer);
    localStorage.removeItem(DRAFT_KEY);
    pendingPhotos = [];
  }
  function fillDefaults() {
    form.reset();
    form.elements.artist.value = G.artist;
    form.elements.artistDates.value = G.artistDates;
    form.elements.year.value = new Date().getFullYear();
  }

  function setFormMode(work) {
    const f = form.elements;
    $("#add-title").textContent = work ? `Editar obra — ${work.id}` : "Adicionar obra";
    $("#add-submit").textContent = work ? "Salvar alterações" : "Salvar obra";
    $("#btn-clear-draft").hidden = !!work;
    f.id.readOnly = !!work;
    f.id.title = work ? "O código da obra não pode ser alterado." : "";
  }

  const formSnapshot = () =>
    JSON.stringify({
      values: DRAFT_FIELDS.map((n) => form.elements[n].value),
      photos: pendingPhotos.map((p) => p.path || p.src)
    });
  const isEditDirty = () => !!editing && formSnapshot() !== editing.snapshot;

  function leaveEditMode() {
    if (!editing) return;
    pendingPhotos = editing.addPhotos;
    editing = null;
    setFormMode(null);
  }

  function closeAddModal(force = false) {
    if (form.classList.contains("busy")) return;
    if (!force && isEditDirty() && !confirm("Descartar as alterações feitas nesta obra?")) return;
    closeDialog(modal);
    leaveEditMode();
  }

  function openEditor(work) {
    if (!work) return;
    if (!isAdmin()) return openLogin();
    if (form.classList.contains("busy")) return;
    const addPhotos = editing ? editing.addPhotos : pendingPhotos;
    form.reset();
    const f = form.elements;
    const text = { artist: work.artist || G.artist, artistDates: work.artist ? work.artistDates || "" : G.artistDates,
      title: work.title, year: work.year, type: work.type, id: work.id, medium: work.medium, signed: work.signed,
      height: work.height, width: work.width, depth: work.depth, edition: work.edition, priceBRL: work.priceBRL,
      status: work.status, description: work.description,
      exhibitions: (work.exhibitions || []).join("\n"), literature: (work.literature || []).join("\n"),
      kind: (work.art && work.art.kind) || "rings" };
    Object.entries(text).forEach(([n, v]) => (f[n].value = v ?? ""));
    pendingPhotos = photosOf(work).map((p) => ({ path: p, src: srcOf(p) }));
    editing = { id: work.id, original: JSON.stringify(work), addPhotos };
    setFormMode(work);
    setAddStatus("");
    $$(".invalid", form).forEach((el) => el.classList.remove("invalid"));
    updatePreview();
    editing.snapshot = formSnapshot();
    if (modal.hidden) openDialog(modal);
    f.title.focus();
  }

  $("#btn-add").addEventListener("click", () => {
    if (!isAdmin()) return openLogin();
    if (form.classList.contains("busy")) return;
    leaveEditMode();
    const draft = readDraft();
    fillDefaults();
    setAddStatus("");
    $$(".invalid", form).forEach((el) => el.classList.remove("invalid"));
    if (draft) {
      DRAFT_FIELDS.forEach((n) => draft.values[n] != null && (form.elements[n].value = draft.values[n]));
      if (!pendingPhotos.length && Array.isArray(draft.photos)) pendingPhotos = draft.photos.filter((p) => p && isSafeSrc(p.src));
      setAddStatus("Rascunho restaurado: os últimos valores preenchidos foram recuperados.");
    }
    openDialog(modal);
    updatePreview();
    form.elements.title.focus();
  });

  $("#btn-clear-draft").addEventListener("click", () => {
    if (form.classList.contains("busy")) return;
    if (!confirm("Limpar todos os campos e fotos deste formulário?")) return;
    clearDraft();
    fillDefaults();
    setAddStatus("");
    $$(".invalid", form).forEach((el) => el.classList.remove("invalid"));
    updatePreview();
    form.elements.title.focus();
  });

  form.addEventListener("input", (e) => e.target.name !== "image" && saveDraftSoon());
  form.addEventListener("change", (e) => e.target.name !== "image" && saveDraftSoon());

  $$("[data-close]", modal).forEach((b) => b.addEventListener("click", () => closeAddModal()));
  modal.addEventListener("click", (e) => e.target === modal && closeAddModal());
  ["width", "height", "kind"].forEach((n) => form.elements[n].addEventListener("input", updatePreview));

  form.elements.image.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    const room = MAX_PHOTOS - pendingPhotos.length;
    if (files.length > room) setAddStatus(`Máximo de ${MAX_PHOTOS} fotos por obra; ${files.length - room} foto(s) ignorada(s).`, "error");
    else setAddStatus("");
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        pendingPhotos.push(await resizeImage(file));
      } catch (err) {
        setAddStatus(err.message, "error");
      }
    }
    // Suggest proportional dimensions from the cover photo when only one side was filled in.
    const f = form.elements, cover = pendingPhotos[0];
    if (cover && cover.width) {
      const ratio = cover.height / cover.width;
      if (f.width.value && !f.height.value) f.height.value = Math.round(f.width.value * ratio);
      else if (f.height.value && !f.width.value) f.width.value = Math.round(f.height.value / ratio);
    }
    updatePreview();
    saveDraft();
  });

  const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const slug = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "obra";

  function readFields() {
    const f = form.elements;
    return {
      artist: f.artist.value.trim(),
      artistDates: f.artistDates.value.trim(),
      title: f.title.value.trim(),
      year: /^\d{1,4}$/.test(f.year.value.trim()) ? +f.year.value : f.year.value.trim(),
      type: f.type.value.trim(),
      medium: f.medium.value.trim(),
      signed: f.signed.value.trim(),
      edition: f.edition.value.trim(),
      height: +f.height.value,
      width: +f.width.value,
      ...(+f.depth.value ? { depth: +f.depth.value } : {}),
      priceBRL: +f.priceBRL.value,
      status: f.status.value,
      description: f.description.value.trim(),
      exhibitions: lines(f.exhibitions.value),
      literature: lines(f.literature.value)
    };
  }

  function setFormBusy(busy) {
    form.classList.toggle("busy", busy);
    if (busy) $$("button, input, select, textarea", form).forEach((el) => ((el.dataset.wasDisabled = el.disabled), (el.disabled = true)));
    else {
      $$("button, input, select, textarea", form).forEach((el) => (el.disabled = el.dataset.wasDisabled === "true"));
      form.elements.kind.disabled = pendingPhotos.length > 0;
    }
  }

  async function saveEdit() {
    const { id, original } = editing;
    if (!isEditDirty()) {
      setAddStatus("Nenhuma alteração para salvar.");
      return;
    }
    const stamp = Date.now().toString(36);
    let n = 0;
    // Keeps the chosen order: published photos keep their path, new ones get a new file.
    const files = [];
    const images = pendingPhotos.map((p) => {
      if (p.path) return p.path;
      const path = `images/obras/${slug(id)}-${stamp}-${++n}.jpg`;
      files.push({ path, base64: p.src.split(",")[1] });
      return path;
    });
    const removed = photosOf(JSON.parse(original)).filter((p) => !images.includes(p) && p.startsWith("images/obras/"));
    const fields = readFields();
    const title = fields.title;

    setFormBusy(true);
    setAddStatus(files.length ? `Publicando alterações e ${files.length} foto(s) nova(s)… não feche esta janela.` : "Publicando alterações…");
    try {
      const result = await commitChange({
        addFiles: files,
        deletePaths: removed,
        message: `Edita obra ${id} — ${title}`,
        mutateWorks: (list) => {
          const idx = list.findIndex((w) => w.id === id);
          const conflict = (msg) => Object.assign(new Error(msg), { status: 0 });
          if (idx < 0) throw conflict("Esta obra foi removida por outro editor. Feche o formulário para ver a versão atual.");
          // Refuses to overwrite changes another editor published after this form was opened.
          if (JSON.stringify(list[idx]) !== original) {
            throw conflict("Esta obra foi alterada por outro editor enquanto você editava. Feche e abra a edição novamente para ver a versão atual (suas alterações não foram salvas).");
          }
          const { image, images: _old, art, depth, ...current } = list[idx];
          const next = {
            ...current,
            ...fields,
            id,
            ...(current.createdAt ? { createdAt: current.createdAt } : {}),
            updatedAt: new Date().toISOString(),
            ...(images.length ? { images } : { art: { kind: form.elements.kind.value } })
          };
          return list.map((w, i) => (i === idx ? next : w));
        }
      });
      works = result.list;
      headSha = result.sha;
      setFormBusy(false);
      closeDialog(modal);
      leaveEditMode();
      refresh();
      if (!viewer.hidden) {
        const i = state.list.findIndex((w) => w.id === id);
        if (i < 0) closeDialog(viewer);
        else {
          state.index = i;
          state.imgIndex = 0;
          renderViewer();
        }
      }
      publishStatus(`"${title}" atualizada. ${PUBLISHED_MSG}`, "ok");
    } catch (err) {
      setAddStatus(err.status === 0 ? err.message : ghErrorMessage(err), "error");
    } finally {
      if (form.classList.contains("busy")) setFormBusy(false);
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isAdmin() || form.classList.contains("busy")) return;
    const f = form.elements;
    $$(".invalid", form).forEach((el) => el.classList.remove("invalid"));
    if (!form.checkValidity()) {
      const bad = $$(":invalid", form).filter((el) => el.name);
      bad.forEach((el) => el.classList.add("invalid"));
      setAddStatus("Preencha os campos obrigatórios (*) corretamente.", "error");
      bad[0] && bad[0].focus();
      return;
    }
    if (editing) return saveEdit();
    const typedId = f.id.value.trim();
    if (typedId && works.some((w) => String(w.id).toLowerCase() === typedId.toLowerCase())) {
      f.id.classList.add("invalid");
      setAddStatus(`Já existe uma obra com o código "${typedId}".`, "error");
      f.id.focus();
      return;
    }

    const id = typedId || nextId(works);
    const stamp = Date.now().toString(36);
    const files = pendingPhotos.map((p, i) => ({
      path: `images/obras/${slug(id)}-${stamp}-${i + 1}.jpg`,
      base64: p.src.split(",")[1]
    }));
    const base = {
      ...readFields(),
      createdAt: new Date().toISOString(),
      ...(files.length ? { images: files.map((x) => x.path) } : { art: { kind: form.elements.kind.value } })
    };

    form.classList.add("busy");
    $$("button, input, select, textarea", form).forEach((el) => (el.dataset.wasDisabled = el.disabled, el.disabled = true));
    setAddStatus(files.length ? `Publicando obra e ${files.length} foto(s)… não feche esta janela.` : "Publicando obra…");
    let savedId = id;
    try {
      const result = await commitChange({
        addFiles: files,
        message: `Adiciona obra ${id} — ${base.title}`,
        mutateWorks: (list) => {
          // Re-check against the latest repository state (another editor may have published).
          if (typedId && list.some((w) => String(w.id).toLowerCase() === typedId.toLowerCase())) {
            throw Object.assign(new Error(`Já existe uma obra com o código "${typedId}".`), { status: 0 });
          }
          savedId = typedId || (list.some((w) => w.id === id) ? nextId(list) : id);
          return [...list, { id: savedId, ...base }];
        }
      });
      works = result.list;
      headSha = result.sha;
      clearDraft();
      form.classList.remove("busy");
      closeDialog(modal);
      state.filter = "all";
      refresh();
      publishStatus(`"${base.title}" ${PUBLISHED_MSG.charAt(0).toLowerCase()}${PUBLISHED_MSG.slice(1)}`, "ok");
      const card = $(`.card[data-index="${state.list.findIndex((w) => w.id === savedId)}"]`);
      card && card.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (err) {
      setAddStatus(err.status === 0 ? err.message : ghErrorMessage(err), "error");
    } finally {
      form.classList.remove("busy");
      $$("button, input, select, textarea", form).forEach((el) => (el.disabled = el.dataset.wasDisabled === "true"));
      form.elements.kind.disabled = pendingPhotos.length > 0;
    }
  });

  /* ---------- Editable site texts ---------- */
  // Defaults live in js/content-default.js; texts edited by the admin are stored as overrides in
  // data/content.json. Text format: blank line = new paragraph, *text* = italic (no HTML allowed).
  const DEFAULTS = window.DEFAULT_CONTENT;
  const MAX_ARTISTS = 12;
  const PORTRAIT_KINDS = ["sphere", "rings", "waves", "squares", "checker", "bars", "glow", "mobile"];

  const inline = (t) => esc(t).replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  const paragraphsOf = (t) =>
    String(t || "")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => inline(p).replace(/\n/g, "<br>"));

  const isArtistPhoto = (p) => typeof p === "string" && p.startsWith("images/artistas/") && isSafeSrc(p);

  // Validates/normalises one section coming from the repository or from a saved draft.
  function sanitizeSection(section, d) {
    if (!d || typeof d !== "object") return null;
    const s = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
    if (section === "curatorial") {
      return { title: s(d.title, 200), artists: s(d.artists, 300), body: s(d.body, 30000), author: s(d.author, 200) };
    }
    if (!Array.isArray(d.items)) return null;
    return {
      title: s(d.title, 200),
      items: d.items
        .filter((it) => it && typeof it === "object")
        .slice(0, MAX_ARTISTS)
        .map((it, i) => ({
          id: s(it.id, 40) || `a${i}`,
          name: s(it.name, 200),
          line: s(it.line, 300),
          text: s(it.text, 10000),
          photo: isArtistPhoto(it.photo) ? it.photo : "",
          newPhoto: it.newPhoto && typeof it.newPhoto.src === "string" && /^data:image\//.test(it.newPhoto.src) ? { src: it.newPhoto.src } : null
        }))
    };
  }

  function cleanContent(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    const cur = sanitizeSection("curatorial", raw.curatorial);
    if (cur) out.curatorial = cur;
    const art = sanitizeSection("artists", raw.artists);
    if (art) out.artists = { ...art, items: art.items.map(({ newPhoto: _, ...it }) => it) };
    return out;
  }

  const curatorialNow = () => ({ ...DEFAULTS.curatorial, ...(content.curatorial || {}) });
  const artistsNow = () => content.artists || DEFAULTS.artists;

  function renderContent() {
    const c = curatorialNow();
    const paras = paragraphsOf(c.body);
    const cur = $("#curatorial");
    cur.innerHTML = `
      <header class="curatorial-head">
        ${c.title ? `<h2 id="curatorial-title">${inline(c.title)}</h2>` : ""}
        ${c.artists ? `<p class="curatorial-artists">${inline(c.artists)}</p>` : ""}
      </header>
      <div class="curatorial-body">
        ${paras.slice(0, 1).map((p) => `<p class="lead">${p}</p>`).join("")}
        ${paras.length > 1 ? `<button type="button" class="link-btn curatorial-toggle" aria-expanded="false" aria-controls="curatorial-more">Ler mais</button>` : ""}
        <div id="curatorial-more"${paras.length > 1 ? " hidden" : ""}>
          ${paras.slice(1).map((p) => `<p>${p}</p>`).join("")}
          ${c.author ? `<p class="curatorial-author">${inline(c.author)}</p>` : ""}
        </div>
      </div>`;
    cur.classList.remove("content-pending");
    const toggle = cur.querySelector(".curatorial-toggle");
    if (toggle) {
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open));
        toggle.textContent = open ? "Ler menos" : "Ler mais";
        $("#curatorial-more").hidden = !open;
      });
    }

    const a = artistsNow();
    $("#artists-title").textContent = a.title;
    const list = $("#artists-list");
    list.innerHTML = a.items
      .map((it, i) => {
        const media = it.photo
          ? `<img class="artist-photo" src="${esc(srcOf(it.photo))}" alt="${esc(it.name)}" loading="lazy" />`
          : renderArtwork({ id: `portrait-${i}`, title: it.name, width: 130, height: 130, art: { kind: PORTRAIT_KINDS[i % PORTRAIT_KINDS.length] } });
        return `
        <article class="artist-item">
          <div class="artist-portrait ${it.photo ? "has-photo" : ""}" ${it.photo ? "" : 'aria-hidden="true"'}>${media}</div>
          <div class="artist-text">
            ${it.name ? `<h3>${inline(it.name)}</h3>` : ""}
            ${it.line ? `<p class="meta">${inline(it.line)}</p>` : ""}
            ${paragraphsOf(it.text).map((p) => `<p>${p}</p>`).join("")}
          </div>
        </article>`;
      })
      .join("");
    list.classList.remove("content-pending");
  }

  /* Editor */
  const cmodal = $("#content-modal");
  const cform = $("#content-form");
  const cfields = $("#content-fields");
  const cstatus = $("#content-status");
  let editor = null; // { section, data }
  let contentDraftTimer = null;
  const draftKey = (section) => `fluxo.contentDraft.v1:${section}`;
  const SECTION_LABEL = { curatorial: "texto da exposição", artists: "artistas" };

  function setCstatus(text, kind = "") {
    cstatus.textContent = text;
    cstatus.className = `form-status ${kind}`;
  }
  const newArtistItem = () => ({ id: `a${Math.random().toString(36).slice(2, 8)}`, name: "", line: "", text: "", photo: "", newPhoto: null });
  const cloneForEdit = (section) => {
    if (section === "curatorial") return { ...curatorialNow() };
    const a = artistsNow();
    return { title: a.title, items: a.items.map((it) => ({ ...it, newPhoto: null })) };
  };

  function saveContentDraft() {
    clearTimeout(contentDraftTimer);
    if (!editor) return;
    const key = draftKey(editor.section);
    try {
      localStorage.setItem(key, JSON.stringify(editor.data));
    } catch {
      // Photos too big for browser storage: keep only the text.
      try {
        const d = editor.data;
        localStorage.setItem(key, JSON.stringify(d.items ? { ...d, items: d.items.map((it) => ({ ...it, newPhoto: null })) } : d));
      } catch {}
    }
  }
  const saveContentDraftSoon = () => {
    clearTimeout(contentDraftTimer);
    contentDraftTimer = setTimeout(saveContentDraft, 300);
  };
  function readContentDraft(section) {
    try {
      return sanitizeSection(section, JSON.parse(localStorage.getItem(draftKey(section)) || "null"));
    } catch {
      return null;
    }
  }
  function clearContentDraft(section) {
    clearTimeout(contentDraftTimer);
    localStorage.removeItem(draftKey(section));
  }

  function artistEditor(it, i, total) {
    const thumb = it.newPhoto
      ? `<img src="${esc(it.newPhoto.src)}" alt="" />`
      : it.photo
      ? `<img src="${esc(srcOf(it.photo))}" alt="" />`
      : `<span class="muted">Sem foto</span>`;
    const hasPhoto = !!(it.newPhoto || it.photo);
    return `
      <fieldset class="artist-edit" data-i="${i}">
        <legend>Artista ${i + 1}</legend>
        <div class="artist-edit-tools">
          <button type="button" class="link-btn" data-act="up" ${i === 0 ? "disabled" : ""} aria-label="Mover para cima">↑ Subir</button>
          <button type="button" class="link-btn" data-act="down" ${i === total - 1 ? "disabled" : ""} aria-label="Mover para baixo">↓ Descer</button>
          <button type="button" class="link-btn danger" data-act="remove">Remover artista</button>
        </div>
        <div class="form-grid">
          <div class="field"><label for="ae-name-${i}">Nome *</label><input id="ae-name-${i}" data-k="name" value="${esc(it.name)}" /></div>
          <div class="field"><label for="ae-line-${i}">Linha de apresentação</label><input id="ae-line-${i}" data-k="line" value="${esc(it.line)}" placeholder="Cidade, ano de nascimento" /></div>
        </div>
        <div class="field full" style="margin-top:16px"><label for="ae-text-${i}">Texto</label><textarea id="ae-text-${i}" data-k="text" rows="6">${esc(it.text)}</textarea></div>
        <div class="artist-edit-photo">
          <div class="artist-edit-thumb">${thumb}</div>
          <div class="artist-edit-photo-actions">
            <label class="link-btn" for="ae-photo-${i}">${hasPhoto ? "Trocar foto" : "Enviar foto"}</label>
            <input id="ae-photo-${i}" type="file" accept="image/*" data-photo hidden />
            ${hasPhoto ? `<button type="button" class="link-btn" data-act="clear-photo">Remover foto</button>` : ""}
          </div>
        </div>
      </fieldset>`;
  }

  function renderEditor() {
    const d = editor.data;
    if (editor.section === "curatorial") {
      cfields.innerHTML = `
        <div class="form-grid">
          <div class="field"><label for="ce-title">Título</label><input id="ce-title" data-k="title" value="${esc(d.title)}" /></div>
          <div class="field"><label for="ce-artists">Artistas (abaixo do título)</label><input id="ce-artists" data-k="artists" value="${esc(d.artists)}" /></div>
        </div>
        <div class="field full" style="margin-top:16px"><label for="ce-body">Texto</label><textarea id="ce-body" data-k="body" rows="16">${esc(d.body)}</textarea></div>
        <div class="field" style="margin-top:16px"><label for="ce-author">Assinatura</label><input id="ce-author" data-k="author" value="${esc(d.author)}" /></div>`;
    } else {
      cfields.innerHTML = `
        <div class="field"><label for="ae-title">Título da seção</label><input id="ae-title" data-k="title" value="${esc(d.title)}" /></div>
        <div class="artist-edit-list">${d.items.map((it, i) => artistEditor(it, i, d.items.length)).join("")}</div>
        <button type="button" class="link-btn" id="btn-add-artist" ${d.items.length >= MAX_ARTISTS ? "disabled" : ""}>+ Adicionar artista</button>`;
    }
  }

  function openContentEditor(section) {
    if (!isAdmin()) return openLogin();
    const draft = readContentDraft(section);
    editor = { section, data: draft || cloneForEdit(section) };
    $("#content-title").textContent = section === "curatorial" ? "Editar texto da exposição" : "Editar artistas";
    setCstatus(draft ? "Rascunho restaurado: suas últimas alterações não publicadas foram recuperadas." : "");
    $("#btn-content-discard").hidden = !draft;
    renderEditor();
    openDialog(cmodal);
    const first = $("input, textarea", cfields);
    first && first.focus();
  }

  const busyContent = (on) => {
    cform.classList.toggle("busy", on);
    $$("button, input, select, textarea", cform).forEach((el) => {
      if (on) (el.dataset.wasDisabled = el.disabled, (el.disabled = true));
      else el.disabled = el.dataset.wasDisabled === "true";
    });
  };

  $("#btn-edit-curatorial").addEventListener("click", () => openContentEditor("curatorial"));
  $("#btn-edit-artists").addEventListener("click", () => openContentEditor("artists"));
  $$("[data-close]", cmodal).forEach((b) => b.addEventListener("click", () => !cform.classList.contains("busy") && closeDialog(cmodal)));
  cmodal.addEventListener("click", (e) => e.target === cmodal && !cform.classList.contains("busy") && closeDialog(cmodal));

  cfields.addEventListener("input", (e) => {
    const k = e.target.dataset.k;
    if (!k || !editor) return;
    const block = e.target.closest(".artist-edit");
    if (block) editor.data.items[+block.dataset.i][k] = e.target.value;
    else editor.data[k] = e.target.value;
    saveContentDraftSoon();
  });

  cfields.addEventListener("click", (e) => {
    if (!editor) return;
    if (e.target.id === "btn-add-artist") {
      if (editor.data.items.length >= MAX_ARTISTS) return;
      editor.data.items.push(newArtistItem());
      renderEditor();
      saveContentDraft();
      const names = $$('[data-k="name"]', cfields);
      names[names.length - 1].focus();
      return;
    }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const i = +btn.closest(".artist-edit").dataset.i;
    const items = editor.data.items;
    switch (btn.dataset.act) {
      case "up":
        if (i > 0) [items[i - 1], items[i]] = [items[i], items[i - 1]];
        break;
      case "down":
        if (i < items.length - 1) [items[i + 1], items[i]] = [items[i], items[i + 1]];
        break;
      case "remove":
        if (!confirm(`Remover ${items[i].name ? `"${items[i].name}"` : "este artista"} da lista? A mudança só vale depois de salvar.`)) return;
        items.splice(i, 1);
        break;
      case "clear-photo":
        items[i].photo = "";
        items[i].newPhoto = null;
        break;
    }
    renderEditor();
    saveContentDraft();
  });

  cfields.addEventListener("change", async (e) => {
    if (!editor || !e.target.matches("[data-photo]")) return;
    const i = +e.target.closest(".artist-edit").dataset.i;
    const file = e.target.files[0];
    if (!file) return;
    try {
      const p = await resizeImage(file, 1200);
      editor.data.items[i].newPhoto = { src: p.src };
      setCstatus("");
    } catch (err) {
      setCstatus(err.message, "error");
    }
    renderEditor();
    saveContentDraft();
  });

  $("#btn-content-discard").addEventListener("click", () => {
    if (!editor || cform.classList.contains("busy")) return;
    clearContentDraft(editor.section);
    editor.data = cloneForEdit(editor.section);
    $("#btn-content-discard").hidden = true;
    setCstatus("");
    renderEditor();
  });

  cform.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isAdmin() || !editor || cform.classList.contains("busy")) return;
    const { section, data } = editor;
    let final;
    let addFiles = [];
    let deletePaths = [];

    if (section === "curatorial") {
      final = { title: data.title.trim(), artists: data.artists.trim(), body: data.body.trim(), author: data.author.trim() };
      if (!final.title && !final.body) return setCstatus("Preencha ao menos o título ou o texto.", "error");
    } else {
      const bad = data.items.findIndex((it) => !it.name.trim());
      if (bad >= 0) {
        setCstatus("Informe o nome de cada artista.", "error");
        return $(`#ae-name-${bad}`).focus();
      }
      const stamp = Date.now().toString(36);
      const items = data.items.map((it, i) => {
        let photo = it.photo;
        if (it.newPhoto) {
          photo = `images/artistas/${slug(it.name)}-${stamp}-${i + 1}.jpg`;
          addFiles.push({ path: photo, base64: it.newPhoto.src.split(",")[1] });
        }
        return { id: it.id, name: it.name.trim(), line: it.line.trim(), text: it.text.trim(), photo };
      });
      final = { title: data.title.trim(), items };
      deletePaths = artistsNow().items.map((it) => it.photo).filter(isArtistPhoto).filter((p) => !items.some((it) => it.photo === p));
    }

    busyContent(true);
    setCstatus(addFiles.length ? `Publicando texto e ${addFiles.length} foto(s)… não feche esta janela.` : "Publicando…");
    try {
      const result = await commitChange({
        mutateContent: (c) => ({ ...c, [section]: final }),
        addFiles,
        deletePaths,
        message: `Atualiza ${SECTION_LABEL[section]}`
      });
      content = result.content;
      headSha = result.sha;
      clearContentDraft(section);
      busyContent(false);
      closeDialog(cmodal);
      renderContent();
      publishStatus(`Texto atualizado. ${PUBLISHED_MSG}`, "ok");
    } catch (err) {
      setCstatus(ghErrorMessage(err), "error");
    } finally {
      busyContent(false);
    }
  });

  $("#btn-content-restore").addEventListener("click", async () => {
    if (!isAdmin() || !editor || cform.classList.contains("busy")) return;
    const section = editor.section;
    if (!confirm(`Restaurar ${section === "curatorial" ? "o texto da exposição" : "a seção de artistas"} para a versão original? O que está publicado será substituído para todos os visitantes.`)) return;
    if (!content[section]) {
      clearContentDraft(section);
      editor.data = cloneForEdit(section);
      $("#btn-content-discard").hidden = true;
      renderEditor();
      return setCstatus("O texto publicado já é o original.");
    }
    const deletePaths = section === "artists" ? (content.artists.items || []).map((it) => it.photo).filter(isArtistPhoto) : [];
    busyContent(true);
    setCstatus("Restaurando…");
    try {
      const result = await commitChange({
        mutateContent: (c) => {
          const next = { ...c };
          delete next[section];
          return next;
        },
        deletePaths,
        message: `Restaura ${SECTION_LABEL[section]} para o original`
      });
      content = result.content;
      headSha = result.sha;
      clearContentDraft(section);
      busyContent(false);
      closeDialog(cmodal);
      renderContent();
      publishStatus(`Texto restaurado. ${PUBLISHED_MSG}`, "ok");
    } catch (err) {
      setCstatus(ghErrorMessage(err), "error");
    } finally {
      busyContent(false);
    }
  });

  /* ---------- Keyboard ---------- */
  document.addEventListener("keydown", (e) => {
    if (!cmodal.hidden) {
      if (e.key === "Escape") closeDialog(cmodal);
      else if (e.key === "Tab") trapFocus(e, cmodal);
      return;
    }
    const loginModal = $("#login-modal");
    if (!loginModal.hidden) {
      if (e.key === "Escape") closeDialog(loginModal);
      else if (e.key === "Tab") trapFocus(e, loginModal);
      return;
    }
    if (!modal.hidden) {
      if (e.key === "Escape") closeAddModal();
      else if (e.key === "Tab") trapFocus(e, modal);
      return;
    }
    if (viewer.hidden) {
      if (reorder && e.key === "Escape") cancelReorder();
      return;
    }
    if (e.key === "Escape") closeDialog(viewer);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "Tab") trapFocus(e, viewer);
  });

  /* ---------- Header, hero, nav ---------- */
  const header = $("#site-header");
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 40);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const toggle = $(".nav-toggle");
  toggle.addEventListener("click", () => {
    const open = header.classList.toggle("nav-open");
    toggle.setAttribute("aria-expanded", open);
  });
  $$("#nav-list a").forEach((a) =>
    a.addEventListener("click", () => {
      header.classList.remove("nav-open");
      toggle.setAttribute("aria-expanded", "false");
    })
  );


  /* ---------- Contact ---------- */
  $("#contact-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const cf = e.target;
    const status = $(".form-status", cf);
    if (!cf.checkValidity()) {
      status.textContent = "Por favor, preencha todos os campos corretamente.";
      status.className = "form-status error";
      $(":invalid", cf).focus();
      return;
    }
    status.textContent = "Obrigado! Sua mensagem foi enviada. Entraremos em contato em breve.";
    status.className = "form-status ok";
    cf.reset();
  });

  $("#year").textContent = new Date().getFullYear();
  /* ---------- Auth ---------- */
  // Login = usuário + senha (hash em data.js). O token do GitHub é informado só na primeira vez em
  // cada navegador e fica salvo nele criptografado com a senha (PBKDF2 + AES-GCM).
  const AUTH_KEY = "fluxo.ghSession.v1";
  const VAULT_KEY = `fluxo.ghVault.v1:${GH.owner}/${GH.repo}`;
  const ADMIN = G.admin;
  const isAdmin = () => !!session;

  const enc = new TextEncoder();
  const toB64 = (u8) => btoa(String.fromCharCode(...u8));
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  function requireCrypto() {
    if (!(window.crypto && crypto.subtle)) throw Object.assign(new Error("Este navegador não permite login neste endereço (use HTTPS)."), { status: 0 });
  }
  async function sha256(text) {
    requireCrypto();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function deriveKey(password, salt) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }
  function readVault() {
    try {
      const v = JSON.parse(localStorage.getItem(VAULT_KEY) || "null");
      return v && v.salt && v.iv && v.ct ? v : null;
    } catch {
      return null;
    }
  }
  async function saveVault(token, password, login) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(token)));
    localStorage.setItem(VAULT_KEY, JSON.stringify({ v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct), login }));
  }
  async function openVault(vault, password) {
    const key = await deriveKey(password, fromB64(vault.salt));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(vault.iv) }, key, fromB64(vault.ct));
    return new TextDecoder().decode(pt);
  }

  function readSession() {
    for (const store of [sessionStorage, localStorage]) {
      try {
        const s = JSON.parse(store.getItem(AUTH_KEY) || "null");
        if (s && typeof s.token === "string" && s.token) return s;
      } catch {}
      store.removeItem(AUTH_KEY);
    }
    return null;
  }

  function applyAuth() {
    const admin = isAdmin();
    document.body.classList.toggle("is-admin", admin);
    $("#btn-login").hidden = admin;
    $("#user-box").hidden = !admin;
    $("#user-name").textContent = admin ? session.login : "";
    $("#manage").hidden = !admin;
    if (!admin) {
      headSha = null;
      publishStatus("");
      if (reorder) {
        reorder = null;
        drag = null;
        reorderBusy = false;
        document.body.classList.remove("reordering");
        $("#reorder-bar").hidden = true;
      }
      if (!modal.hidden) closeAddModal(true);
      if (!cmodal.hidden) closeDialog(cmodal);
    }
    refresh();
    if (!viewer.hidden) renderViewer();
  }

  const loginModal = $("#login-modal");
  const loginForm = $("#login-form");
  const loginStatus = $("#login-status");

  function setLoginStatus(text, kind = "") {
    loginStatus.textContent = text;
    loginStatus.className = `form-status ${kind}`;
  }
  // Shows the token field only when this browser has no saved token (or the user wants to replace it).
  function showTokenField(show) {
    const vault = readVault();
    const needToken = show || !vault;
    $("#token-block").hidden = !needToken;
    $("#token-saved").hidden = needToken;
    $("#token-saved-login").textContent = vault && vault.login ? ` (conta ${vault.login})` : "";
  }

  function openLogin(message = "") {
    loginForm.reset();
    setLoginStatus(message, message ? "error" : "");
    showTokenField(false);
    openDialog(loginModal);
    loginForm.elements.user.focus();
  }

  function logout(message = "") {
    session = null;
    sessionStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_KEY);
    applyAuth();
    loadWorks();
    if (message) openLogin(message);
    else $("#btn-login").focus();
  }

  $("#btn-login").addEventListener("click", () => openLogin());
  $("#btn-new-token").addEventListener("click", () => {
    showTokenField(true);
    loginForm.elements.token.focus();
  });
  $$("[data-close]", loginModal).forEach((b) => b.addEventListener("click", () => closeDialog(loginModal)));
  loginModal.addEventListener("click", (e) => e.target === loginModal && closeDialog(loginModal));

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = loginForm.elements;
    const submit = $("button[type=submit]", loginForm);
    const user = f.user.value.trim(), password = f.password.value;
    const askingToken = !$("#token-block").hidden;
    const typedToken = f.token.value.trim();
    if (!user || !password) return setLoginStatus("Informe usuário e senha.", "error");
    if (askingToken && !typedToken) {
      setLoginStatus("Cole o token do GitHub (necessário só na primeira vez neste navegador).", "error");
      return f.token.focus();
    }

    submit.disabled = true;
    const previous = session;
    try {
      if (user !== ADMIN.user || (await sha256(`${ADMIN.salt}:${password}`)) !== ADMIN.passwordHash) {
        setLoginStatus("Usuário ou senha inválidos.", "error");
        f.password.value = "";
        f.password.focus();
        await new Promise((r) => setTimeout(r, 1200));
        return;
      }

      let token = typedToken;
      if (!askingToken) {
        try {
          token = await openVault(readVault(), password);
        } catch {
          showTokenField(true);
          setLoginStatus("Não foi possível abrir o token salvo neste navegador (a senha mudou?). Cole o token novamente.", "error");
          return f.token.focus();
        }
      }

      setLoginStatus("Verificando acesso ao repositório…");
      session = { token, login: "" };
      let ghUser;
      try {
        const [u, repo] = await Promise.all([gh("https://api.github.com/user"), gh("")]);
        if (repo.permissions && !repo.permissions.push) throw Object.assign(new Error(), { status: 403 });
        ghUser = u;
      } catch (err) {
        session = previous;
        const msg =
          err.status === 401
            ? "Token inválido ou expirado."
            : err.status === 403 || err.status === 404
            ? `Este token não tem acesso de escrita a ${GH.owner}/${GH.repo}.`
            : "Não foi possível falar com o GitHub. Verifique a conexão.";
        if (!askingToken && (err.status === 401 || err.status === 403 || err.status === 404)) {
          // The saved token no longer works: forget it and ask for a new one.
          localStorage.removeItem(VAULT_KEY);
          showTokenField(true);
          setLoginStatus(`${msg} Cole um novo token.`, "error");
          return f.token.focus();
        }
        setLoginStatus(msg, "error");
        return askingToken ? f.token.focus() : undefined;
      }

      if (askingToken) await saveVault(token, password, ghUser.login);
      session = { token, login: ghUser.login };
      (f.remember.checked ? localStorage : sessionStorage).setItem(AUTH_KEY, JSON.stringify(session));
      closeDialog(loginModal);
      applyAuth();
      await loadWorks();
      $("#btn-logout").focus();
    } catch (err) {
      session = previous;
      setLoginStatus(err.status === 0 ? err.message : "Não foi possível entrar. Tente novamente.", "error");
    } finally {
      submit.disabled = false;
    }
  });

  $("#btn-logout").addEventListener("click", () => logout());

  session = readSession();
  applyAuth();
  refresh();
  loadWorks();
})();
