/* GlaMaterials — накладання водяного знаку GlamEng на PDF/фото.
   Все виконується локально в браузері: файли не завантажуються нікуди. */

(function () {
  "use strict";

  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  const { PDFDocument } = PDFLib;

  // A4 at 200dpi — good text legibility, sane file size for ~20 pages.
  const TARGET_W = 1654;
  const TARGET_H = 2339;
  const A4_PT_W = 595.28;
  const A4_PT_H = 841.89;
  const MAX_PAGES = 60;
  const JPEG_QUALITY = 0.92;
  const DEFAULT_OPACITY = 15;

  const els = {
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("file-input"),
    panelDrop: document.getElementById("panel-drop"),
    panelWorking: document.getElementById("panel-working"),
    panelResult: document.getElementById("panel-result"),
    panelError: document.getElementById("panel-error"),
    workingLabel: document.getElementById("working-label"),
    progressFill: document.getElementById("progress-fill"),
    previewCanvas: document.getElementById("preview-canvas"),
    pageCountBadge: document.getElementById("page-count-badge"),
    opacitySlider: document.getElementById("opacity-slider"),
    opacityValue: document.getElementById("opacity-value"),
    downloadBtn: document.getElementById("download-btn"),
    resetBtn: document.getElementById("reset-btn"),
    errorText: document.getElementById("error-text"),
    errorResetBtn: document.getElementById("error-reset-btn"),
  };

  let watermarkImg = null;      // decoded <img> of the watermark
  let baseCanvases = [];        // A4-sized canvases, content only, no watermark yet
  let sourceFileName = "";
  let previewRAF = null;

  function loadWatermarkImage() {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("watermark-load-failed"));
      img.src = WATERMARK_DATA_URI;
    });
  }

  function showPanel(name) {
    for (const p of [els.panelDrop, els.panelWorking, els.panelResult, els.panelError]) {
      p.classList.add("hidden");
    }
    ({
      drop: els.panelDrop,
      working: els.panelWorking,
      result: els.panelResult,
      error: els.panelError,
    })[name].classList.remove("hidden");
  }

  function setProgress(fraction, label) {
    els.progressFill.style.width = Math.round(fraction * 100) + "%";
    if (label) els.workingLabel.textContent = label;
  }

  function showError(message) {
    els.errorText.textContent = message;
    showPanel("error");
  }

  // --- Rendering source pages onto A4 base canvases (contain-fit + white padding) ---

  function makeA4Canvas() {
    const canvas = document.createElement("canvas");
    canvas.width = TARGET_W;
    canvas.height = TARGET_H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, TARGET_W, TARGET_H);
    return { canvas, ctx };
  }

  function drawContained(ctx, drawable, srcW, srcH) {
    const scale = Math.min(TARGET_W / srcW, TARGET_H / srcH);
    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);
    const dx = Math.round((TARGET_W - w) / 2);
    const dy = Math.round((TARGET_H - h) / 2);
    ctx.drawImage(drawable, dx, dy, w, h);
  }

  async function renderPdfFile(file, onPage) {
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const scale = Math.min(TARGET_W / viewport.width, TARGET_H / viewport.height);
      const renderViewport = page.getViewport({ scale });
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = Math.round(renderViewport.width);
      pageCanvas.height = Math.round(renderViewport.height);
      const pageCtx = pageCanvas.getContext("2d");
      await page.render({ canvasContext: pageCtx, viewport: renderViewport }).promise;

      const { canvas, ctx } = makeA4Canvas();
      const dx = Math.round((TARGET_W - pageCanvas.width) / 2);
      const dy = Math.round((TARGET_H - pageCanvas.height) / 2);
      ctx.drawImage(pageCanvas, dx, dy);
      onPage(canvas);
    }
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image-load-failed")); };
      img.src = url;
    });
  }

  async function renderImageFile(file, onPage) {
    const img = await loadImageFile(file);
    const { canvas, ctx } = makeA4Canvas();
    drawContained(ctx, img, img.naturalWidth, img.naturalHeight);
    onPage(canvas);
  }

  function isPdf(file) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  }

  function isSupportedImage(file) {
    return /^image\/(jpeg|png|webp)$/.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
  }

  async function processFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;

    const unsupported = files.filter((f) => !isPdf(f) && !isSupportedImage(f));
    if (unsupported.length) {
      showError("Непідтримуваний формат файлу: " + unsupported.map((f) => f.name).join(", ") + "\nПідтримуються PDF, JPG, PNG, WEBP.");
      return;
    }

    showPanel("working");
    setProgress(0, "Підготовка…");

    baseCanvases = [];
    sourceFileName = files[0].name.replace(/\.[^.]+$/, "");

    try {
      if (!watermarkImg) watermarkImg = await loadWatermarkImage();

      let fileIndex = 0;
      for (const file of files) {
        fileIndex++;
        setProgress(
          baseCanvases.length / Math.max(baseCanvases.length + 1, MAX_PAGES * 0.2),
          `Обробка файлу ${fileIndex}/${files.length}: ${file.name}`
        );
        if (isPdf(file)) {
          await renderPdfFile(file, (canvas) => {
            baseCanvases.push(canvas);
            setProgress(Math.min(baseCanvases.length / 20, 0.95), `Оброблено сторінок: ${baseCanvases.length}`);
          });
        } else {
          await renderImageFile(file, (canvas) => {
            baseCanvases.push(canvas);
            setProgress(Math.min(baseCanvases.length / 20, 0.95), `Оброблено сторінок: ${baseCanvases.length}`);
          });
        }
        if (baseCanvases.length > MAX_PAGES) {
          showError(`Забагато сторінок (>${MAX_PAGES}). Розбийте файл на менші частини.`);
          return;
        }
      }

      if (!baseCanvases.length) {
        showError("Не вдалося знайти жодної сторінки у файлі.");
        return;
      }

      setProgress(1, "Готово");
      els.pageCountBadge.textContent = baseCanvases.length + (baseCanvases.length === 1 ? " стор." : " стор.");
      showPanel("result");
      updatePreview();
    } catch (err) {
      console.error(err);
      showError("Не вдалося обробити файл. Перевірте, що це коректний PDF або зображення, і спробуйте ще раз.");
    }
  }

  // --- Watermark compositing ---

  function compositeOntoCanvas(baseCanvas, opacityFraction, targetCanvas) {
    targetCanvas.width = TARGET_W;
    targetCanvas.height = TARGET_H;
    const ctx = targetCanvas.getContext("2d");
    ctx.globalAlpha = 1;
    ctx.drawImage(baseCanvas, 0, 0);
    ctx.globalAlpha = opacityFraction;
    ctx.drawImage(watermarkImg, 0, 0, TARGET_W, TARGET_H);
    ctx.globalAlpha = 1;
    return targetCanvas;
  }

  function currentOpacityFraction() {
    return Number(els.opacitySlider.value) / 100;
  }

  function updatePreview() {
    if (!baseCanvases.length) return;
    if (previewRAF) cancelAnimationFrame(previewRAF);
    previewRAF = requestAnimationFrame(() => {
      compositeOntoCanvas(baseCanvases[0], currentOpacityFraction(), els.previewCanvas);
    });
  }

  // --- Export ---

  async function exportPdf() {
    showPanel("working");
    setProgress(0, "Формування PDF…");
    try {
      const pdfDoc = await PDFDocument.create();
      const opacity = currentOpacityFraction();
      const workCanvas = document.createElement("canvas");

      for (let i = 0; i < baseCanvases.length; i++) {
        compositeOntoCanvas(baseCanvases[i], opacity, workCanvas);
        const blob = await new Promise((res) => workCanvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
        const bytes = await blob.arrayBuffer();
        const jpg = await pdfDoc.embedJpg(bytes);
        const page = pdfDoc.addPage([A4_PT_W, A4_PT_H]);
        page.drawImage(jpg, { x: 0, y: 0, width: A4_PT_W, height: A4_PT_H });
        setProgress((i + 1) / baseCanvases.length, `Сторінка ${i + 1}/${baseCanvases.length}`);
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (sourceFileName || "glamaterials") + "_glameng.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      showPanel("result");
    } catch (err) {
      console.error(err);
      showError("Не вдалося сформувати PDF. Спробуйте ще раз.");
    }
  }

  function resetAll() {
    baseCanvases = [];
    sourceFileName = "";
    els.fileInput.value = "";
    els.opacitySlider.value = String(DEFAULT_OPACITY);
    els.opacityValue.textContent = DEFAULT_OPACITY + "%";
    showPanel("drop");
  }

  // --- Wiring ---

  els.fileInput.addEventListener("change", (e) => processFiles(e.target.files));

  els.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragover");
  });
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragover"));
  els.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragover");
    if (e.dataTransfer && e.dataTransfer.files.length) processFiles(e.dataTransfer.files);
  });

  // Prevent the browser from navigating away if a file is dropped outside the zone.
  ["dragover", "drop"].forEach((evt) => {
    window.addEventListener(evt, (e) => {
      if (e.target !== els.dropzone && !els.dropzone.contains(e.target)) e.preventDefault();
    });
  });

  els.opacitySlider.addEventListener("input", () => {
    els.opacityValue.textContent = els.opacitySlider.value + "%";
    updatePreview();
  });

  els.downloadBtn.addEventListener("click", exportPdf);
  els.resetBtn.addEventListener("click", resetAll);
  els.errorResetBtn.addEventListener("click", resetAll);

  els.opacityValue.textContent = DEFAULT_OPACITY + "%";
})();
