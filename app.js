/* GlaMaterials — накладає водяний знак GlamEng на PDF/фото.
   Все виконується локально в браузері: файли не завантажуються нікуди. */

(function () {
  "use strict";

  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  const { PDFDocument } = PDFLib;

  // Two templates share the pipeline: a portrait A4 "document" (contain-fit, padded,
  // watermark drawn at adjustable opacity) and a landscape "frame" for screenshots
  // (cover-fit into a fixed window, cropping overflow, frame drawn at full opacity).
  const TEMPLATES = {
    document: {
      canvasW: 1654, canvasH: 2339, // A4 at 200dpi — good text legibility, sane file size.
      pdfPtW: 595.28, pdfPtH: 841.89,
      fit: "contain",
      overlayOpacity: true,
    },
    frame: {
      canvasW: 2000, canvasH: 1414, // matches the frame artwork's native resolution.
      pdfPtW: 841.89, pdfPtH: 595.28,
      fit: "cover",
      overlayOpacity: false,
      window: { x: 294, y: 224, w: 1403, h: 964 },
    },
  };
  let activeTemplate = "document";
  function tpl() { return TEMPLATES[activeTemplate]; }

  const MAX_JOBS = 40;
  const JPEG_QUALITY = 0.92;
  const DEFAULT_OPACITY = 35;
  const MAX_HISTORY = 40;
  const MAX_HISTORY_ITEM_BYTES = 30 * 1024 * 1024;
  const OPACITY_STORAGE_KEY = "glamaterials_opacity";

  const els = {
    dropzone: document.getElementById("dropzone"),
    dropzoneTitle: document.getElementById("dropzone-title"),
    fileInput: document.getElementById("file-input"),
    jobList: document.getElementById("job-list"),
    settingsBlock: document.getElementById("settings-block"),
    templateToggle: document.getElementById("template-toggle"),
    dropzoneSub: document.getElementById("dropzone-sub"),
    mergeRow: document.getElementById("merge-row"),
    mergeToggle: document.getElementById("merge-toggle"),
    formatToggle: document.getElementById("format-toggle"),
    previewCanvas: document.getElementById("preview-canvas"),
    editorOverlay: document.getElementById("editor-overlay"),
    toolRow: document.getElementById("tool-row"),
    editorHint: document.getElementById("editor-hint"),
    inspector: document.getElementById("inspector"),
    inspectorTitle: document.getElementById("inspector-title"),
    insText: document.getElementById("ins-text"),
    insFont: document.getElementById("ins-font"),
    insSize: document.getElementById("ins-size"),
    insSizeVal: document.getElementById("ins-size-val"),
    insAlign: document.getElementById("ins-align"),
    insColor: document.getElementById("ins-color"),
    insFill: document.getElementById("ins-fill"),
    insBg: document.getElementById("ins-bg"),
    insStroke: document.getElementById("ins-stroke"),
    insStrokeW: document.getElementById("ins-stroke-w"),
    insStrokeWVal: document.getElementById("ins-stroke-w-val"),
    insRadius: document.getElementById("ins-radius"),
    insRadiusVal: document.getElementById("ins-radius-val"),
    insRot: document.getElementById("ins-rot"),
    insRotVal: document.getElementById("ins-rot-val"),
    insOpacity: document.getElementById("ins-opacity"),
    insOpacityVal: document.getElementById("ins-opacity-val"),
    insSwatches: document.getElementById("ins-swatches"),
    previewPrev: document.getElementById("preview-prev"),
    previewNext: document.getElementById("preview-next"),
    pageCountBadge: document.getElementById("page-count-badge"),
    opacityBlock: document.getElementById("opacity-block"),
    opacitySlider: document.getElementById("opacity-slider"),
    opacityValue: document.getElementById("opacity-value"),
    exportBtn: document.getElementById("export-btn"),
    exportBtnLabel: document.getElementById("export-btn-label"),
    exportSpinner: document.getElementById("export-spinner"),
    exportProgressTrack: document.getElementById("export-progress-track"),
    exportProgressFill: document.getElementById("export-progress-fill"),
    clearBtn: document.getElementById("clear-btn"),
    historyBtn: document.getElementById("history-btn"),
    closeHistoryBtn: document.getElementById("close-history"),
    panelHistory: document.getElementById("panel-history"),
    historyList: document.getElementById("history-list"),
    historyEmpty: document.getElementById("history-empty"),
    toast: document.getElementById("toast"),
  };

  let watermarkImg = null;
  let frameImg = null;
  function overlayImg() { return activeTemplate === "frame" ? frameImg : watermarkImg; }

  let jobs = [];
  let jobIdCounter = 0;
  const pendingQueue = [];
  let isProcessingQueue = false;
  let mergeMode = "merge"; // 'merge' | 'separate'
  let outputFormat = "pdf"; // 'pdf' | 'photos'
  let isExporting = false;
  let previewRAF = null;
  let previewIndex = 0;
  let toastTimer = null;

  const previewWorkCanvas = document.createElement("canvas");
  const exportWorkCanvas = document.createElement("canvas");
  let previewBase = { blob: null, opacity: null, w: 0, h: 0 };

  // ---------- helpers ----------

  const scriptCache = {};
  function loadScriptOnce(src) {
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("script-load-failed:" + src));
      document.head.appendChild(s);
    });
    return scriptCache[src];
  }

  async function getJSZip() {
    if (!window.JSZip) await loadScriptOnce("vendor/jszip.min.js");
    return new window.JSZip();
  }

  function isPdf(file) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  }
  function isHeic(file) {
    return /\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]/i.test(file.type || "");
  }
  function isSupportedImage(file) {
    return isHeic(file) || /^image\/(jpeg|png|webp)$/.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
  }
  function sanitizeName(name) {
    return name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_").trim() || "файл";
  }

  function showToast(message, kind, duration) {
    const el = els.toast;
    el.textContent = message;
    el.className = "toast" + (kind === "success" ? " toast-success" : kind === "error" ? " toast-error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), duration || 2800);
  }

  const CONFETTI_COLORS = ["#E8849A", "#F2A0B8", "#9D2F7F", "#3D1F2D", "#F5B8C8"];
  function celebrate(originEl) {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = originEl.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    for (let i = 0; i < 22; i++) {
      const el = document.createElement("span");
      el.className = "confetti-bit";
      const angle = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 90;
      el.style.left = originX + "px";
      el.style.top = originY + "px";
      el.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      el.style.setProperty("--dx", Math.cos(angle) * dist + "px");
      el.style.setProperty("--dy", Math.sin(angle) * dist - 40 + "px");
      el.style.setProperty("--rot", (Math.random() * 360 - 180) + "deg");
      document.body.appendChild(el);
      el.addEventListener("animationend", () => el.remove());
    }
  }

  function triggerDownloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  // A real touchscreen (phone/tablet) — not just "Safari" — since iPad can report
  // a desktop-style UA/platform but still has a touchscreen and the same broken
  // <a download> behavior as iPhone. A trackpad/mouse-only Mac/PC reports 0 here.
  function isTouchDevice() {
    return navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  }

  // On iOS/iPadOS Safari, <a download> on a blob: URL usually just opens the file
  // in a new tab instead of saving it — the Web Share sheet ("Save to Files") is
  // the only reliable "download" affordance there. Desktop browsers download a
  // blob: URL just fine, and desktop Safari/Chrome also implement Web Share, so
  // without this check desktop users would get the OS share sheet instead of a
  // plain download — only take the share path on touch devices.
  async function deliverBlob(blob, filename, mimeType) {
    if (isTouchDevice() && navigator.canShare && typeof navigator.share === "function") {
      try {
        const file = new File([blob], filename, { type: mimeType });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "GlaMaterials" });
          return "shared";
        }
      } catch (err) {
        if (err && err.name === "AbortError") return "cancelled";
        // any other share failure: fall through to a normal download
      }
    }
    triggerDownloadBlob(blob, filename);
    return "downloaded";
  }

  function describeError(err) {
    const msg = (err && err.message) || "";
    if (/password/i.test(msg)) return "PDF захищений паролем — зніми захист і спробуй ще раз.";
    if (/script-load-failed/i.test(msg)) return "Не вдалося завантажити потрібний модуль. Перевір з'єднання.";
    return "Не вдалося обробити файл. Можливо, він пошкоджений.";
  }

  // ---------- overlay images + base canvas rendering ----------

  function loadImageFromDataUri(dataUri) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("overlay-load-failed"));
      img.src = dataUri;
    });
  }

  function makeBaseCanvas() {
    const t = tpl();
    const canvas = document.createElement("canvas");
    canvas.width = t.canvasW;
    canvas.height = t.canvasH;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, t.canvasW, t.canvasH);
    return { canvas, ctx };
  }

  // 'contain' pads the whole canvas (document template, no cropping).
  // 'cover' fills the template's photo window and crops any overflow (frame template).
  function placePhoto(ctx, drawable, srcW, srcH) {
    const t = tpl();
    if (t.fit === "cover") {
      const rect = t.window;
      const scale = Math.max(rect.w / srcW, rect.h / srcH);
      const w = srcW * scale;
      const h = srcH * scale;
      const dx = rect.x + (rect.w - w) / 2;
      const dy = rect.y + (rect.h - h) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      ctx.drawImage(drawable, dx, dy, w, h);
      ctx.restore();
    } else {
      const scale = Math.min(t.canvasW / srcW, t.canvasH / srcH);
      const w = Math.round(srcW * scale);
      const h = Math.round(srcH * scale);
      const dx = Math.round((t.canvasW - w) / 2);
      const dy = Math.round((t.canvasH - h) / 2);
      ctx.drawImage(drawable, dx, dy, w, h);
    }
  }

  // Render source pages/photos at roughly their final on-canvas resolution instead
  // of always rendering full-canvas-sized, so a cover-fit crop into a smaller window
  // doesn't waste time rasterizing pixels that get cropped away.
  function renderScaleFor(srcW, srcH) {
    const t = tpl();
    if (t.fit === "cover") {
      return Math.max(t.window.w / srcW, t.window.h / srcH);
    }
    return Math.min(t.canvasW / srcW, t.canvasH / srcH);
  }

  function canvasToJpegBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  }

  async function renderPdfFile(file, onProgress) {
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const scale = renderScaleFor(viewport.width, viewport.height);
      const renderViewport = page.getViewport({ scale });
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = Math.round(renderViewport.width);
      pageCanvas.height = Math.round(renderViewport.height);
      const pageCtx = pageCanvas.getContext("2d");
      await page.render({ canvasContext: pageCtx, viewport: renderViewport }).promise;

      const { canvas, ctx } = makeBaseCanvas();
      placePhoto(ctx, pageCanvas, pageCanvas.width, pageCanvas.height);
      pages.push(await canvasToJpegBlob(canvas));
      onProgress && onProgress(pages.length, doc.numPages);
    }
    return pages;
  }

  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image-load-failed")); };
      img.src = url;
    });
  }

  async function renderImageFile(file) {
    let sourceBlob = file;
    if (isHeic(file)) {
      await loadScriptOnce("vendor/heic2any.min.js");
      const result = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
      sourceBlob = Array.isArray(result) ? result[0] : result;
    }
    const img = await loadImageFromBlob(sourceBlob);
    const { canvas, ctx } = makeBaseCanvas();
    placePhoto(ctx, img, img.naturalWidth, img.naturalHeight);
    return [await canvasToJpegBlob(canvas)];
  }

  async function makeThumbDataUrl(blob, maxDim) {
    const dim = maxDim || 120;
    const bitmap = await createImageBitmap(blob);
    const scale = dim / Math.max(bitmap.width, bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return c.toDataURL("image/jpeg", 0.65);
  }

  // ---------- job queue ----------

  function enqueueJob(job) {
    pendingQueue.push(job.id);
    if (!isProcessingQueue) processQueueWorker();
  }

  async function processQueueWorker() {
    isProcessingQueue = true;
    while (pendingQueue.length) {
      const id = pendingQueue.shift();
      const job = jobs.find((j) => j.id === id);
      if (!job) continue;
      job.status = "processing";
      renderJobList();
      try {
        const pages = isPdf(job.file)
          ? await renderPdfFile(job.file, (done, total) => {
              job.progressLabel = done + "/" + total + " стор.";
              renderJobList();
            })
          : await renderImageFile(job.file);
        if (!jobs.includes(job)) continue;
        if (!pages.length) throw new Error("no-pages");
        job.pages = pages;
        job.thumbUrl = await makeThumbDataUrl(pages[0]);
        job.status = "done";
      } catch (err) {
        console.error(err);
        if (jobs.includes(job)) {
          job.status = "error";
          job.errorMsg = describeError(err);
          showToast(`Не вдалося обробити «${job.name}»`, "error");
        }
      }
      renderJobList();
      updateSettingsVisibility();
      updatePreview();
    }
    isProcessingQueue = false;
  }

  function addFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;

    const rejected = [];
    const accepted = [];
    for (const f of files) {
      if (isPdf(f) || isSupportedImage(f)) accepted.push(f);
      else rejected.push(f.name);
    }
    if (rejected.length) {
      showToast("Не підтримується: " + rejected.join(", "), "error", 3600);
    }
    if (jobs.length + accepted.length > MAX_JOBS) {
      showToast(`Максимум ${MAX_JOBS} файлів за раз`, "error");
      accepted.length = Math.max(0, MAX_JOBS - jobs.length);
    }
    for (const f of accepted) {
      const job = {
        id: ++jobIdCounter,
        file: f,
        name: f.name,
        baseName: sanitizeName(f.name),
        status: "queued",
        pages: [],
        thumbUrl: null,
        progressLabel: "",
        errorMsg: "",
      };
      jobs.push(job);
      enqueueJob(job);
    }
    renderJobList();
    updateDropzoneMode();
    updateSettingsVisibility();
  }

  function removeJob(id) {
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return;
    jobs.splice(idx, 1);
    const qIdx = pendingQueue.indexOf(id);
    if (qIdx !== -1) pendingQueue.splice(qIdx, 1);
    dropAnnotationsForJob(id);
    selectedId = null;
    renderJobList();
    updateDropzoneMode();
    updateSettingsVisibility();
    updatePreview();
    renderInspector();
  }

  function resetQueue() {
    jobs = [];
    pendingQueue.length = 0;
    previewIndex = 0;
    annotations.clear();
    selectedId = null;
    renderJobList();
    updateDropzoneMode();
    updateSettingsVisibility();
    updatePreview();
    renderInspector();
  }

  function requeueJobsForTemplateChange() {
    previewIndex = 0;
    pendingQueue.length = 0;
    for (const job of jobs) {
      job.status = "queued";
      job.pages = [];
      job.thumbUrl = null;
      job.progressLabel = "";
      job.errorMsg = "";
    }
    renderJobList();
    updateDropzoneMode();
    updateSettingsVisibility();
    updatePreview();
    jobs.forEach((job) => enqueueJob(job));
  }

  // ---------- rendering UI ----------

  function updateDropzoneMode() {
    const has = jobs.length > 0;
    els.dropzone.classList.toggle("compact", has);
    els.dropzoneTitle.textContent = has ? "Додати ще файл" : "Перетягни файли сюди або натисни, щоб обрати";
  }

  function jobStatusMeta(job) {
    if (job.status === "queued") return "У черзі…";
    if (job.status === "processing") return job.progressLabel || "Обробка…";
    if (job.status === "error") return job.errorMsg || "Помилка";
    const n = job.pages.length;
    return n + (n === 1 ? " сторінка" : " стор.");
  }

  function renderJobList() {
    els.jobList.innerHTML = "";
    for (const job of jobs) {
      const li = document.createElement("li");
      li.className = "job-card";

      const thumb = document.createElement("div");
      thumb.className = "job-thumb";
      if (job.status === "done" && job.thumbUrl) {
        const img = document.createElement("img");
        img.src = job.thumbUrl;
        thumb.appendChild(img);
      } else if (job.status === "error") {
        thumb.innerHTML = '<span class="job-error-icon">!</span>';
      } else {
        thumb.innerHTML = '<span class="mini-spinner"></span>';
      }

      const info = document.createElement("div");
      info.className = "job-info";
      const nameEl = document.createElement("input");
      nameEl.className = "job-name";
      nameEl.type = "text";
      nameEl.spellcheck = false;
      nameEl.value = job.baseName;
      nameEl.title = "Натисни, щоб перейменувати файл результату";
      nameEl.addEventListener("change", () => {
        const clean = sanitizeName(nameEl.value);
        job.baseName = clean;
        nameEl.value = clean;
      });
      nameEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") nameEl.blur();
      });
      nameEl.addEventListener("click", (e) => e.stopPropagation());
      const metaEl = document.createElement("span");
      metaEl.className = "job-meta" + (job.status === "error" ? " error" : "");
      metaEl.textContent = jobStatusMeta(job);
      info.appendChild(nameEl);
      info.appendChild(metaEl);

      const removeBtn = document.createElement("button");
      removeBtn.className = "job-remove";
      removeBtn.type = "button";
      removeBtn.setAttribute("aria-label", "Прибрати файл");
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => removeJob(job.id));

      li.appendChild(thumb);
      li.appendChild(info);
      li.appendChild(removeBtn);
      els.jobList.appendChild(li);
    }
    updateExportButtonLabel();
  }

  function readyJobs() {
    return jobs.filter((j) => j.status === "done");
  }
  function totalPagesOf(list) {
    return list.reduce((s, j) => s + j.pages.length, 0);
  }

  function updateSettingsVisibility() {
    const has = jobs.length > 0;
    els.settingsBlock.classList.toggle("hidden", !has);
    els.mergeRow.classList.toggle("hidden", jobs.length <= 1 || outputFormat === "photos");
    els.opacityBlock.classList.toggle("hidden", !tpl().overlayOpacity);
    const ready = readyJobs();
    els.exportBtn.disabled = isExporting || ready.length === 0;
    updateExportButtonLabel();
  }

  function updateDropzoneHint() {
    els.dropzoneSub.textContent = activeTemplate === "frame"
      ? "JPG, PNG, WEBP, HEIC · можна додавати по одному · фото автоматично обрізається під рамку"
      : "PDF, JPG, PNG, WEBP, HEIC · можна додавати файли по одному · результат завжди рівний, під формат A4";
  }

  function updateExportButtonLabel() {
    if (isExporting) return;
    const ready = readyJobs();
    const pages = totalPagesOf(ready);
    let label;
    if (outputFormat === "photos") {
      label = pages ? `Зберегти ${pages} фото` : "Зберегти фото";
    } else if (mergeMode === "separate" && ready.length > 1) {
      label = `Завантажити ZIP · ${ready.length} PDF`;
    } else {
      label = "Завантажити PDF";
    }
    els.exportBtnLabel.textContent = label;
  }

  function currentOpacityFraction() {
    return Number(els.opacitySlider.value) / 100;
  }

  // Flat list of every rendered page across ready jobs, in queue order — lets the
  // preview flip through the whole batch instead of only ever showing page 1.
  function pageKeyOf(jobId, pageIndex) { return jobId + ":" + pageIndex; }

  function refsOfJob(job) {
    return job.pages.map((blob, i) => ({ blob, key: pageKeyOf(job.id, i) }));
  }

  function allReadyPageRefs() {
    const refs = [];
    for (const job of readyJobs()) refs.push(...refsOfJob(job));
    return refs;
  }

  function clampPreviewIndex() {
    const total = allReadyPageRefs().length;
    if (total === 0) { previewIndex = 0; return; }
    previewIndex = Math.min(Math.max(previewIndex, 0), total - 1);
  }

  function shiftPreview(delta) {
    const total = allReadyPageRefs().length;
    if (total <= 1) return;
    previewIndex = (previewIndex + delta + total) % total;
    selectedId = null; // selection is per page
    armTool(null);
    updatePreview();
    renderInspector();
  }

  function updatePreview() {
    const refs = allReadyPageRefs();
    if (!refs.length) {
      const ctx = els.previewCanvas.getContext("2d");
      ctx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
      syncOverlaySize();
      els.editorOverlay.getContext("2d").clearRect(0, 0, els.editorOverlay.width, els.editorOverlay.height);
      els.pageCountBadge.textContent = "";
      els.previewPrev.classList.add("hidden");
      els.previewNext.classList.add("hidden");
      return;
    }
    clampPreviewIndex();
    const total = refs.length;
    els.pageCountBadge.textContent = total > 1 ? `${previewIndex + 1}/${total}` : `${total} стор.`;
    els.previewPrev.classList.toggle("hidden", total <= 1);
    els.previewNext.classList.toggle("hidden", total <= 1);

    if (previewRAF) cancelAnimationFrame(previewRAF);
    previewRAF = requestAnimationFrame(async () => {
      const t = tpl();
      const ref = refs[previewIndex];
      const op = t.overlayOpacity ? currentOpacityFraction() : 1;

      // The page+watermark composite is cached (keyed on the blob itself, so a
      // re-rendered page invalidates it automatically). Dragging an annotation
      // then only costs a blit + a redraw of the annotation layer, not a decode.
      const stale = previewBase.blob !== ref.blob || previewBase.opacity !== op
        || previewBase.w !== t.canvasW || previewBase.h !== t.canvasH;
      if (stale) {
        const bitmap = await createImageBitmap(ref.blob);
        previewWorkCanvas.width = t.canvasW;
        previewWorkCanvas.height = t.canvasH;
        const bctx = previewWorkCanvas.getContext("2d");
        bctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        bctx.globalAlpha = op;
        bctx.drawImage(overlayImg(), 0, 0, t.canvasW, t.canvasH);
        bctx.globalAlpha = 1;
        previewBase = { blob: ref.blob, opacity: op, w: t.canvasW, h: t.canvasH };
      }

      els.previewCanvas.width = t.canvasW;
      els.previewCanvas.height = t.canvasH;
      const ctx = els.previewCanvas.getContext("2d");
      ctx.drawImage(previewWorkCanvas, 0, 0);
      drawAnnotations(ctx, annsFor(ref.key));
      syncOverlaySize();
      drawOverlay();
    });
  }

  // ---------- on-page editor: text + shapes ----------
  // Annotations are stored per page in canvas coordinates (the same space the export
  // canvas uses), so what you see in the preview is exactly what lands in the file.

  const FONTS = [
    { label: "Inter — фірмовий", css: "'Inter', -apple-system, sans-serif" },
    { label: "Cormorant — фірмовий", css: "'Cormorant Garamond', Georgia, serif" },
    { label: "Georgia", css: "Georgia, serif" },
    { label: "Times New Roman", css: "'Times New Roman', Times, serif" },
    { label: "Arial", css: "Arial, Helvetica, sans-serif" },
    { label: "Verdana", css: "Verdana, Geneva, sans-serif" },
    { label: "Trebuchet MS", css: "'Trebuchet MS', Tahoma, sans-serif" },
    { label: "Courier New", css: "'Courier New', Courier, monospace" },
    { label: "Impact", css: "Impact, 'Arial Black', sans-serif" },
    { label: "Comic Sans MS", css: "'Comic Sans MS', 'Comic Sans', cursive" },
  ];

  const SWATCHES = ["#3D1F2D", "#E8849A", "#9D2F7F", "#B04060", "#FFFFFF",
                    "#000000", "#2E7D32", "#1565C0", "#F9A825", "#D32F2F"];

  const TYPE_LABEL = { text: "Текст", rect: "Прямокутник", ellipse: "Овал", line: "Лінія", arrow: "Стрілка" };
  const LINE_H = 1.25;
  const MIN_SIZE = 14;

  const annotations = new Map(); // pageKey -> annotation[]
  const measureCtx = document.createElement("canvas").getContext("2d");
  let annIdCounter = 0;
  let selectedId = null;
  let armedTool = null;
  let drag = null;

  function annsFor(key) {
    if (!key) return [];
    if (!annotations.has(key)) annotations.set(key, []);
    return annotations.get(key);
  }
  function currentRef() {
    const refs = allReadyPageRefs();
    if (!refs.length) return null;
    clampPreviewIndex();
    return refs[previewIndex] || null;
  }
  function currentKey() {
    const ref = currentRef();
    return ref ? ref.key : null;
  }
  function currentAnns() { return annsFor(currentKey()); }
  function selectedAnn() { return currentAnns().find((a) => a.id === selectedId) || null; }
  function isLine(a) { return a.type === "line" || a.type === "arrow"; }

  // ----- drawing -----

  function fontStringOf(a) {
    return (a.italic ? "italic " : "") + (a.bold ? "700 " : "400 ") + a.size + "px " + a.font;
  }

  function wrapLines(ctx, a) {
    ctx.font = fontStringOf(a);
    const out = [];
    for (const para of String(a.text == null ? "" : a.text).split("\n")) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(""); continue; }
      let line = words[0];
      for (let i = 1; i < words.length; i++) {
        const test = line + " " + words[i];
        if (ctx.measureText(test).width <= a.w) line = test;
        else { out.push(line); line = words[i]; }
      }
      out.push(line);
    }
    return out.length ? out : [""];
  }

  // Text height is derived from wrapping, so the selection box always hugs the text.
  function syncTextHeight(a) {
    if (a.type !== "text") return;
    a.h = wrapLines(measureCtx, a).length * a.size * LINE_H;
  }

  function pathRoundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(Math.abs(w), Math.abs(h)) / 2));
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rr); return; }
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr); ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr); ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function drawTextAnn(ctx, a) {
    const lines = wrapLines(ctx, a);
    const lh = a.size * LINE_H;
    ctx.font = fontStringOf(a);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = a.align || "left";

    if (a.bg) {
      const pad = a.size * 0.24;
      ctx.fillStyle = a.bg;
      ctx.fillRect(a.x - pad, a.y - pad, a.w + pad * 2, a.h + pad * 2);
    }

    const anchorX = a.align === "center" ? a.x + a.w / 2 : a.align === "right" ? a.x + a.w : a.x;
    lines.forEach((line, i) => {
      const baseY = a.y + i * lh + a.size;
      if (a.stroke && a.strokeW > 0) {
        ctx.lineJoin = "round";
        ctx.lineWidth = a.strokeW;
        ctx.strokeStyle = a.stroke;
        ctx.strokeText(line, anchorX, baseY);
      }
      ctx.fillStyle = a.color;
      ctx.fillText(line, anchorX, baseY);
      if (a.underline && line) {
        const uw = ctx.measureText(line).width;
        const ux = a.align === "center" ? anchorX - uw / 2 : a.align === "right" ? anchorX - uw : anchorX;
        ctx.fillRect(ux, baseY + a.size * 0.14, uw, Math.max(1, a.size * 0.06));
      }
    });
  }

  function drawLineAnn(ctx, a) {
    const w = Math.max(1, a.strokeW);
    ctx.lineCap = "round";
    ctx.lineWidth = w;
    ctx.strokeStyle = a.stroke || "#000000";
    if (a.dashed) ctx.setLineDash([w * 2.6, w * 2.2]);
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
    const head = a.type === "arrow" ? Math.max(w * 3.4, 18) : 0;
    // Stop the shaft short of the tip so the arrowhead reads as a solid point.
    const ex = head ? a.x2 - Math.cos(ang) * head * 0.6 : a.x2;
    const ey = head ? a.y2 - Math.sin(ang) * head * 0.6 : a.y2;
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    if (head) {
      ctx.fillStyle = a.stroke || "#000000";
      ctx.beginPath();
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(a.x2 - Math.cos(ang - 0.42) * head, a.y2 - Math.sin(ang - 0.42) * head);
      ctx.lineTo(a.x2 - Math.cos(ang + 0.42) * head, a.y2 - Math.sin(ang + 0.42) * head);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawAnnotations(ctx, list) {
    for (const a of list) {
      ctx.save();
      ctx.globalAlpha = a.opacity == null ? 1 : a.opacity;
      if (isLine(a)) {
        drawLineAnn(ctx, a);
      } else {
        if (a.type === "text") syncTextHeight(a);
        const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
        if (a.rot) { ctx.translate(cx, cy); ctx.rotate(a.rot); ctx.translate(-cx, -cy); }
        if (a.type === "text") {
          drawTextAnn(ctx, a);
        } else {
          if (a.type === "rect") pathRoundRect(ctx, a.x, a.y, a.w, a.h, a.radius || 0);
          else { ctx.beginPath(); ctx.ellipse(cx, cy, Math.abs(a.w) / 2, Math.abs(a.h) / 2, 0, 0, Math.PI * 2); }
          if (a.fill) { ctx.fillStyle = a.fill; ctx.fill(); }
          if (a.stroke && a.strokeW > 0) { ctx.lineWidth = a.strokeW; ctx.strokeStyle = a.stroke; ctx.stroke(); }
        }
      }
      ctx.restore();
    }
  }

  // ----- geometry helpers -----

  function rotatePoint(cx, cy, px, py, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const dx = px - cx, dy = py - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  }
  function toLocal(a, px, py) {
    if (!a.rot) return { x: px, y: py };
    return rotatePoint(a.x + a.w / 2, a.y + a.h / 2, px, py, -a.rot);
  }
  function toWorld(a, px, py) {
    if (!a.rot) return { x: px, y: py };
    return rotatePoint(a.x + a.w / 2, a.y + a.h / 2, px, py, a.rot);
  }
  function corners(a) {
    return [
      { id: "nw", x: a.x, y: a.y },
      { id: "ne", x: a.x + a.w, y: a.y },
      { id: "se", x: a.x + a.w, y: a.y + a.h },
      { id: "sw", x: a.x, y: a.y + a.h },
    ];
  }
  function dist(p, q) { return Math.hypot(p.x - q.x, p.y - q.y); }
  function distToSeg(p, a) {
    const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
    const len2 = dx * dx + dy * dy;
    if (!len2) return dist(p, { x: a.x1, y: a.y1 });
    let t = ((p.x - a.x1) * dx + (p.y - a.y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return dist(p, { x: a.x1 + t * dx, y: a.y1 + t * dy });
  }

  // ----- selection overlay (never exported) -----

  function syncOverlaySize() {
    const cv = els.editorOverlay;
    if (cv.width !== els.previewCanvas.width || cv.height !== els.previewCanvas.height) {
      cv.width = els.previewCanvas.width;
      cv.height = els.previewCanvas.height;
    }
  }

  // Handles are drawn in canvas pixels, so scale them by how far the canvas is
  // shrunk on screen — otherwise they'd be nearly invisible on a 2000px-wide canvas.
  function overlayScale() {
    const r = els.editorOverlay.getBoundingClientRect();
    return r.width ? els.editorOverlay.width / r.width : 1;
  }

  function drawHandle(ctx, x, y, s) {
    ctx.beginPath();
    ctx.arc(x, y, 6 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  function drawOverlay() {
    const cv = els.editorOverlay;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    const a = selectedAnn();
    if (!a) return;
    const s = overlayScale();
    ctx.save();
    ctx.strokeStyle = "#9D2F7F";
    ctx.fillStyle = "#FFFFFF";
    ctx.lineWidth = 1.8 * s;
    if (isLine(a)) {
      drawHandle(ctx, a.x1, a.y1, s);
      drawHandle(ctx, a.x2, a.y2, s);
    } else {
      const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
      if (a.rot) { ctx.translate(cx, cy); ctx.rotate(a.rot); ctx.translate(-cx, -cy); }
      ctx.setLineDash([6 * s, 5 * s]);
      ctx.strokeRect(a.x, a.y, a.w, a.h);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(cx, a.y);
      ctx.lineTo(cx, a.y - 30 * s);
      ctx.stroke();
      drawHandle(ctx, cx, a.y - 30 * s, s);
      corners(a).forEach((c) => drawHandle(ctx, c.x, c.y, s));
    }
    ctx.restore();
  }

  // ----- hit testing -----

  function hitHandle(a, p) {
    const s = overlayScale();
    const r = 13 * s;
    if (isLine(a)) {
      if (dist(p, { x: a.x1, y: a.y1 }) <= r) return "p1";
      if (dist(p, { x: a.x2, y: a.y2 }) <= r) return "p2";
      return null;
    }
    const cx = a.x + a.w / 2;
    if (dist(p, toWorld(a, cx, a.y - 30 * s)) <= r) return "rot";
    for (const c of corners(a)) {
      if (dist(p, toWorld(a, c.x, c.y)) <= r) return c.id;
    }
    return null;
  }

  function hitAnn(p) {
    const list = currentAnns();
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      if (isLine(a)) {
        if (distToSeg(p, a) <= Math.max(a.strokeW, 12) + 8) return a;
      } else {
        const l = toLocal(a, p.x, p.y);
        if (l.x >= a.x && l.x <= a.x + a.w && l.y >= a.y && l.y <= a.y + a.h) return a;
      }
    }
    return null;
  }

  // ----- creating -----

  function defaultsFor(type) {
    const t = tpl();
    const base = Math.min(t.canvasW, t.canvasH);
    const sw = Math.max(2, Math.round(base * 0.005));
    if (type === "text") {
      return {
        text: "Твій текст", font: FONTS[0].css, size: Math.round(base * 0.05),
        bold: true, italic: false, underline: false, align: "left",
        color: "#3D1F2D", stroke: null, strokeW: 0, bg: null, rot: 0, opacity: 1,
      };
    }
    if (type === "rect" || type === "ellipse") {
      return {
        fill: "#E8849A", stroke: "#3D1F2D", strokeW: sw,
        radius: type === "rect" ? Math.round(base * 0.014) : 0, rot: 0, opacity: 1,
      };
    }
    return { stroke: "#B04060", strokeW: Math.round(sw * 1.7), dashed: false, opacity: 1 };
  }

  function addAnnotation(type, geom) {
    const key = currentKey();
    if (!key) return null;
    const a = Object.assign({ id: ++annIdCounter, type }, defaultsFor(type), geom);
    if (type === "text") syncTextHeight(a);
    annsFor(key).push(a);
    selectedId = a.id;
    return a;
  }

  function normalizeBox(a) {
    if (isLine(a)) return;
    if (a.w < 0) { a.x += a.w; a.w = -a.w; }
    if (a.h < 0) { a.y += a.h; a.h = -a.h; }
    a.w = Math.max(MIN_SIZE, a.w);
    a.h = Math.max(MIN_SIZE, a.h);
  }

  function refreshEditor() {
    updatePreview();
    renderInspector();
  }

  // ----- pointer interaction -----

  function evtPoint(e) {
    const cv = els.editorOverlay;
    const r = cv.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (cv.width / r.width),
      y: (e.clientY - r.top) * (cv.height / r.height),
    };
  }

  function armTool(tool) {
    armedTool = tool;
    [...els.toolRow.children].forEach((b) => b.classList.toggle("armed", b.dataset.tool === tool));
    els.editorOverlay.classList.toggle("tool-armed", !!tool);
    els.editorHint.textContent = tool
      ? (tool === "text" ? "Клікни по сторінці, щоб поставити текст." : "Протягни по сторінці, щоб намалювати.")
      : "Обери інструмент і намалюй просто на сторінці. Клікни по елементу, щоб змінити його.";
  }

  function onPointerDown(e) {
    if (!currentKey()) return;
    const p = evtPoint(e);
    els.editorOverlay.setPointerCapture(e.pointerId);

    if (armedTool) {
      const t = tpl();
      if (armedTool === "text") {
        const w = Math.min(t.canvasW * 0.6, t.canvasW - p.x - 20);
        addAnnotation("text", { x: p.x, y: p.y, w: Math.max(120, w), h: 0 });
        armTool(null);
        refreshEditor();
        els.insText.focus();
        els.insText.select();
        return;
      }
      const geom = isLine({ type: armedTool })
        ? { x1: p.x, y1: p.y, x2: p.x, y2: p.y }
        : { x: p.x, y: p.y, w: 1, h: 1 };
      const a = addAnnotation(armedTool, geom);
      drag = { mode: "create", id: a.id, ox: p.x, oy: p.y };
      armTool(null);
      refreshEditor();
      return;
    }

    const sel = selectedAnn();
    if (sel) {
      const handle = hitHandle(sel, p);
      if (handle === "rot") {
        drag = { mode: "rot", id: sel.id };
        return;
      }
      if (handle === "p1" || handle === "p2") {
        drag = { mode: "endpoint", id: sel.id, which: handle };
        return;
      }
      if (handle) {
        const cs = corners(sel);
        const idx = cs.findIndex((c) => c.id === handle);
        const opp = cs[(idx + 2) % 4];
        drag = { mode: "resize", id: sel.id, anchor: toWorld(sel, opp.x, opp.y) };
        return;
      }
    }

    const hit = hitAnn(p);
    if (hit) {
      selectedId = hit.id;
      drag = isLine(hit)
        ? { mode: "move", id: hit.id, px: p.x, py: p.y, ox: hit.x1, oy: hit.y1, ox2: hit.x2, oy2: hit.y2 }
        : { mode: "move", id: hit.id, px: p.x, py: p.y, ox: hit.x, oy: hit.y };
      refreshEditor();
      return;
    }

    selectedId = null;
    drag = null;
    refreshEditor();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const list = currentAnns();
    const a = list.find((x) => x.id === drag.id);
    if (!a) { drag = null; return; }
    const p = evtPoint(e);

    if (drag.mode === "create") {
      if (isLine(a)) { a.x2 = p.x; a.y2 = p.y; }
      else { a.w = p.x - drag.ox; a.h = p.y - drag.oy; }
    } else if (drag.mode === "move") {
      const dx = p.x - drag.px, dy = p.y - drag.py;
      if (isLine(a)) {
        a.x1 = drag.ox + dx; a.y1 = drag.oy + dy;
        a.x2 = drag.ox2 + dx; a.y2 = drag.oy2 + dy;
      } else {
        a.x = drag.ox + dx; a.y = drag.oy + dy;
      }
    } else if (drag.mode === "endpoint") {
      if (drag.which === "p1") { a.x1 = p.x; a.y1 = p.y; } else { a.x2 = p.x; a.y2 = p.y; }
    } else if (drag.mode === "rot") {
      const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
      let ang = Math.atan2(p.y - cy, p.x - cx) + Math.PI / 2;
      if (e.shiftKey) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      a.rot = ang;
    } else if (drag.mode === "resize") {
      // Work in the shape's own rotated axes, keeping the opposite corner pinned.
      const r = a.rot || 0;
      const ux = Math.cos(r), uy = Math.sin(r);
      const vx = -Math.sin(r), vy = Math.cos(r);
      const dx = p.x - drag.anchor.x, dy = p.y - drag.anchor.y;
      const lw = dx * ux + dy * uy;
      const lh = dx * vx + dy * vy;
      const sgnW = lw < 0 ? -1 : 1, sgnH = lh < 0 ? -1 : 1;
      let w = Math.max(MIN_SIZE, Math.abs(lw));
      let h = Math.max(MIN_SIZE, Math.abs(lh));
      if (e.shiftKey && a.type !== "text" && a.w && a.h) {
        const ratio = Math.abs(a.w / a.h);
        if (w / h > ratio) w = h * ratio; else h = w / ratio;
      }
      a.w = w;
      if (a.type === "text") syncTextHeight(a); else a.h = h;
      const cx = drag.anchor.x + ux * (sgnW * a.w / 2) + vx * (sgnH * a.h / 2);
      const cy = drag.anchor.y + uy * (sgnW * a.w / 2) + vy * (sgnH * a.h / 2);
      a.x = cx - a.w / 2;
      a.y = cy - a.h / 2;
    }
    refreshEditor();
  }

  function onPointerUp() {
    if (!drag) return;
    const a = currentAnns().find((x) => x.id === drag.id);
    if (a) {
      if (drag.mode === "create" && isLine(a) && dist({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) < 6) {
        // A plain click with a line tool: give it a sensible default length.
        a.x2 = a.x1 + tpl().canvasW * 0.25;
      }
      normalizeBox(a);
    }
    drag = null;
    refreshEditor();
  }

  // ----- inspector -----

  function tokensFor(a) {
    if (a.type === "text") return ["text", "all"];
    if (a.type === "rect") return ["box", "rect", "all"];
    if (a.type === "ellipse") return ["box", "all"];
    return ["line", "all"];
  }

  function setChip(flag, on) {
    const b = els.inspector.querySelector('.chip[data-flag="' + flag + '"]');
    if (b) b.classList.toggle("on", !!on);
  }

  function renderInspector() {
    const a = selectedAnn();
    els.inspector.classList.toggle("hidden", !a);
    if (!a) return;
    const set = new Set(tokensFor(a));
    els.inspector.querySelectorAll(".insp-row").forEach((row) => {
      const toks = (row.dataset.for || "").split(/\s+/);
      row.classList.toggle("hidden", !toks.some((t) => set.has(t)));
    });
    els.inspectorTitle.textContent = TYPE_LABEL[a.type] || "Елемент";

    if (a.type === "text") {
      if (document.activeElement !== els.insText) els.insText.value = a.text;
      els.insFont.value = a.font;
      els.insSize.value = a.size;
      els.insSizeVal.value = a.size;
      setChip("bold", a.bold); setChip("italic", a.italic); setChip("underline", a.underline);
      els.insAlign.querySelectorAll(".chip").forEach((b) => b.classList.toggle("on", b.dataset.align === a.align));
      els.insColor.value = a.color;
      els.insBg.value = a.bg || "#FFFFFF";
      setChip("dashed", false);
      els.inspector.querySelector('.chip-none[data-none="bg"]').classList.toggle("on", !a.bg);
    }
    if (a.type === "rect" || a.type === "ellipse") {
      els.insFill.value = a.fill || "#FFFFFF";
      els.inspector.querySelector('.chip-none[data-none="fill"]').classList.toggle("on", !a.fill);
      if (a.type === "rect") { els.insRadius.value = a.radius || 0; els.insRadiusVal.value = a.radius || 0; }
    }
    if (isLine(a)) setChip("dashed", a.dashed);

    els.insStroke.value = a.stroke || "#000000";
    els.inspector.querySelector('.chip-none[data-none="stroke"]').classList.toggle("on", !a.stroke);
    els.insStrokeW.value = a.strokeW || 0;
    els.insStrokeWVal.value = a.strokeW || 0;
    if (!isLine(a)) {
      const deg = Math.round(((a.rot || 0) * 180) / Math.PI);
      els.insRot.value = deg;
      els.insRotVal.value = deg + "°";
    }
    const op = Math.round((a.opacity == null ? 1 : a.opacity) * 100);
    els.insOpacity.value = op;
    els.insOpacityVal.value = op + "%";
  }

  function mutateSelected(fn) {
    const a = selectedAnn();
    if (!a) return;
    fn(a);
    refreshEditor();
  }

  function initEditorUI() {
    FONTS.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.css;
      opt.textContent = f.label;
      opt.style.fontFamily = f.css;
      els.insFont.appendChild(opt);
    });

    SWATCHES.forEach((hex) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.style.background = hex;
      b.title = hex;
      b.addEventListener("click", () => mutateSelected((a) => {
        // One-tap recolour: fills shapes, tints text, paints line strokes.
        if (a.type === "text") a.color = hex;
        else if (isLine(a)) a.stroke = hex;
        else a.fill = hex;
      }));
      els.insSwatches.appendChild(b);
    });

    els.toolRow.addEventListener("click", (e) => {
      const btn = e.target.closest(".tool-btn");
      if (!btn) return;
      armTool(armedTool === btn.dataset.tool ? null : btn.dataset.tool);
    });

    els.editorOverlay.addEventListener("pointerdown", onPointerDown);
    els.editorOverlay.addEventListener("pointermove", onPointerMove);
    els.editorOverlay.addEventListener("pointerup", onPointerUp);
    els.editorOverlay.addEventListener("pointercancel", onPointerUp);
    els.editorOverlay.addEventListener("dblclick", () => {
      const a = selectedAnn();
      if (a && a.type === "text") { els.insText.focus(); els.insText.select(); }
    });

    els.inspector.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (act) {
        const list = currentAnns();
        const a = selectedAnn();
        if (!a) return;
        const i = list.indexOf(a);
        if (act.dataset.act === "del") { list.splice(i, 1); selectedId = null; }
        else if (act.dataset.act === "dup") {
          const copy = Object.assign({}, a, { id: ++annIdCounter });
          const shift = tpl().canvasW * 0.02;
          if (isLine(copy)) { copy.x1 += shift; copy.y1 += shift; copy.x2 += shift; copy.y2 += shift; }
          else { copy.x += shift; copy.y += shift; }
          list.push(copy);
          selectedId = copy.id;
        } else if (act.dataset.act === "front" && i < list.length - 1) {
          list.splice(i, 1); list.splice(i + 1, 0, a);
        } else if (act.dataset.act === "back" && i > 0) {
          list.splice(i, 1); list.splice(i - 1, 0, a);
        }
        refreshEditor();
        return;
      }
      const flagBtn = e.target.closest(".chip[data-flag]");
      if (flagBtn) { mutateSelected((a) => { a[flagBtn.dataset.flag] = !a[flagBtn.dataset.flag]; }); return; }
      const alignBtn = e.target.closest(".chip[data-align]");
      if (alignBtn) { mutateSelected((a) => { a.align = alignBtn.dataset.align; }); return; }
      const noneBtn = e.target.closest(".chip-none[data-none]");
      if (noneBtn) {
        const prop = noneBtn.dataset.none === "bg" ? "bg" : noneBtn.dataset.none;
        mutateSelected((a) => {
          if (a[prop]) a[prop] = null;
          else a[prop] = prop === "bg" ? els.insBg.value : prop === "fill" ? els.insFill.value : els.insStroke.value;
        });
      }
    });

    els.insText.addEventListener("input", () => mutateSelected((a) => { a.text = els.insText.value; }));
    els.insFont.addEventListener("change", () => mutateSelected((a) => { a.font = els.insFont.value; }));
    els.insSize.addEventListener("input", () => mutateSelected((a) => { a.size = Number(els.insSize.value); }));
    els.insColor.addEventListener("input", () => mutateSelected((a) => { a.color = els.insColor.value; }));
    els.insFill.addEventListener("input", () => mutateSelected((a) => { a.fill = els.insFill.value; }));
    els.insBg.addEventListener("input", () => mutateSelected((a) => { a.bg = els.insBg.value; }));
    els.insStroke.addEventListener("input", () => mutateSelected((a) => {
      a.stroke = els.insStroke.value;
      if (!a.strokeW) a.strokeW = Math.max(2, Math.round(Math.min(tpl().canvasW, tpl().canvasH) * 0.005));
    }));
    els.insStrokeW.addEventListener("input", () => mutateSelected((a) => { a.strokeW = Number(els.insStrokeW.value); }));
    els.insRadius.addEventListener("input", () => mutateSelected((a) => { a.radius = Number(els.insRadius.value); }));
    els.insRot.addEventListener("input", () => mutateSelected((a) => { a.rot = (Number(els.insRot.value) * Math.PI) / 180; }));
    els.insOpacity.addEventListener("input", () => mutateSelected((a) => { a.opacity = Number(els.insOpacity.value) / 100; }));

    document.addEventListener("keydown", (e) => {
      if (!selectedId) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (typing) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const list = currentAnns();
        const a = selectedAnn();
        if (a) { list.splice(list.indexOf(a), 1); selectedId = null; refreshEditor(); }
      } else if (e.key === "Escape") {
        selectedId = null; armTool(null); refreshEditor();
      }
    });

    window.addEventListener("resize", () => drawOverlay());
  }

  // Annotations live in canvas coordinates, so a template switch (portrait A4 →
  // landscape frame) has to rescale them or they'd land off-page.
  function rescaleAnnotations(fromT, toT) {
    const sx = toT.canvasW / fromT.canvasW;
    const sy = toT.canvasH / fromT.canvasH;
    const sMin = Math.min(sx, sy);
    annotations.forEach((list) => {
      list.forEach((a) => {
        if (isLine(a)) {
          a.x1 *= sx; a.y1 *= sy; a.x2 *= sx; a.y2 *= sy;
        } else {
          a.x *= sx; a.y *= sy; a.w *= sx; a.h *= sy;
        }
        if (a.size) a.size = Math.max(8, a.size * sMin);
        if (a.strokeW) a.strokeW = Math.max(1, a.strokeW * sMin);
        if (a.radius) a.radius *= sMin;
      });
    });
  }

  function dropAnnotationsForJob(jobId) {
    [...annotations.keys()].forEach((k) => {
      if (k.slice(0, k.indexOf(":")) === String(jobId)) annotations.delete(k);
    });
  }

  // ---------- export ----------

  async function compositePageToJpegBlob(pageRef, opacity) {
    const t = tpl();
    const bitmap = await createImageBitmap(pageRef.blob);
    exportWorkCanvas.width = t.canvasW;
    exportWorkCanvas.height = t.canvasH;
    const ctx = exportWorkCanvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    ctx.globalAlpha = t.overlayOpacity ? opacity : 1;
    ctx.drawImage(overlayImg(), 0, 0, t.canvasW, t.canvasH);
    ctx.globalAlpha = 1;
    drawAnnotations(ctx, annsFor(pageRef.key));
    return canvasToJpegBlob(exportWorkCanvas);
  }

  async function buildPdfFromPages(pageRefs, opacity, onProgress) {
    const t = tpl();
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < pageRefs.length; i++) {
      const outBlob = await compositePageToJpegBlob(pageRefs[i], opacity);
      const bytes = await outBlob.arrayBuffer();
      const jpg = await pdfDoc.embedJpg(bytes);
      const page = pdfDoc.addPage([t.pdfPtW, t.pdfPtH]);
      page.drawImage(jpg, { x: 0, y: 0, width: t.pdfPtW, height: t.pdfPtH });
      onProgress && onProgress(i + 1, pageRefs.length);
    }
    return pdfDoc.save();
  }

  function setExporting(on) {
    isExporting = on;
    els.exportBtn.disabled = on || readyJobs().length === 0;
    els.exportSpinner.classList.toggle("hidden", !on);
    els.clearBtn.disabled = on;
    els.opacitySlider.disabled = on;
    els.exportProgressTrack.classList.toggle("hidden", !on);
    if (!on) {
      els.exportProgressFill.style.width = "0%";
      updateExportButtonLabel();
    }
  }

  function updateExportProgress(done, total) {
    els.exportProgressFill.style.width = Math.round((done / total) * 100) + "%";
    els.exportBtnLabel.textContent = `Обробка… ${done}/${total}`;
  }

  async function exportNow() {
    const ready = readyJobs();
    if (!ready.length) {
      showToast("Спочатку додай хоча б один файл", "error");
      return;
    }

    setExporting(true);
    try {
      const opacity = currentOpacityFraction();
      let cancelled = false;

      if (outputFormat === "pdf") {
        if (mergeMode === "merge" || ready.length === 1) {
          const allPages = ready.flatMap((j) => refsOfJob(j));
          const pdfBytes = await buildPdfFromPages(allPages, opacity, updateExportProgress);
          const blob = new Blob([pdfBytes], { type: "application/pdf" });
          const filename = (ready[0].baseName || "glamaterials") + "_glameng.pdf";
          const outcome = await deliverBlob(blob, filename, "application/pdf");
          cancelled = outcome === "cancelled";
          if (!cancelled) {
            await saveHistoryEntry({ name: filename, format: "pdf", pageCount: allPages.length, blob, blobName: filename, thumbSource: allPages[0].blob });
          }
        } else {
          const zip = await getJSZip();
          let done = 0;
          const total = totalPagesOf(ready);
          for (const job of ready) {
            const pdfBytes = await buildPdfFromPages(refsOfJob(job), opacity, (d) => {
              done += d - (job._doneSoFar || 0);
              job._doneSoFar = d;
              updateExportProgress(done, total);
            });
            zip.file(job.baseName + "_glameng.pdf", pdfBytes);
          }
          const zipBlob = await zip.generateAsync({ type: "blob" });
          const filename = `glamaterials_${ready.length}_pdf.zip`;
          const outcome = await deliverBlob(zipBlob, filename, "application/zip");
          cancelled = outcome === "cancelled";
          if (!cancelled) {
            await saveHistoryEntry({ name: filename, format: "pdf-zip", pageCount: total, blob: zipBlob, blobName: filename, thumbSource: ready[0].pages[0] });
          }
        }
      } else {
        const total = totalPagesOf(ready);
        const imageBlobs = [];
        const filenames = [];
        let done = 0;
        for (const job of ready) {
          const jobRefs = refsOfJob(job);
          for (let p = 0; p < jobRefs.length; p++) {
            const outBlob = await compositePageToJpegBlob(jobRefs[p], opacity);
            imageBlobs.push(outBlob);
            filenames.push(`${job.baseName}_${p + 1}.jpg`);
            done++;
            updateExportProgress(done, total);
          }
        }
        const zip = await getJSZip();
        imageBlobs.forEach((b, i) => zip.file(filenames[i], b));
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const zipFilename = "glamaterials_photos.zip";

        let shared = false;
        if (isTouchDevice() && navigator.canShare && typeof navigator.share === "function") {
          try {
            const files = imageBlobs.map((b, i) => new File([b], filenames[i], { type: "image/jpeg" }));
            if (navigator.canShare({ files })) {
              await navigator.share({ files, title: "GlaMaterials" });
              shared = true;
            }
          } catch (err) {
            if (err && err.name === "AbortError") cancelled = true;
          }
        }
        if (!shared && !cancelled) {
          triggerDownloadBlob(zipBlob, zipFilename);
        }
        if (!cancelled) {
          await saveHistoryEntry({ name: zipFilename, format: "photos-zip", pageCount: imageBlobs.length, blob: zipBlob, blobName: zipFilename, thumbSource: imageBlobs[0] });
        }
      }

      if (!cancelled) {
        showToast("Готово! Дякую 🎀", "success");
        celebrate(els.exportBtn);
      }
    } catch (err) {
      console.error(err);
      showToast("Не вдалося сформувати файл. Спробуй ще раз.", "error");
    } finally {
      setExporting(false);
    }
  }

  // ---------- history (IndexedDB) ----------

  const DB_NAME = "glamaterials";
  const DB_STORE = "history";
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function historyAdd(entry) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function historyGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
      req.onerror = () => reject(req.error);
    });
  }

  async function historyDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function historyEnforceCap() {
    const all = await historyGetAll();
    if (all.length > MAX_HISTORY) {
      for (const e of all.slice(MAX_HISTORY)) await historyDelete(e.id);
    }
  }

  async function saveHistoryEntry({ name, format, pageCount, blob, blobName, thumbSource }) {
    try {
      if (blob.size > MAX_HISTORY_ITEM_BYTES) { console.warn("history: result too large, skipping save"); return; }
      const thumb = await makeThumbDataUrl(thumbSource, 120);
      const id = "h" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      await historyAdd({ id, name, format, pageCount, createdAt: Date.now(), thumb, blob, blobName });
      await historyEnforceCap();
      if (!els.panelHistory.classList.contains("hidden")) renderHistoryList();
    } catch (err) {
      console.error("history save failed", err);
    }
  }

  function formatHistoryMeta(entry) {
    const date = new Date(entry.createdAt);
    const dateStr = date.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" }) + " " +
      date.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
    const kind = entry.format === "photos-zip" ? "фото (zip)" : entry.format === "pdf-zip" ? "PDF (zip)" : "PDF";
    return `${dateStr} · ${entry.pageCount} стор. · ${kind}`;
  }

  async function renderHistoryList() {
    const all = await historyGetAll();
    els.historyList.innerHTML = "";
    els.historyEmpty.classList.toggle("hidden", all.length > 0);
    for (const entry of all) {
      const li = document.createElement("li");
      li.className = "history-card";

      const img = document.createElement("img");
      img.className = "history-thumb";
      img.src = entry.thumb;

      const info = document.createElement("div");
      info.className = "history-info";
      const nameEl = document.createElement("span");
      nameEl.className = "history-name";
      nameEl.textContent = entry.name;
      const metaEl = document.createElement("span");
      metaEl.className = "history-meta";
      metaEl.textContent = formatHistoryMeta(entry);
      info.appendChild(nameEl);
      info.appendChild(metaEl);

      const actions = document.createElement("div");
      actions.className = "history-actions";
      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.setAttribute("aria-label", "Завантажити ще раз");
      dlBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></svg>';
      dlBtn.addEventListener("click", async () => {
        const mime = entry.format === "pdf" ? "application/pdf" : entry.format === "photos-zip" || entry.format === "pdf-zip" ? "application/zip" : entry.blob.type || "application/octet-stream";
        const outcome = await deliverBlob(entry.blob, entry.blobName, mime);
        if (outcome !== "cancelled") showToast("Завантаження почалось", "success");
      });
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.setAttribute("aria-label", "Видалити з історії");
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", async () => {
        await historyDelete(entry.id);
        renderHistoryList();
      });
      actions.appendChild(dlBtn);
      actions.appendChild(delBtn);

      li.appendChild(img);
      li.appendChild(info);
      li.appendChild(actions);
      els.historyList.appendChild(li);
    }
  }

  // ---------- wiring ----------

  els.fileInput.addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });

  els.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragover");
  });
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragover"));
  els.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragover");
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  ["dragover", "drop"].forEach((evt) => {
    window.addEventListener(evt, (e) => {
      if (e.target !== els.dropzone && !els.dropzone.contains(e.target)) e.preventDefault();
    });
  });

  els.templateToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn || btn.dataset.value === activeTemplate) return;
    const hadJobs = jobs.length > 0;
    const prevTpl = tpl();
    activeTemplate = btn.dataset.value;
    rescaleAnnotations(prevTpl, tpl());
    [...els.templateToggle.children].forEach((b) => b.classList.toggle("active", b === btn));

    outputFormat = activeTemplate === "frame" ? "photos" : "pdf";
    [...els.formatToggle.children].forEach((b) => b.classList.toggle("active", b.dataset.value === outputFormat));

    requeueJobsForTemplateChange();
    updateDropzoneHint();
    if (hadJobs) showToast("Файли перероблено під новий шаблон", "success");
  });

  els.mergeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    mergeMode = btn.dataset.value;
    [...els.mergeToggle.children].forEach((b) => b.classList.toggle("active", b === btn));
    updateExportButtonLabel();
  });

  els.formatToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    outputFormat = btn.dataset.value;
    [...els.formatToggle.children].forEach((b) => b.classList.toggle("active", b === btn));
    updateSettingsVisibility();
  });

  els.opacitySlider.addEventListener("input", () => {
    els.opacityValue.textContent = els.opacitySlider.value + "%";
    updatePreview();
    try { localStorage.setItem(OPACITY_STORAGE_KEY, els.opacitySlider.value); } catch (err) { /* private mode etc — non-essential */ }
  });

  els.previewPrev.addEventListener("click", () => shiftPreview(-1));
  els.previewNext.addEventListener("click", () => shiftPreview(1));

  els.exportBtn.addEventListener("click", exportNow);
  els.clearBtn.addEventListener("click", resetQueue);

  els.historyBtn.addEventListener("click", () => {
    els.panelHistory.classList.remove("hidden");
    renderHistoryList();
    els.panelHistory.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  els.closeHistoryBtn.addEventListener("click", () => els.panelHistory.classList.add("hidden"));

  (() => {
    let initialOpacity = DEFAULT_OPACITY;
    try {
      const saved = localStorage.getItem(OPACITY_STORAGE_KEY);
      if (saved !== null && !Number.isNaN(Number(saved))) initialOpacity = Number(saved);
    } catch (err) { /* private mode etc — fall back to default */ }
    els.opacitySlider.value = String(initialOpacity);
    els.opacityValue.textContent = initialOpacity + "%";
  })();
  updateDropzoneHint();
  initEditorUI();

  loadImageFromDataUri(WATERMARK_DATA_URI).then((img) => { watermarkImg = img; }).catch((err) => {
    console.error(err);
    showToast("Не вдалося завантажити водяний знак", "error");
  });
  loadImageFromDataUri(FRAME_DATA_URI).then((img) => { frameImg = img; }).catch((err) => {
    console.error(err);
    showToast("Не вдалося завантажити шаблон рамки", "error");
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const reg = await navigator.serviceWorker.register("sw.js");
        reg.update().catch(() => {});
        // A new SW took over mid-session (i.e. this tab was open across a deploy) —
        // reload once so the page actually runs the version it just fetched.
        let reloaded = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (reloaded) return;
          reloaded = true;
          window.location.reload();
        });
      } catch (err) {
        // offline-support is a bonus, never block the app on it
      }
    });
  }
})();
