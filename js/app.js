(function () {
  const G = window.GALLERY;
  const STORAGE_KEY = "lumen.customArtworks.v1";
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- Data ---------- */
  function loadCustom() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(data) ? data.map((w) => ({ ...w, custom: true })) : [];
    } catch {
      return [];
    }
  }
  let custom = loadCustom();
  const allWorks = () => [...window.ARTWORKS, ...custom];

  function saveCustom(next) {
    // Throws QuotaExceededError when browser storage is full (e.g. too many large images).
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.map(({ custom: _, ...w }) => w)));
    custom = next.map((w) => ({ ...w, custom: true }));
  }

  const state = { filter: "all", onlyAvailable: false, currency: "BRL", list: [], index: 0, imgIndex: 0, room: false };

  const artistOf = (w) => w.artist || G.artist;
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
        <div class="card-media"><div class="card-art" style="aspect-ratio:${+w.width}/${+w.height}">${renderArtwork(w)}</div></div>
        <div class="card-caption">
          <p class="artist"><strong>${esc(artistOf(w))}</strong> ${esc(datesOf(w))}</p>
          <p><em>${esc(w.title)}</em>, ${esc(w.year)}</p>
          <p class="muted">${esc(String(w.medium).split(" [")[0])}</p>
          <p class="muted">${esc(cmLine(w))}</p>
          <p class="card-price ${esc(w.status)}"><span class="dot"></span>${esc(price(w))}</p>
          ${w.custom ? `<span class="badge">Adicionada</span>` : ""}
        </div>
      </article>`
      )
      .join("");
    observeCards();
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
    const card = e.target.closest(".card");
    if (card) openViewer(+card.dataset.index);
  });
  $("#obras").addEventListener("keydown", (e) => {
    const card = e.target.closest(".card");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openViewer(+card.dataset.index);
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

  function openViewer(i) {
    state.index = i;
    state.imgIndex = 0;
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

    const variants = ["main", "detail"];
    $("#viewer-image").innerHTML = `<div class="viewer-art" style="aspect-ratio:${+w.width}/${+w.height}">${renderArtwork(w, variants[state.imgIndex])}</div>`;
    $("#viewer-thumbs").innerHTML = variants
      .map(
        (v, i) => `<button class="thumb ${i === state.imgIndex ? "active" : ""}" data-img="${i}" aria-label="${i ? "Detalhe" : "Vista geral"}">${renderArtwork(w, v)}</button>`
      )
      .join("");

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
    $("#btn-remove").hidden = !(w.custom && isAdmin());

    const section = (title, items) =>
      items && items.length ? `<h3>${title}</h3><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
    $("#viewer-extra").innerHTML = `
      ${w.description ? `<h3>Descrição</h3><p>${esc(w.description)}</p>` : ""}
      ${section("Exposições", w.exhibitions)}
      ${section("Literatura", w.literature)}`;

    // Room view: wall assumed 400 cm wide, artwork hung at eye level.
    $("#room-art").style.width = `${Math.min((w.width / 400) * 100, 90)}%`;
    $("#room-art").style.aspectRatio = `${+w.width}/${+w.height}`;
    $("#room-art").innerHTML = renderArtwork(w);
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
  $("#btn-remove").addEventListener("click", () => {
    const w = state.list[state.index];
    if (!isAdmin() || !w.custom || !confirm(`Remover a obra "${w.title}"? Esta ação não pode ser desfeita.`)) return;
    saveCustom(custom.filter((c) => c.id !== w.id));
    refresh();
    if (!state.list.length) return closeDialog(viewer);
    state.index = Math.min(state.index, state.list.length - 1);
    renderViewer();
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
  let pendingImage = null;

  function resizeImage(file, max = 1600) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Arquivo de imagem inválido."));
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
      image: pendingImage && pendingImage.src,
      art: { kind: f.kind.value }
    };
  }
  function updatePreview() {
    const w = previewWork();
    $("#add-preview").style.aspectRatio = `${w.width}/${w.height}`;
    $("#add-preview").innerHTML = renderArtwork(w);
  }

  function nextId() {
    const nums = allWorks().map((w) => parseInt(String(w.id).replace(/\D/g, ""), 10)).filter((n) => !isNaN(n));
    return `OBR-${String(Math.max(0, ...nums) + 1).padStart(4, "0")}`;
  }

  $("#btn-add").addEventListener("click", () => {
    if (!isAdmin()) return openLogin();
    form.reset();
    pendingImage = null;
    addStatus.textContent = "";
    addStatus.className = "form-status";
    form.elements.artist.value = G.artist;
    form.elements.artistDates.value = G.artistDates;
    form.elements.year.value = new Date().getFullYear();
    openDialog(modal);
    updatePreview();
    form.elements.title.focus();
  });

  $$("[data-close]", modal).forEach((b) => b.addEventListener("click", () => closeDialog(modal)));
  modal.addEventListener("click", (e) => e.target === modal && closeDialog(modal));
  ["width", "height", "kind"].forEach((n) => form.elements[n].addEventListener("input", updatePreview));

  form.elements.image.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    pendingImage = null;
    if (file) {
      try {
        pendingImage = await resizeImage(file);
        // Suggest proportional dimensions when only one side was filled in.
        const f = form.elements, ratio = pendingImage.height / pendingImage.width;
        if (f.width.value && !f.height.value) f.height.value = Math.round(f.width.value * ratio);
        else if (f.height.value && !f.width.value) f.width.value = Math.round(f.height.value / ratio);
      } catch (err) {
        addStatus.textContent = err.message;
        addStatus.className = "form-status error";
        e.target.value = "";
      }
    }
    updatePreview();
  });

  const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!isAdmin()) return closeDialog(modal);
    const f = form.elements;
    $$(".invalid", form).forEach((el) => el.classList.remove("invalid"));
    if (!form.checkValidity()) {
      const bad = $$(":invalid", form).filter((el) => el.name);
      bad.forEach((el) => el.classList.add("invalid"));
      addStatus.textContent = "Preencha os campos obrigatórios (*) corretamente.";
      addStatus.className = "form-status error";
      bad[0] && bad[0].focus();
      return;
    }
    const id = f.id.value.trim() || nextId();
    if (allWorks().some((w) => String(w.id).toLowerCase() === id.toLowerCase())) {
      f.id.classList.add("invalid");
      addStatus.textContent = `Já existe uma obra com o código "${id}".`;
      addStatus.className = "form-status error";
      f.id.focus();
      return;
    }

    const work = {
      id,
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
      depth: +f.depth.value || undefined,
      priceBRL: +f.priceBRL.value,
      status: f.status.value,
      description: f.description.value.trim(),
      exhibitions: lines(f.exhibitions.value),
      literature: lines(f.literature.value),
      createdAt: new Date().toISOString(),
      ...(pendingImage ? { image: pendingImage.src } : { art: { kind: f.kind.value } })
    };

    try {
      saveCustom([...custom, work]);
    } catch {
      addStatus.textContent = "Não há espaço suficiente no navegador. Use uma imagem menor ou remova obras adicionadas.";
      addStatus.className = "form-status error";
      return;
    }
    closeDialog(modal);
    state.filter = "all";
    refresh();
    const card = $(`.card[data-index="${state.list.findIndex((w) => w.id === id)}"]`);
    card && card.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  /* ---------- Export / import ---------- */
  $("#btn-export").addEventListener("click", () => {
    if (!isAdmin()) return;
    const blob = new Blob([JSON.stringify(custom.map(({ custom: _, ...w }) => w), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `obras-adicionadas-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const isValidWork = (w) =>
    w && typeof w === "object" && w.id && w.title && w.type && w.medium && +w.width > 0 && +w.height > 0 &&
    ["available", "reserved", "sold"].includes(w.status) &&
    (w.image == null || (typeof w.image === "string" && /^(data:image\/|https?:\/\/)/i.test(w.image)));

  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !isAdmin()) return;
    try {
      const data = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
      if (!Array.isArray(data)) throw new Error();
      const existing = new Set(allWorks().map((w) => String(w.id).toLowerCase()));
      const valid = data.filter(isValidWork);
      const added = valid.filter((w) => !existing.has(String(w.id).toLowerCase()));
      saveCustom([...custom, ...added]);
      refresh();
      alert(`${added.length} obra(s) importada(s).` + (data.length - added.length ? ` ${data.length - added.length} ignorada(s) (inválidas ou código duplicado).` : ""));
    } catch {
      alert("Arquivo inválido ou sem espaço no navegador para importar.");
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
  // Client-side only: hides/blocks management tools on a static site; not server-grade security.
  const AUTH_KEY = "lumen.auth.v1";
  const ADMIN = G.admin;
  let session = null;

  function isAdmin() {
    return !!session && session.user === ADMIN.user && session.hash === ADMIN.passwordHash;
  }

  async function sha256(text) {
    if (!(window.crypto && crypto.subtle)) throw new Error("Este navegador não permite login neste endereço (use HTTPS).");
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function readSession() {
    for (const store of [sessionStorage, localStorage]) {
      try {
        const s = JSON.parse(store.getItem(AUTH_KEY) || "null");
        if (s && s.user === ADMIN.user && s.hash === ADMIN.passwordHash) return s;
        store.removeItem(AUTH_KEY);
      } catch {}
    }
    return null;
  }

  function applyAuth() {
    const admin = isAdmin();
    document.body.classList.toggle("is-admin", admin);
    $("#btn-login").hidden = admin;
    $("#user-box").hidden = !admin;
    $("#user-name").textContent = admin ? session.user : "";
    $("#manage").hidden = !admin;
    if (!admin && !modal.hidden) closeDialog(modal);
    if (!viewer.hidden) renderViewer();
  }

  const loginModal = $("#login-modal");
  const loginForm = $("#login-form");
  const loginStatus = $("#login-status");

  function openLogin() {
    loginForm.reset();
    loginStatus.textContent = "";
    loginStatus.className = "form-status";
    openDialog(loginModal);
    loginForm.elements.user.focus();
  }

  $("#btn-login").addEventListener("click", openLogin);
  $$("[data-close]", loginModal).forEach((b) => b.addEventListener("click", () => closeDialog(loginModal)));
  loginModal.addEventListener("click", (e) => e.target === loginModal && closeDialog(loginModal));

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = loginForm.elements;
    const submit = $("button[type=submit]", loginForm);
    if (!f.user.value.trim() || !f.password.value) {
      loginStatus.textContent = "Informe usuário e senha.";
      loginStatus.className = "form-status error";
      return;
    }
    submit.disabled = true;
    try {
      const hash = await sha256(`${ADMIN.salt}:${f.password.value}`);
      if (f.user.value.trim() !== ADMIN.user || hash !== ADMIN.passwordHash) {
        loginStatus.textContent = "Usuário ou senha inválidos.";
        loginStatus.className = "form-status error";
        f.password.value = "";
        f.password.focus();
        await new Promise((r) => setTimeout(r, 1200));
        return;
      }
      session = { user: ADMIN.user, hash };
      (f.remember.checked ? localStorage : sessionStorage).setItem(AUTH_KEY, JSON.stringify(session));
      closeDialog(loginModal);
      applyAuth();
      $("#btn-logout").focus();
    } catch (err) {
      loginStatus.textContent = err.message;
      loginStatus.className = "form-status error";
    } finally {
      submit.disabled = false;
    }
  });

  $("#btn-logout").addEventListener("click", () => {
    session = null;
    sessionStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_KEY);
    applyAuth();
    $("#btn-login").focus();
  });

  session = readSession();
  applyAuth();
  refresh();
})();
