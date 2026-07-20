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
    insPlace: document.getElementById("ins-place"),
    cropBar: document.getElementById("crop-bar"),
    cropToggle: document.getElementById("crop-toggle"),
    cropZoom: document.getElementById("crop-zoom"),
    cropZoomVal: document.getElementById("crop-zoom-val"),
    cropReset: document.getElementById("crop-reset"),
    undoBtn: document.getElementById("undo-btn"),
    redoBtn: document.getElementById("redo-btn"),
    imageInput: document.getElementById("image-input"),
    colorPop: document.getElementById("color-pop"),
    colorPopGrid: document.getElementById("color-pop-grid"),
    colorPopRecent: document.getElementById("color-pop-recent"),
    colorPopRecentTitle: document.getElementById("color-pop-recent-title"),
    colorPopInput: document.getElementById("color-pop-input"),
    colorPopNone: document.getElementById("color-pop-none"),
    insStrokeW: document.getElementById("ins-stroke-w"),
    insStrokeWVal: document.getElementById("ins-stroke-w-val"),
    insBgPad: document.getElementById("ins-bg-pad"),
    insBgPadVal: document.getElementById("ins-bg-pad-val"),
    insBgRadius: document.getElementById("ins-bg-radius"),
    insBgRadiusVal: document.getElementById("ins-bg-radius-val"),
    insBgStrokeW: document.getElementById("ins-bg-stroke-w"),
    insBgStrokeWVal: document.getElementById("ins-bg-stroke-w-val"),
    insRadius: document.getElementById("ins-radius"),
    insRadiusVal: document.getElementById("ins-radius-val"),
    insRot: document.getElementById("ins-rot"),
    insRotVal: document.getElementById("ins-rot-val"),
    insOpacity: document.getElementById("ins-opacity"),
    insOpacityVal: document.getElementById("ins-opacity-val"),
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
  // Clamped so the photo always covers the window — panning can never expose a gap.
  function coverPlacement(srcW, srcH, fit) {
    const rect = tpl().window;
    const f = fit || {};
    const zoom = Math.max(1, f.zoom || 1);
    const scale = Math.max(rect.w / srcW, rect.h / srcH) * zoom;
    const w = srcW * scale;
    const h = srcH * scale;
    const slackX = Math.max(0, (w - rect.w) / 2);
    const slackY = Math.max(0, (h - rect.h) / 2);
    const ox = Math.max(-slackX, Math.min(slackX, f.dx || 0));
    const oy = Math.max(-slackY, Math.min(slackY, f.dy || 0));
    return { w, h, dx: rect.x + (rect.w - w) / 2 + ox, dy: rect.y + (rect.h - h) / 2 + oy, slackX, slackY };
  }

  function placePhoto(ctx, drawable, srcW, srcH, fit) {
    const t = tpl();
    if (t.fit === "cover") {
      const rect = t.window;
      const pl = coverPlacement(srcW, srcH, fit);
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      ctx.drawImage(drawable, pl.dx, pl.dy, pl.w, pl.h);
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
    try {
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
        // Free the page's own scratch buffers as we go — a long PDF otherwise
        // keeps every rendered page alive at once, which is what kills iPhones.
        page.cleanup();
        pageCanvas.width = pageCanvas.height = 0;
        onProgress && onProgress(pages.length, doc.numPages);
      }
    } finally {
      // Without this every processed PDF leaves its pdf.js worker running.
      await doc.destroy().catch(() => {});
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

  async function renderImageFile(file, job) {
    let sourceBlob = file;
    if (isHeic(file)) {
      await loadScriptOnce("vendor/heic2any.min.js");
      const result = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
      sourceBlob = Array.isArray(result) ? result[0] : result;
    }
    const img = await loadImageFromBlob(sourceBlob);
    // Keep the decoded source around so re-cropping doesn't decode again.
    if (job) { job.srcImg = img; job.srcW = img.naturalWidth; job.srcH = img.naturalHeight; }
    const { canvas, ctx } = makeBaseCanvas();
    placePhoto(ctx, img, img.naturalWidth, img.naturalHeight, job && job.fit);
    return [await canvasToJpegBlob(canvas)];
  }

  // Re-bake a photo job's page after its crop changed.
  async function rerenderJobPhoto(job) {
    if (!job || !job.srcImg) return;
    const { canvas, ctx } = makeBaseCanvas();
    placePhoto(ctx, job.srcImg, job.srcW, job.srcH, job.fit);
    job.pages = [await canvasToJpegBlob(canvas)];
    job.thumbUrl = await makeThumbDataUrl(job.pages[0]);
    renderJobList();
    updatePreview();
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
          : await renderImageFile(job.file, job);
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
      updateCropBar();
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
        fit: { zoom: 1, dx: 0, dy: 0 }, // manual crop inside the frame window
        srcImg: null, srcW: 0, srcH: 0,
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
    imageCache.clear();
    undoStack.length = 0;
    redoStack.length = 0;
    updateHistoryButtons();
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
    // Second block: faces that ship with macOS/iOS (this app's main devices),
    // each with a fallback chain so other platforms still get something close.
    { label: "Avenir Next", css: "'Avenir Next', Avenir, 'Segoe UI', sans-serif" },
    { label: "Futura", css: "Futura, 'Century Gothic', 'Trebuchet MS', sans-serif" },
    { label: "Optima", css: "Optima, Candara, 'Gill Sans', sans-serif" },
    { label: "Gill Sans", css: "'Gill Sans', 'Gill Sans MT', Calibri, sans-serif" },
    { label: "Tahoma", css: "Tahoma, Geneva, Verdana, sans-serif" },
    { label: "Palatino", css: "Palatino, 'Palatino Linotype', 'Book Antiqua', serif" },
    { label: "Baskerville", css: "Baskerville, 'Baskerville Old Face', Garamond, serif" },
    { label: "Didot", css: "Didot, 'Bodoni MT', 'Playfair Display', Georgia, serif" },
    { label: "American Typewriter", css: "'American Typewriter', 'Courier New', serif" },
    { label: "Snell Roundhand — рукопис", css: "'Snell Roundhand', 'Brush Script MT', 'Segoe Script', cursive" },
  ];

  const SWATCHES = [
    "#3D1F2D", "#E8849A", "#9D2F7F", "#B04060", "#F2A0B8",
    "#FFFFFF", "#000000", "#6B7280", "#2E7D32", "#1565C0",
    "#F9A825", "#D32F2F", "#7B3FA0", "#0F766E", "#C2410C",
  ];
  const RECENT_KEY = "glamaterials_recent_colors";
  const MAX_RECENT = 5;

  const TYPE_LABEL = {
    text: "Текст", rect: "Прямокутник", ellipse: "Овал",
    line: "Лінія", arrow: "Стрілка", image: "Фото",
  };
  const LINE_H = 1.25;
  const MIN_SIZE = 14;
  const SNAP_PX = 7; // in screen pixels; converted to canvas units at drag time

  const annotations = new Map(); // pageKey -> annotation[]
  const measureCtx = document.createElement("canvas").getContext("2d");
  const imageCache = new Map(); // annotation id -> HTMLImageElement
  let annIdCounter = 0;
  let selectedId = null;
  let armedTool = null;
  let drag = null;
  let activeGuides = [];
  let recentColors = [];

  // ----- undo / redo -----

  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO = 60;
  let lastHistoryTag = null;
  let lastHistoryAt = 0;

  function snapshot() {
    const out = {};
    annotations.forEach((list, key) => { out[key] = list.map((a) => Object.assign({}, a)); });
    return out;
  }

  function restoreSnapshot(snap) {
    annotations.clear();
    Object.keys(snap).forEach((k) => annotations.set(k, snap[k].map((a) => Object.assign({}, a))));
    if (!currentAnns().some((a) => a.id === selectedId)) selectedId = null;
  }

  // `tag` coalesces bursts: dragging a slider records one undo step, not eighty.
  function pushHistory(tag) {
    const now = Date.now();
    if (tag && tag === lastHistoryTag && now - lastHistoryAt < 900) {
      lastHistoryAt = now;
      return;
    }
    lastHistoryTag = tag || null;
    lastHistoryAt = now;
    undoStack.push(snapshot());
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    els.undoBtn.disabled = undoStack.length === 0;
    els.redoBtn.disabled = redoStack.length === 0;
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restoreSnapshot(undoStack.pop());
    lastHistoryTag = null;
    updateHistoryButtons();
    refreshEditor();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restoreSnapshot(redoStack.pop());
    lastHistoryTag = null;
    updateHistoryButtons();
    refreshEditor();
  }

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
      // The plate behaves like a rectangle behind the text: its own padding,
      // corner radius and outline, independent of the glyph contour.
      const pad = a.size * (a.bgPad == null ? 0.24 : a.bgPad);
      const bx = a.x - pad, by = a.y - pad;
      const bw = a.w + pad * 2, bh = a.h + pad * 2;
      pathRoundRect(ctx, bx, by, bw, bh, a.bgRadius || 0);
      ctx.fillStyle = a.bg;
      ctx.fill();
      if (a.bgStroke && a.bgStrokeW > 0) {
        ctx.lineWidth = a.bgStrokeW;
        ctx.strokeStyle = a.bgStroke;
        ctx.stroke();
      }
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

  function imageFor(a) {
    let img = imageCache.get(a.id);
    if (!img) {
      img = new Image();
      img.onload = () => { updatePreview(); };
      img.src = a.src;
      imageCache.set(a.id, img);
    }
    return img;
  }

  function drawImageAnn(ctx, a) {
    const img = imageFor(a);
    if (!img.complete || !img.naturalWidth) return;
    if (a.radius > 0) {
      ctx.save();
      pathRoundRect(ctx, a.x, a.y, a.w, a.h, a.radius);
      ctx.clip();
      ctx.drawImage(img, a.x, a.y, a.w, a.h);
      ctx.restore();
    } else {
      ctx.drawImage(img, a.x, a.y, a.w, a.h);
    }
    if (a.stroke && a.strokeW > 0) {
      pathRoundRect(ctx, a.x, a.y, a.w, a.h, a.radius || 0);
      ctx.lineWidth = a.strokeW;
      ctx.strokeStyle = a.stroke;
      ctx.stroke();
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
        } else if (a.type === "image") {
          drawImageAnn(ctx, a);
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

  // ----- smart guides -----
  // While dragging we compare the moved element's left/centre/right (and top/
  // middle/bottom) against the page's own edges and centre plus every other
  // element's edges, and pull to whichever is closest inside the threshold.

  function edgesOf(a) {
    if (isLine(a)) {
      const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
      const w = Math.abs(a.x2 - a.x1), h = Math.abs(a.y2 - a.y1);
      return { x, y, w, h };
    }
    return { x: a.x, y: a.y, w: a.w, h: a.h };
  }

  function snapTargets(exceptId) {
    const t = tpl();
    const margin = Math.round(Math.min(t.canvasW, t.canvasH) * 0.06);
    const xs = [
      { v: margin, kind: "edge" },
      { v: t.canvasW / 2, kind: "center" },
      { v: t.canvasW - margin, kind: "edge" },
    ];
    const ys = [
      { v: margin, kind: "edge" },
      { v: t.canvasH / 2, kind: "center" },
      { v: t.canvasH - margin, kind: "edge" },
    ];
    for (const o of currentAnns()) {
      if (o.id === exceptId) continue;
      const e = edgesOf(o);
      xs.push({ v: e.x, kind: "obj" }, { v: e.x + e.w / 2, kind: "obj" }, { v: e.x + e.w, kind: "obj" });
      ys.push({ v: e.y, kind: "obj" }, { v: e.y + e.h / 2, kind: "obj" }, { v: e.y + e.h, kind: "obj" });
    }
    return { xs, ys };
  }

  // Returns {dx, dy} nudges plus the guide lines to draw for this frame.
  function computeSnap(a) {
    const tol = SNAP_PX * overlayScale();
    const e = edgesOf(a);
    const { xs, ys } = snapTargets(a.id);
    const guides = [];
    let dx = 0, dy = 0;

    const mine = [
      { at: e.x, off: 0 },
      { at: e.x + e.w / 2, off: e.w / 2 },
      { at: e.x + e.w, off: e.w },
    ];
    let bestX = null;
    for (const m of mine) {
      for (const s of xs) {
        const d = s.v - m.at;
        if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, v: s.v };
      }
    }
    if (bestX) { dx = bestX.d; guides.push({ axis: "x", v: bestX.v }); }

    const mineY = [
      { at: e.y, off: 0 },
      { at: e.y + e.h / 2, off: e.h / 2 },
      { at: e.y + e.h, off: e.h },
    ];
    let bestY = null;
    for (const m of mineY) {
      for (const s of ys) {
        const d = s.v - m.at;
        if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, v: s.v };
      }
    }
    if (bestY) { dy = bestY.d; guides.push({ axis: "y", v: bestY.v }); }

    return { dx, dy, guides };
  }

  function applySnap(a) {
    const { dx, dy, guides } = computeSnap(a);
    if (dx || dy) moveAnn(a, dx, dy);
    activeGuides = guides;
  }

  function moveAnn(a, dx, dy) {
    if (isLine(a)) { a.x1 += dx; a.y1 += dy; a.x2 += dx; a.y2 += dy; }
    else { a.x += dx; a.y += dy; }
  }

  function placeOnPage(a, where) {
    const t = tpl();
    const e = edgesOf(a);
    const margin = Math.round(Math.min(t.canvasW, t.canvasH) * 0.06);
    if (where === "left") moveAnn(a, margin - e.x, 0);
    else if (where === "right") moveAnn(a, t.canvasW - margin - (e.x + e.w), 0);
    else if (where === "centerX") moveAnn(a, t.canvasW / 2 - (e.x + e.w / 2), 0);
    else if (where === "top") moveAnn(a, 0, margin - e.y);
    else if (where === "bottom") moveAnn(a, 0, t.canvasH - margin - (e.y + e.h));
    else if (where === "centerY") moveAnn(a, 0, t.canvasH / 2 - (e.y + e.h / 2));
    else if (where === "middle") moveAnn(a, t.canvasW / 2 - (e.x + e.w / 2), t.canvasH / 2 - (e.y + e.h / 2));
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

  function drawGuides(ctx, s) {
    if (!activeGuides.length) return;
    const cv = els.editorOverlay;
    ctx.save();
    ctx.strokeStyle = "#9D2F7F";
    ctx.lineWidth = 1.4 * s;
    ctx.setLineDash([9 * s, 6 * s]);
    for (const g of activeGuides) {
      ctx.beginPath();
      if (g.axis === "x") { ctx.moveTo(g.v, 0); ctx.lineTo(g.v, cv.height); }
      else { ctx.moveTo(0, g.v); ctx.lineTo(cv.width, g.v); }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawOverlay() {
    const cv = els.editorOverlay;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    const s0 = overlayScale();
    drawGuides(ctx, s0);
    const a = selectedAnn();
    if (!a) return;
    const s = s0;
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
        color: "#3D1F2D", stroke: null, strokeW: 0, rot: 0, opacity: 1,
        bg: null, bgPad: 0.24, bgRadius: Math.round(base * 0.012), bgStroke: null, bgStrokeW: 0,
      };
    }
    if (type === "rect" || type === "ellipse") {
      return {
        fill: "#E8849A", stroke: "#3D1F2D", strokeW: sw,
        radius: type === "rect" ? Math.round(base * 0.014) : 0, rot: 0, opacity: 1,
      };
    }
    if (type === "image") {
      return { src: "", stroke: null, strokeW: 0, radius: 0, rot: 0, opacity: 1 };
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
    updateCropBar();
  }

  // ----- manual photo crop (frame template) -----

  let cropMode = false;

  // The job whose photo the current preview page came from.
  function currentPhotoJob() {
    const key = currentKey();
    if (!key) return null;
    const jobId = Number(key.slice(0, key.indexOf(":")));
    const job = jobs.find((j) => j.id === jobId);
    return job && job.srcImg ? job : null;
  }

  function cropAvailable() {
    return activeTemplate === "frame" && !!currentPhotoJob();
  }

  function setCropMode(on) {
    const job = currentPhotoJob();
    cropMode = !!on && !!job;
    els.cropToggle.classList.toggle("on", cropMode);
    els.cropToggle.textContent = cropMode ? "Готово" : "Посунути фото";
    els.editorOverlay.classList.toggle("crop-mode", cropMode);
    if (cropMode) {
      selectedId = null;
      armTool(null);
      renderInspector();
      drawOverlay();
    }
  }

  function updateCropBar() {
    const show = cropAvailable();
    els.cropBar.classList.toggle("hidden", !show);
    if (!show) {
      if (cropMode) setCropMode(false);
      return;
    }
    const job = currentPhotoJob();
    const z = Math.round((job.fit.zoom || 1) * 100);
    els.cropZoom.value = z;
    els.cropZoomVal.value = z + "%";
  }

  // Repaint the cached page composite in place so panning feels immediate;
  // the page blob itself is re-baked once on release.
  function paintCropPreview(job) {
    const t = tpl();
    const ref = currentRef();
    if (!ref) return;
    previewWorkCanvas.width = t.canvasW;
    previewWorkCanvas.height = t.canvasH;
    const ctx = previewWorkCanvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, t.canvasW, t.canvasH);
    placePhoto(ctx, job.srcImg, job.srcW, job.srcH, job.fit);
    ctx.drawImage(overlayImg(), 0, 0, t.canvasW, t.canvasH);
    previewBase = { blob: ref.blob, opacity: 1, w: t.canvasW, h: t.canvasH };

    els.previewCanvas.width = t.canvasW;
    els.previewCanvas.height = t.canvasH;
    const pctx = els.previewCanvas.getContext("2d");
    pctx.drawImage(previewWorkCanvas, 0, 0);
    drawAnnotations(pctx, annsFor(ref.key));
  }

  function commitCrop(job) {
    previewBase = { blob: null, opacity: null, w: 0, h: 0 }; // force a clean recomposite
    rerenderJobPhoto(job);
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
    try { els.editorOverlay.setPointerCapture(e.pointerId); } catch (err) { /* no capture on this pointer */ }

    if (cropMode) {
      const job = currentPhotoJob();
      if (job) drag = { mode: "crop", jobId: job.id, px: p.x, py: p.y, ox: job.fit.dx, oy: job.fit.dy };
      return;
    }

    if (armedTool) {
      const t = tpl();
      pushHistory(null);
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
      if (handle) pushHistory(null);
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
      pushHistory(null);
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
    if (drag.mode === "crop") {
      const job = jobs.find((j) => j.id === drag.jobId);
      if (!job) { drag = null; return; }
      const p = evtPoint(e);
      job.fit.dx = drag.ox + (p.x - drag.px);
      job.fit.dy = drag.oy + (p.y - drag.py);
      paintCropPreview(job);
      return;
    }
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
      if (a.type === "text") syncTextHeight(a);
      if (e.shiftKey) activeGuides = []; else applySnap(a); // Shift = move freely
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
    // Guides must go even if the drag was already torn down (stray/cancelled
    // pointer), otherwise a stale guide line stays painted over the page.
    if (!drag) {
      if (activeGuides.length) { activeGuides = []; drawOverlay(); }
      return;
    }
    if (drag.mode === "crop") {
      const job = jobs.find((j) => j.id === drag.jobId);
      drag = null;
      if (job) commitCrop(job);
      return;
    }
    const a = currentAnns().find((x) => x.id === drag.id);
    if (a) {
      if (drag.mode === "create" && isLine(a) && dist({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) < 6) {
        // A plain click with a line tool: give it a sensible default length.
        a.x2 = a.x1 + tpl().canvasW * 0.25;
      }
      normalizeBox(a);
    }
    drag = null;
    activeGuides = [];
    refreshEditor();
  }

  // ----- inspector -----

  function tokensFor(a) {
    // Plate settings only make sense once the text actually has a plate.
    if (a.type === "text") return a.bg ? ["text", "bg", "all"] : ["text", "all"];
    if (a.type === "rect") return ["box", "rect", "all"];
    if (a.type === "ellipse") return ["box", "all"];
    if (a.type === "image") return ["image", "all"];
    return ["line", "all"];
  }

  function setChip(flag, on) {
    const b = els.inspector.querySelector('.chip[data-flag="' + flag + '"]');
    if (b) b.classList.toggle("on", !!on);
  }

  // ----- colour popover -----

  let colorPopProp = null;

  // Picking an outline colour while its width is 0 would look like nothing
  // happened, so give it a visible default the first time.
  function applyDefaultStrokeWidth(a, hex) {
    if (!hex) return;
    const w = Math.max(2, Math.round(Math.min(tpl().canvasW, tpl().canvasH) * 0.005));
    if (colorPopProp === "stroke" && !a.strokeW) a.strokeW = w;
    if (colorPopProp === "bgStroke" && !a.bgStrokeW) a.bgStrokeW = w;
  }

  function loadRecentColors() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      if (Array.isArray(raw)) recentColors = raw.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, MAX_RECENT);
    } catch (err) { /* private mode — recents are a nicety, not a requirement */ }
  }

  function rememberColor(hex) {
    if (!hex) return;
    recentColors = [hex, ...recentColors.filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, MAX_RECENT);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentColors)); } catch (err) { /* non-essential */ }
  }

  function paintColorBtn(btn, value) {
    const dot = btn.querySelector(".dot") || (() => {
      btn.innerHTML = '<span class="dot"></span><span class="label"></span>';
      return btn.querySelector(".dot");
    })();
    const label = btn.querySelector(".label");
    dot.classList.toggle("none", !value);
    dot.style.background = value || "";
    label.textContent = value ? value.toUpperCase() : "Без кольору";
  }

  function buildSwatchGrid(container, colors, current, onPick) {
    container.innerHTML = "";
    colors.forEach((hex) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch" + (current && current.toLowerCase() === hex.toLowerCase() ? " on" : "");
      b.style.background = hex;
      b.title = hex;
      b.addEventListener("click", () => onPick(hex));
      container.appendChild(b);
    });
  }

  function closeColorPop() {
    els.colorPop.classList.add("hidden");
    els.inspector.querySelectorAll(".color-btn").forEach((b) => b.classList.remove("open"));
    colorPopProp = null;
  }

  function openColorPop(btn) {
    const a = selectedAnn();
    if (!a) return;
    colorPopProp = btn.dataset.color;
    const current = a[colorPopProp] || null;
    const nullable = btn.dataset.nullable === "1";

    const pick = (hex) => {
      pushHistory(null);
      const sel = selectedAnn();
      if (!sel) return;
      sel[colorPopProp] = hex;
      // Giving a shape an outline colour with zero width would look like nothing happened.
      applyDefaultStrokeWidth(sel, hex);
      rememberColor(hex);
      closeColorPop();
      refreshEditor();
    };

    buildSwatchGrid(els.colorPopGrid, SWATCHES, current, pick);
    const hasRecent = recentColors.length > 0;
    els.colorPopRecent.classList.toggle("hidden", !hasRecent);
    els.colorPopRecentTitle.classList.toggle("hidden", !hasRecent);
    if (hasRecent) buildSwatchGrid(els.colorPopRecent, recentColors, current, pick);

    els.colorPopInput.value = current || "#E8849A";
    els.colorPopInput.oninput = () => {
      const sel = selectedAnn();
      if (!sel) return;
      pushHistory("color-custom");
      sel[colorPopProp] = els.colorPopInput.value;
      if (colorPopProp === "stroke" && !sel.strokeW) {
        sel.strokeW = Math.max(2, Math.round(Math.min(tpl().canvasW, tpl().canvasH) * 0.005));
      }
      refreshEditor();
    };
    els.colorPopInput.onchange = () => rememberColor(els.colorPopInput.value);

    els.colorPopNone.classList.toggle("hidden", !nullable);
    els.colorPopNone.onclick = () => {
      pushHistory(null);
      const sel = selectedAnn();
      if (sel) sel[colorPopProp] = null;
      closeColorPop();
      refreshEditor();
    };

    els.inspector.querySelectorAll(".color-btn").forEach((b) => b.classList.toggle("open", b === btn));
    els.colorPop.classList.remove("hidden");

    // Keep the popover on screen next to its button.
    const r = btn.getBoundingClientRect();
    const pw = els.colorPop.offsetWidth, ph = els.colorPop.offsetHeight;
    let left = Math.min(r.right - pw, window.innerWidth - pw - 8);
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    els.colorPop.style.left = Math.max(8, left) + "px";
    els.colorPop.style.top = top + "px";
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
      if (a.bg) {
        const padPct = Math.round((a.bgPad == null ? 0.24 : a.bgPad) * 100);
        els.insBgPad.value = padPct;
        els.insBgPadVal.value = padPct + "%";
        els.insBgRadius.value = a.bgRadius || 0;
        els.insBgRadiusVal.value = a.bgRadius || 0;
        els.insBgStrokeW.value = a.bgStrokeW || 0;
        els.insBgStrokeWVal.value = a.bgStrokeW || 0;
      }
    }
    if (a.type === "rect" || a.type === "image") {
      els.insRadius.value = a.radius || 0;
      els.insRadiusVal.value = a.radius || 0;
    }
    if (isLine(a)) setChip("dashed", a.dashed);

    els.inspector.querySelectorAll(".color-btn").forEach((btn) => {
      paintColorBtn(btn, a[btn.dataset.color] || null);
    });

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

    loadRecentColors();

    els.toolRow.addEventListener("click", (e) => {
      const btn = e.target.closest(".tool-btn");
      if (!btn) return;
      if (btn.dataset.tool === "image") {
        armTool(null);
        els.imageInput.value = "";
        els.imageInput.click();
        return;
      }
      armTool(armedTool === btn.dataset.tool ? null : btn.dataset.tool);
    });

    els.imageInput.addEventListener("change", () => {
      const file = els.imageInput.files && els.imageInput.files[0];
      if (!file || !currentKey()) return;
      const reader = new FileReader();
      reader.onload = () => {
        const probe = new Image();
        probe.onload = () => {
          const t = tpl();
          // Drop it in at a comfortable size, centred, keeping its aspect ratio.
          const maxW = t.canvasW * 0.45;
          const scale = Math.min(maxW / probe.naturalWidth, (t.canvasH * 0.45) / probe.naturalHeight);
          const w = probe.naturalWidth * scale;
          const h = probe.naturalHeight * scale;
          pushHistory(null);
          addAnnotation("image", {
            x: (t.canvasW - w) / 2, y: (t.canvasH - h) / 2, w, h, src: reader.result,
          });
          refreshEditor();
          showToast("Фото додано на сторінку", "success");
        };
        probe.onerror = () => showToast("Не вдалося прочитати це зображення", "error");
        probe.src = reader.result;
      };
      reader.onerror = () => showToast("Не вдалося прочитати файл", "error");
      reader.readAsDataURL(file);
    });

    els.undoBtn.addEventListener("click", undo);
    els.redoBtn.addEventListener("click", redo);

    els.cropToggle.addEventListener("click", () => setCropMode(!cropMode));
    els.cropZoom.addEventListener("input", () => {
      const job = currentPhotoJob();
      if (!job) return;
      job.fit.zoom = Number(els.cropZoom.value) / 100;
      els.cropZoomVal.value = els.cropZoom.value + "%";
      paintCropPreview(job);
    });
    els.cropZoom.addEventListener("change", () => {
      const job = currentPhotoJob();
      if (job) commitCrop(job);
    });
    els.cropReset.addEventListener("click", () => {
      const job = currentPhotoJob();
      if (!job) return;
      job.fit = { zoom: 1, dx: 0, dy: 0 };
      els.cropZoom.value = 100;
      els.cropZoomVal.value = "100%";
      commitCrop(job);
    });

    els.insPlace.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-place]");
      if (!btn) return;
      pushHistory(null);
      mutateSelected((a) => placeOnPage(a, btn.dataset.place));
    });

    document.addEventListener("pointerdown", (e) => {
      if (els.colorPop.classList.contains("hidden")) return;
      if (els.colorPop.contains(e.target) || e.target.closest(".color-btn")) return;
      closeColorPop();
    });
    window.addEventListener("scroll", () => { if (!els.colorPop.classList.contains("hidden")) closeColorPop(); }, true);

    els.editorOverlay.addEventListener("pointerdown", onPointerDown);
    els.editorOverlay.addEventListener("pointermove", onPointerMove);
    els.editorOverlay.addEventListener("pointerup", onPointerUp);
    els.editorOverlay.addEventListener("pointercancel", onPointerUp);
    els.editorOverlay.addEventListener("dblclick", () => {
      const a = selectedAnn();
      if (a && a.type === "text") { els.insText.focus(); els.insText.select(); }
    });

    els.inspector.addEventListener("click", (e) => {
      const colorBtn = e.target.closest(".color-btn");
      if (colorBtn) {
        if (colorBtn.classList.contains("open")) closeColorPop();
        else openColorPop(colorBtn);
        return;
      }
      const act = e.target.closest("[data-act]");
      if (act) {
        const list = currentAnns();
        const a = selectedAnn();
        if (!a) return;
        pushHistory(null);
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
      if (flagBtn) {
        pushHistory(null);
        mutateSelected((a) => { a[flagBtn.dataset.flag] = !a[flagBtn.dataset.flag]; });
        return;
      }
      const alignBtn = e.target.closest(".chip[data-align]");
      if (alignBtn) {
        pushHistory(null);
        mutateSelected((a) => { a.align = alignBtn.dataset.align; });
      }
    });

    els.insText.addEventListener("input", () => {
      pushHistory("text");
      mutateSelected((a) => { a.text = els.insText.value; });
    });
    els.insFont.addEventListener("change", () => {
      pushHistory(null);
      mutateSelected((a) => { a.font = els.insFont.value; });
    });
    els.insSize.addEventListener("input", () => {
      pushHistory("size");
      mutateSelected((a) => { a.size = Number(els.insSize.value); });
    });
    els.insStrokeW.addEventListener("input", () => {
      pushHistory("strokeW");
      mutateSelected((a) => { a.strokeW = Number(els.insStrokeW.value); });
    });
    els.insRadius.addEventListener("input", () => {
      pushHistory("radius");
      mutateSelected((a) => { a.radius = Number(els.insRadius.value); });
    });
    els.insBgPad.addEventListener("input", () => {
      pushHistory("bgPad");
      mutateSelected((a) => { a.bgPad = Number(els.insBgPad.value) / 100; });
    });
    els.insBgRadius.addEventListener("input", () => {
      pushHistory("bgRadius");
      mutateSelected((a) => { a.bgRadius = Number(els.insBgRadius.value); });
    });
    els.insBgStrokeW.addEventListener("input", () => {
      pushHistory("bgStrokeW");
      mutateSelected((a) => { a.bgStrokeW = Number(els.insBgStrokeW.value); });
    });
    els.insRot.addEventListener("input", () => {
      pushHistory("rot");
      mutateSelected((a) => { a.rot = (Number(els.insRot.value) * Math.PI) / 180; });
    });
    els.insOpacity.addEventListener("input", () => {
      pushHistory("opacity");
      mutateSelected((a) => { a.opacity = Number(els.insOpacity.value) / 100; });
    });

    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (!selectedId || typing) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const list = currentAnns();
        const a = selectedAnn();
        if (a) {
          pushHistory(null);
          list.splice(list.indexOf(a), 1);
          selectedId = null;
          refreshEditor();
        }
      } else if (e.key === "Escape") {
        selectedId = null; armTool(null); closeColorPop(); refreshEditor();
      } else if (e.key.startsWith("Arrow")) {
        // Nudge with arrows; hold Shift for a bigger step.
        e.preventDefault();
        const step = (e.shiftKey ? 20 : 4) * overlayScale();
        pushHistory("nudge");
        mutateSelected((a) => moveAnn(
          a,
          e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
          e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0
        ));
      }
    });

    window.addEventListener("resize", () => drawOverlay());
    updateHistoryButtons();
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

  // ---------- file tools ----------
  // Everything here runs on-device: pdf-lib rearranges pages losslessly, and
  // pdf.js rasterizes when a tool genuinely has to (photos, compression).

  const toolEls = {
    modeSwitch: document.getElementById("mode-switch"),
    panelTools: document.getElementById("panel-tools"),
    panelWorkspace: document.getElementById("panel-workspace"),
    grid: document.getElementById("tools-grid"),
    runner: document.getElementById("tool-runner"),
    back: document.getElementById("tool-back"),
    title: document.getElementById("tool-title"),
    desc: document.getElementById("tool-desc"),
    dropzone: document.getElementById("tool-dropzone"),
    input: document.getElementById("tool-input"),
    dzTitle: document.getElementById("tool-dropzone-title"),
    dzSub: document.getElementById("tool-dropzone-sub"),
    fileList: document.getElementById("tool-files"),
    options: document.getElementById("tool-options"),
    run: document.getElementById("tool-run"),
    runLabel: document.getElementById("tool-run-label"),
    spinner: document.getElementById("tool-spinner"),
    progressTrack: document.getElementById("tool-progress-track"),
    progressFill: document.getElementById("tool-progress-fill"),
  };

  let activeTool = null;
  let toolFiles = [];
  let toolBusy = false;

  const ICONS = {
    merge: '<path d="M8 4h8M8 4v6a4 4 0 0 1-4 4M8 4a4 4 0 0 0 4 4h4"/><path d="M12 20v-6"/><path d="M9 17l3 3 3-3"/>',
    split: '<path d="M6 3v7a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v5"/><path d="M18 3v7a3 3 0 0 1-3 3H9a3 3 0 0 0-3 3v5"/>',
    rotate: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>',
    toPhoto: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M20 16l-5-5-6.5 8"/>',
    toPdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    zip: '<path d="M20 12V7a2 2 0 0 0-2-2h-4l-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"/><path d="M17 14v6"/><path d="M14 17l3 3 3-3"/>',
  };

  // "1-3, 5, 8-10" -> zero-based page indices, clamped and de-duplicated.
  function parseRange(text, total) {
    const out = [];
    const seen = new Set();
    for (const chunk of String(text || "").split(/[,;]/)) {
      const part = chunk.trim();
      if (!part) continue;
      const m = part.match(/^(\d+)\s*(?:[-–—]\s*(\d+))?$/);
      if (!m) continue;
      let a = parseInt(m[1], 10);
      let b = m[2] ? parseInt(m[2], 10) : a;
      if (a > b) { const t = a; a = b; b = t; }
      for (let i = a; i <= b; i++) {
        const idx = i - 1;
        if (idx >= 0 && idx < total && !seen.has(idx)) { seen.add(idx); out.push(idx); }
      }
    }
    return out;
  }

  async function loadPdf(file) {
    const bytes = await file.arrayBuffer();
    return PDFDocument.load(bytes, { ignoreEncryption: true });
  }

  async function pdfPageCount(file) {
    try { return (await loadPdf(file)).getPageCount(); } catch (err) { return 0; }
  }

  // Rasterize a PDF page-by-page via pdf.js; `scale` trades size against sharpness.
  async function rasterizePdf(file, scale, quality, onProgress) {
    const data = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const out = [];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.round(vp.width));
        canvas.height = Math.max(1, Math.round(vp.height));
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
        out.push({ blob, w: canvas.width, h: canvas.height });
        page.cleanup();
        onProgress && onProgress(i, doc.numPages);
      }
    } finally {
      canvas.width = canvas.height = 0;
      await doc.destroy().catch(() => {});
    }
    return out;
  }

  const TOOLS = [
    {
      id: "merge",
      title: "Об'єднати PDF",
      sub: "Кілька файлів — в один документ",
      icon: ICONS.merge,
      accept: ".pdf,application/pdf",
      multiple: true,
      dz: "Обери кілька PDF",
      dzSub: "Порядок сторінок = порядок, у якому ти обрала файли",
      minFiles: 2,
      runLabel: "Об'єднати",
      async run(files, opts, onProgress) {
        const out = await PDFDocument.create();
        for (let i = 0; i < files.length; i++) {
          const src = await loadPdf(files[i]);
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach((p) => out.addPage(p));
          onProgress(i + 1, files.length);
        }
        return { bytes: await out.save(), name: "обʼєднано.pdf", type: "application/pdf" };
      },
    },
    {
      id: "split",
      title: "Витягти сторінки",
      sub: "Зберегти лише потрібні сторінки",
      icon: ICONS.split,
      accept: ".pdf,application/pdf",
      dz: "Обери PDF",
      dzSub: "Далі вкажеш, які сторінки залишити",
      options: [{ key: "range", label: "Сторінки", type: "text", placeholder: "напр. 1-3, 5", value: "" }],
      runLabel: "Витягти",
      async run(files, opts, onProgress) {
        const src = await loadPdf(files[0]);
        const idx = parseRange(opts.range, src.getPageCount());
        if (!idx.length) throw new Error("empty-range");
        const out = await PDFDocument.create();
        const pages = await out.copyPages(src, idx);
        pages.forEach((p) => out.addPage(p));
        onProgress(1, 1);
        return { bytes: await out.save(), name: "сторінки.pdf", type: "application/pdf" };
      },
    },
    {
      id: "remove",
      title: "Видалити сторінки",
      sub: "Прибрати зайві сторінки з PDF",
      icon: ICONS.trash,
      accept: ".pdf,application/pdf",
      dz: "Обери PDF",
      dzSub: "Далі вкажеш, які сторінки прибрати",
      options: [{ key: "range", label: "Прибрати", type: "text", placeholder: "напр. 2, 7-9", value: "" }],
      runLabel: "Видалити",
      async run(files, opts, onProgress) {
        const src = await loadPdf(files[0]);
        const drop = new Set(parseRange(opts.range, src.getPageCount()));
        if (!drop.size) throw new Error("empty-range");
        const keep = src.getPageIndices().filter((i) => !drop.has(i));
        if (!keep.length) throw new Error("nothing-left");
        const out = await PDFDocument.create();
        const pages = await out.copyPages(src, keep);
        pages.forEach((p) => out.addPage(p));
        onProgress(1, 1);
        return { bytes: await out.save(), name: "без_зайвого.pdf", type: "application/pdf" };
      },
    },
    {
      id: "rotate",
      title: "Повернути сторінки",
      sub: "Виправити орієнтацію сканів",
      icon: ICONS.rotate,
      accept: ".pdf,application/pdf",
      dz: "Обери PDF",
      dzSub: "Можна повернути весь файл або окремі сторінки",
      options: [
        { key: "angle", label: "Кут", type: "select", value: "90",
          choices: [["90", "90° за годинниковою"], ["180", "180°"], ["270", "90° проти годинникової"]] },
        { key: "range", label: "Сторінки", type: "text", placeholder: "порожньо = усі", value: "" },
      ],
      runLabel: "Повернути",
      async run(files, opts, onProgress) {
        const doc = await loadPdf(files[0]);
        const total = doc.getPageCount();
        const idx = opts.range && opts.range.trim() ? parseRange(opts.range, total) : doc.getPageIndices();
        if (!idx.length) throw new Error("empty-range");
        const add = parseInt(opts.angle, 10);
        idx.forEach((i) => {
          const page = doc.getPage(i);
          page.setRotation(PDFLib.degrees((page.getRotation().angle + add) % 360));
        });
        onProgress(1, 1);
        return { bytes: await doc.save(), name: "повернуто.pdf", type: "application/pdf" };
      },
    },
    {
      id: "compress",
      title: "Стиснути PDF",
      sub: "Зменшити вагу важкого файлу",
      icon: ICONS.zip,
      accept: ".pdf,application/pdf",
      dz: "Обери PDF",
      dzSub: "Сторінки перезбираються як зображення — текст перестане виділятись",
      options: [
        { key: "level", label: "Стиснення", type: "select", value: "medium",
          choices: [["light", "Легке — якість краща"], ["medium", "Середнє"], ["strong", "Сильне — файл найменший"]] },
      ],
      runLabel: "Стиснути",
      async run(files, opts, onProgress) {
        const presets = { light: [1.6, 0.82], medium: [1.2, 0.68], strong: [0.9, 0.5] };
        const [scale, quality] = presets[opts.level] || presets.medium;
        const shots = await rasterizePdf(files[0], scale, quality, onProgress);
        const out = await PDFDocument.create();
        for (const s of shots) {
          const img = await out.embedJpg(await s.blob.arrayBuffer());
          const page = out.addPage([s.w, s.h]);
          page.drawImage(img, { x: 0, y: 0, width: s.w, height: s.h });
        }
        return { bytes: await out.save(), name: "стиснуто.pdf", type: "application/pdf" };
      },
    },
    {
      id: "pdf2img",
      title: "PDF → фото",
      sub: "Кожна сторінка окремим JPG",
      icon: ICONS.toPhoto,
      accept: ".pdf,application/pdf",
      dz: "Обери PDF",
      dzSub: "Отримаєш ZIP із фото, по одному на сторінку",
      options: [
        { key: "quality", label: "Якість", type: "select", value: "2",
          choices: [["1.4", "Звичайна"], ["2", "Висока"], ["3", "Максимальна"]] },
      ],
      runLabel: "Перетворити",
      async run(files, opts, onProgress) {
        const shots = await rasterizePdf(files[0], Number(opts.quality), 0.92, onProgress);
        const zip = await getJSZip();
        const base = sanitizeName(files[0].name);
        shots.forEach((s, i) => zip.file(`${base}_${i + 1}.jpg`, s.blob));
        const blob = await zip.generateAsync({ type: "blob" });
        return { blob, name: base + "_фото.zip", type: "application/zip" };
      },
    },
    {
      id: "img2pdf",
      title: "Фото → PDF",
      sub: "Зібрати знімки в один документ",
      icon: ICONS.toPdf,
      accept: "image/jpeg,image/png,.jpg,.jpeg,.png",
      multiple: true,
      dz: "Обери фото",
      dzSub: "JPG або PNG · порядок = порядок вибору",
      options: [
        { key: "size", label: "Сторінка", type: "select", value: "fit",
          choices: [["fit", "Під розмір фото"], ["a4", "A4 з полями"]] },
      ],
      runLabel: "Зібрати PDF",
      async run(files, opts, onProgress) {
        const out = await PDFDocument.create();
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const bytes = await f.arrayBuffer();
          const isPng = /png$/i.test(f.type) || /\.png$/i.test(f.name);
          const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
          if (opts.size === "a4") {
            const [pw, ph] = [595.28, 841.89];
            const page = out.addPage([pw, ph]);
            const m = 28;
            const s = Math.min((pw - m * 2) / img.width, (ph - m * 2) / img.height);
            const w = img.width * s, h = img.height * s;
            page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
          } else {
            const page = out.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
          }
          onProgress(i + 1, files.length);
        }
        return { bytes: await out.save(), name: "фото.pdf", type: "application/pdf" };
      },
    },
  ];

  function renderToolsGrid() {
    toolEls.grid.innerHTML = "";
    TOOLS.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool-card";
      b.innerHTML =
        '<span class="tool-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round">' + t.icon + "</svg></span>" +
        "<strong></strong><span class='tool-sub'></span>";
      b.querySelector("strong").textContent = t.title;
      b.querySelector(".tool-sub").textContent = t.sub;
      b.addEventListener("click", () => openTool(t));
      toolEls.grid.appendChild(b);
    });
  }

  function openTool(tool) {
    activeTool = tool;
    toolFiles = [];
    toolEls.grid.classList.add("hidden");
    toolEls.runner.classList.remove("hidden");
    toolEls.title.textContent = tool.title;
    toolEls.desc.textContent = tool.sub;
    toolEls.dzTitle.textContent = tool.dz || "Обрати файл";
    toolEls.dzSub.textContent = tool.dzSub || "";
    toolEls.input.value = "";
    toolEls.input.accept = tool.accept || "";
    toolEls.input.multiple = !!tool.multiple;
    toolEls.runLabel.textContent = tool.runLabel || "Зробити";

    toolEls.options.innerHTML = "";
    (tool.options || []).forEach((opt) => {
      const row = document.createElement("div");
      row.className = "tool-field";
      const lab = document.createElement("label");
      lab.textContent = opt.label;
      lab.htmlFor = "toolopt-" + opt.key;
      let field;
      if (opt.type === "select") {
        field = document.createElement("select");
        opt.choices.forEach(([v, text]) => {
          const o = document.createElement("option");
          o.value = v; o.textContent = text;
          field.appendChild(o);
        });
      } else {
        field = document.createElement("input");
        field.type = "text";
        field.placeholder = opt.placeholder || "";
      }
      field.id = "toolopt-" + opt.key;
      field.dataset.key = opt.key;
      field.value = opt.value == null ? "" : opt.value;
      row.appendChild(lab);
      row.appendChild(field);
      toolEls.options.appendChild(row);
    });

    renderToolFiles();
  }

  function closeTool() {
    activeTool = null;
    toolFiles = [];
    toolEls.runner.classList.add("hidden");
    toolEls.grid.classList.remove("hidden");
  }

  function renderToolFiles() {
    toolEls.fileList.innerHTML = "";
    toolFiles.forEach((f, i) => {
      const li = document.createElement("li");
      li.className = "job-card";
      const info = document.createElement("div");
      info.className = "job-info";
      const name = document.createElement("span");
      name.className = "job-name";
      name.style.border = "none";
      name.style.background = "transparent";
      name.textContent = f.name;
      const meta = document.createElement("span");
      meta.className = "job-meta";
      meta.textContent = (f.size / 1024 / 1024).toFixed(2) + " МБ" + (f.pageCount ? ` · ${f.pageCount} стор.` : "");
      info.appendChild(name);
      info.appendChild(meta);
      const rm = document.createElement("button");
      rm.className = "job-remove";
      rm.type = "button";
      rm.setAttribute("aria-label", "Прибрати файл");
      rm.textContent = "✕";
      rm.addEventListener("click", () => { toolFiles.splice(i, 1); renderToolFiles(); });
      li.appendChild(info);
      li.appendChild(rm);
      toolEls.fileList.appendChild(li);
    });
    const need = activeTool ? (activeTool.minFiles || 1) : 1;
    toolEls.run.disabled = toolBusy || toolFiles.length < need;
    toolEls.dzTitle.textContent = toolFiles.length
      ? (activeTool && activeTool.multiple ? "Додати ще" : "Обрати інший файл")
      : (activeTool ? activeTool.dz : "Обрати файл");
  }

  async function addToolFiles(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    if (activeTool && activeTool.multiple) toolFiles.push(...files);
    else toolFiles = [files[0]];
    // Page counts make it obvious which file you're about to operate on.
    for (const f of toolFiles) {
      if (f.pageCount == null && /pdf$/i.test(f.type + f.name)) {
        f.pageCount = await pdfPageCount(f);
      }
    }
    renderToolFiles();
  }

  function setToolBusy(on) {
    toolBusy = on;
    toolEls.spinner.classList.toggle("hidden", !on);
    toolEls.progressTrack.classList.toggle("hidden", !on);
    toolEls.run.disabled = on || toolFiles.length < (activeTool && activeTool.minFiles || 1);
    if (!on) {
      toolEls.progressFill.style.width = "0%";
      toolEls.runLabel.textContent = activeTool ? (activeTool.runLabel || "Зробити") : "Зробити";
    }
  }

  function readToolOptions() {
    const opts = {};
    toolEls.options.querySelectorAll("[data-key]").forEach((el) => { opts[el.dataset.key] = el.value; });
    return opts;
  }

  async function runTool() {
    if (!activeTool || toolBusy) return;
    setToolBusy(true);
    try {
      const onProgress = (done, total) => {
        toolEls.progressFill.style.width = Math.round((done / total) * 100) + "%";
        toolEls.runLabel.textContent = total > 1 ? `Обробка… ${done}/${total}` : "Обробка…";
      };
      const res = await activeTool.run(toolFiles, readToolOptions(), onProgress);
      const blob = res.blob || new Blob([res.bytes], { type: res.type });
      const outcome = await deliverBlob(blob, res.name, res.type);
      if (outcome !== "cancelled") {
        await saveHistoryEntry({
          name: res.name, format: res.type === "application/zip" ? "pdf-zip" : "pdf",
          pageCount: 0, blob, blobName: res.name, thumbSource: null,
        });
        showToast("Готово — файл збережено", "success");
        celebrate(toolEls.run);
      }
    } catch (err) {
      const known = {
        "empty-range": "Вкажи сторінки, напр. 1-3, 5",
        "nothing-left": "Не можна видалити всі сторінки",
      };
      const msg = err && known[err.message];
      // Only real failures are worth a console entry; bad input is just input.
      if (!msg) console.error(err);
      showToast(msg || "Не вдалося обробити файл — можливо, він пошкоджений або захищений паролем", "error", 4200);
    } finally {
      setToolBusy(false);
    }
  }

  function setMode(mode) {
    const tools = mode === "tools";
    toolEls.panelTools.classList.toggle("hidden", !tools);
    toolEls.panelWorkspace.classList.toggle("hidden", tools);
    els.panelHistory.classList.add("hidden");
    [...toolEls.modeSwitch.children].forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    if (tools) closeColorPop();
  }

  function initTools() {
    renderToolsGrid();
    toolEls.modeSwitch.addEventListener("click", (e) => {
      const btn = e.target.closest(".mode-btn");
      if (btn) setMode(btn.dataset.mode);
    });
    toolEls.back.addEventListener("click", closeTool);
    toolEls.input.addEventListener("change", () => addToolFiles(toolEls.input.files));
    toolEls.run.addEventListener("click", runTool);

    ["dragenter", "dragover"].forEach((ev) => toolEls.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      toolEls.dropzone.classList.add("dragover");
    }));
    ["dragleave", "drop"].forEach((ev) => toolEls.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      toolEls.dropzone.classList.remove("dragover");
      if (ev === "drop" && e.dataTransfer) addToolFiles(e.dataTransfer.files);
    }));
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
      // Tool results (a merged PDF, a ZIP) have no page image to thumbnail.
      const thumb = thumbSource ? await makeThumbDataUrl(thumbSource, 120) : null;
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
    const pages = entry.pageCount ? `${entry.pageCount} стор. · ` : "";
    return `${dateStr} · ${pages}${kind}`;
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
      if (entry.thumb) img.src = entry.thumb;
      else img.classList.add("history-thumb-empty");

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
  initTools();

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
