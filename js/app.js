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
  let works = [];
  let headSha = null; // latest commit read by an editor; used to show not-yet-deployed photos
  const allWorks = () => works;

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
    let list = [];
    try {
      const file = await gh(`/contents/data/artworks.json?ref=${sha}`);
      list = JSON.parse(decodeB64(file.content));
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    return { sha, treeSha: commit.tree.sha, list: Array.isArray(list) ? list.filter(isValidWork) : [] };
  }

  // Creates a single commit with the updated artworks.json plus added/removed photo files.
  async function commitChange({ mutate, addFiles = [], deletePaths = [], message }) {
    const uploaded = [];
    for (const f of addFiles) {
      const blob = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content: f.base64, encoding: "base64" }) });
      uploaded.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (let attempt = 0; ; attempt++) {
      const remote = await readRemote();
      const next = mutate(remote.list);
      const tree = await gh("/git/trees", {
        method: "POST",
        body: JSON.stringify({
          base_tree: remote.treeSha,
          tree: [
            { path: "data/artworks.json", mode: "100644", type: "blob", content: JSON.stringify(next, null, 2) + "\n" },
            ...uploaded,
            ...deletePaths.map((p) => ({ path: p, mode: "100644", type: "blob", sha: null }))
          ]
        })
      });
      const commit = await gh("/git/commits", {
        method: "POST",
        body: JSON.stringify({ message, tree: tree.sha, parents: [remote.sha] })
      });
      try {
        await gh(`/git/refs/heads/${GH.branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
        return { list: next, sha: commit.sha };
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
      } else {
        const res = await fetch(`data/artworks.json?t=${Date.now()}`, { cache: "no-store" });
        const data = res.ok ? await res.json() : [];
        works = Array.isArray(data) ? data.filter(isValidWork) : [];
      }
    } catch (e) {
      console.warn("Não foi possível carregar as obras.", e);
      if (session && (e.status === 401 || e.status === 403)) return logout("Sua sessão expirou ou o token perdeu acesso. Entre novamente.");
    }
    refresh();
  }

  const state = { filter: "all", onlyAvailable: false, currency: "BRL", list: [], index: 0, imgIndex: 0, room: false };

  const artistOf = (w) => w.artist || G.artist;
  const MAX_PHOTOS = 8;
  // Supports both the legacy single `image` field and the `images` list.
  const photosOf = (w) => (Array.isArray(w.images) ? w.images.filter(Boolean) : w.image ? [w.image] : []);
  const isSafeSrc = (s) => typeof s === "string" && /^(data:image\/|https:\/\/|images\/)/i.test(s) && !s.includes("..");
  // Photos just published are not on GitHub Pages yet; editors load them from the commit instead.
  const srcOf = (p) =>
    session && headSha && p.startsWith("images/")
      ? `https://raw.githubusercontent.com/${GH.owner}/${GH.repo}/${headSha}/${p}`
      : p;
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
    if (!b) return;
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
      <article class="card" tabindex="0" data-index="${i}" aria-label="${esc(w.title)}, ${esc(w.year)}">
        ${cardMedia(w)}
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
    if (e.target.closest(".carousel-btn, .carousel-dot")) return;
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
    state.onlyAvailable = e.target.checked;
    renderGrid();
  });
  $("#currency").addEventListener("change", (e) => {
    state.currency = e.target.value;
    renderGrid();
    if (!$("#viewer").hidden) renderViewer();
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

  $("#btn-remove").addEventListener("click", async () => {
    const w = state.list[state.index];
    if (!isAdmin() || !confirm(`Remover a obra "${w.title}" do site para todos os visitantes?`)) return;
    const btn = $("#btn-remove");
    btn.disabled = true;
    btn.textContent = "Removendo…";
    try {
      const result = await commitChange({
        mutate: (list) => list.filter((x) => x.id !== w.id),
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
  let pendingPhotos = []; // [{ src: dataURL, width, height }]

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

  $("#btn-add").addEventListener("click", () => {
    if (!isAdmin()) return openLogin();
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

  $$("[data-close]", modal).forEach((b) => b.addEventListener("click", () => !form.classList.contains("busy") && closeDialog(modal)));
  modal.addEventListener("click", (e) => e.target === modal && !form.classList.contains("busy") && closeDialog(modal));
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
    if (cover) {
      const ratio = cover.height / cover.width;
      if (f.width.value && !f.height.value) f.height.value = Math.round(f.width.value * ratio);
      else if (f.height.value && !f.width.value) f.width.value = Math.round(f.height.value / ratio);
    }
    updatePreview();
    saveDraft();
  });

  const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const slug = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "obra";

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
      artist: f.artist.value.trim(),
      artistDates: f.artistDates.value.trim(),
      title: f.title.value.trim(),
      year: +f.year.value,
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
      literature: lines(f.literature.value),
      createdAt: new Date().toISOString(),
      ...(files.length ? { images: files.map((x) => x.path) } : { art: { kind: f.kind.value } })
    };

    form.classList.add("busy");
    $$("button, input, select, textarea", form).forEach((el) => (el.dataset.wasDisabled = el.disabled, el.disabled = true));
    setAddStatus(files.length ? `Publicando obra e ${files.length} foto(s)… não feche esta janela.` : "Publicando obra…");
    let savedId = id;
    try {
      const result = await commitChange({
        addFiles: files,
        message: `Adiciona obra ${id} — ${base.title}`,
        mutate: (list) => {
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

  /* ---------- Keyboard ---------- */
  document.addEventListener("keydown", (e) => {
    const loginModal = $("#login-modal");
    if (!loginModal.hidden) {
      if (e.key === "Escape") closeDialog(loginModal);
      else if (e.key === "Tab") trapFocus(e, loginModal);
      return;
    }
    if (!modal.hidden) {
      if (e.key === "Escape") closeDialog(modal);
      else if (e.key === "Tab") trapFocus(e, modal);
      return;
    }
    if (viewer.hidden) return;
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

  // Decorative art, independent from the published artworks list.
  $("#artist-portrait").innerHTML = renderArtwork({ id: "portrait", title: "", width: 130, height: 130, art: { kind: "sphere" } });

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
      if (!modal.hidden) closeDialog(modal);
    }
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
