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
      window: { x: 291, y: 216, w: 1397, h: 961 },
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
    renderJobList();
    updateDropzoneMode();
    updateSettingsVisibility();
    updatePreview();
  }

  function resetQueue() {
    jobs = [];
    pendingQueue.length = 0;
    previewIndex = 0;
    renderJobList();
    updateDropzoneMode();
    updateSettingsVisibility();
    updatePreview();
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
      const nameEl = document.createElement("span");
      nameEl.className = "job-name";
      nameEl.textContent = job.name;
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
  function allReadyPageRefs() {
    const refs = [];
    for (const job of readyJobs()) {
      job.pages.forEach((blob) => refs.push(blob));
    }
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
    updatePreview();
  }

  function updatePreview() {
    const refs = allReadyPageRefs();
    if (!refs.length) {
      const ctx = els.previewCanvas.getContext("2d");
      ctx.clearRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
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
      const blob = refs[previewIndex];
      const bitmap = await createImageBitmap(blob);
      previewWorkCanvas.width = t.canvasW;
      previewWorkCanvas.height = t.canvasH;
      const ctx = previewWorkCanvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      ctx.globalAlpha = t.overlayOpacity ? currentOpacityFraction() : 1;
      ctx.drawImage(overlayImg(), 0, 0, t.canvasW, t.canvasH);
      ctx.globalAlpha = 1;

      els.previewCanvas.width = t.canvasW;
      els.previewCanvas.height = t.canvasH;
      els.previewCanvas.style.opacity = "0";
      els.previewCanvas.getContext("2d").drawImage(previewWorkCanvas, 0, 0);
      requestAnimationFrame(() => { els.previewCanvas.style.opacity = "1"; });
    });
  }

  // ---------- export ----------

  async function compositePageToJpegBlob(pageBlob, opacity) {
    const t = tpl();
    const bitmap = await createImageBitmap(pageBlob);
    exportWorkCanvas.width = t.canvasW;
    exportWorkCanvas.height = t.canvasH;
    const ctx = exportWorkCanvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    ctx.globalAlpha = t.overlayOpacity ? opacity : 1;
    ctx.drawImage(overlayImg(), 0, 0, t.canvasW, t.canvasH);
    ctx.globalAlpha = 1;
    return canvasToJpegBlob(exportWorkCanvas);
  }

  async function buildPdfFromPages(pageBlobs, opacity, onProgress) {
    const t = tpl();
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < pageBlobs.length; i++) {
      const outBlob = await compositePageToJpegBlob(pageBlobs[i], opacity);
      const bytes = await outBlob.arrayBuffer();
      const jpg = await pdfDoc.embedJpg(bytes);
      const page = pdfDoc.addPage([t.pdfPtW, t.pdfPtH]);
      page.drawImage(jpg, { x: 0, y: 0, width: t.pdfPtW, height: t.pdfPtH });
      onProgress && onProgress(i + 1, pageBlobs.length);
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
          const allPages = ready.flatMap((j) => j.pages);
          const pdfBytes = await buildPdfFromPages(allPages, opacity, updateExportProgress);
          const blob = new Blob([pdfBytes], { type: "application/pdf" });
          const filename = (ready[0].baseName || "glamaterials") + "_glameng.pdf";
          const outcome = await deliverBlob(blob, filename, "application/pdf");
          cancelled = outcome === "cancelled";
          if (!cancelled) {
            await saveHistoryEntry({ name: filename, format: "pdf", pageCount: allPages.length, blob, blobName: filename, thumbSource: allPages[0] });
          }
        } else {
          const zip = await getJSZip();
          let done = 0;
          const total = totalPagesOf(ready);
          for (const job of ready) {
            const pdfBytes = await buildPdfFromPages(job.pages, opacity, (d) => {
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
          for (let p = 0; p < job.pages.length; p++) {
            const outBlob = await compositePageToJpegBlob(job.pages[p], opacity);
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
    activeTemplate = btn.dataset.value;
    [...els.templateToggle.children].forEach((b) => b.classList.toggle("active", b === btn));

    outputFormat = activeTemplate === "frame" ? "photos" : "pdf";
    [...els.formatToggle.children].forEach((b) => b.classList.toggle("active", b.dataset.value === outputFormat));

    resetQueue();
    updateDropzoneHint();
    if (hadJobs) showToast("Чергу очищено — новий шаблон", "success");
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
