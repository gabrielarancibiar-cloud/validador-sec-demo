(() => {
  "use strict";

  const CORE = window.PriceChangeCore;
  const $ = (id) => document.getElementById(id);
  const REVIEW_STORAGE_KEY = "valepac_price_change_reviews_v1";
  const state = {
    sourceFile: null,
    sales: [],
    analysis: null,
    filteredChanges: [],
    reviewed: readReviewed()
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindEvents();
    renderEmpty();
  }

  function bindEvents() {
    $("salesFile").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) loadCsv(file);
    });
    $("analyzeBtn").addEventListener("click", analyze);
    $("exportBtn").addEventListener("click", exportResults);
    $("clearFiltersBtn").addEventListener("click", clearFilters);

    ["directionFilter", "productFilter", "validationFilter", "dateFrom", "dateTo"].forEach((id) => {
      $(id).addEventListener("change", renderResults);
    });
    $("searchFilter").addEventListener("input", renderResults);

    const dropzone = $("dropzone");
    dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        $("salesFile").click();
      }
    });
    ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    }));
    ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
    }));
    dropzone.addEventListener("drop", (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) loadCsv(file);
    });

    $("resultRows").addEventListener("click", (event) => {
      const button = event.target.closest("[data-review-key]");
      if (!button) return;
      toggleReviewed(button.dataset.reviewKey);
    });
  }

  function loadCsv(file) {
    if (!window.Papa) {
      showMessage("No fue posible cargar el lector de CSV. Revisa la conexión a internet y vuelve a intentar.", "error");
      return;
    }
    if (!/\.csv$/i.test(file.name)) {
      showMessage("Selecciona un archivo con extensión .csv.", "error");
      return;
    }

    state.sourceFile = file;
    state.sales = [];
    state.analysis = null;
    state.filteredChanges = [];
    $("fileName").textContent = `${file.name} · ${formatFileSize(file.size)}`;
    $("dropzone").classList.add("has-file");
    $("analyzeBtn").disabled = true;
    $("exportBtn").disabled = true;
    setStatus("neutral", "Procesando CSV");
    setProgress(2, "Leyendo encabezados y ventas...");
    showMessage("", "");

    let rowsRead = 0;
    let gasolineRows = 0;
    let parseErrors = 0;

    Papa.parse(file, {
      header: true,
      delimiter: ";",
      skipEmptyLines: "greedy",
      worker: true,
      transformHeader: (header) => CORE.normalizeText(header),
      step: (result) => {
        rowsRead += 1;
        parseErrors += result.errors?.length || 0;
        const sale = CORE.rowToSale(result.data || {}, rowsRead + 1);
        if (sale) {
          gasolineRows += 1;
          state.sales.push(sale);
        }
        if (rowsRead % 1000 === 0) {
          const progress = result.meta?.cursor && file.size
            ? Math.min(92, Math.max(4, (result.meta.cursor / file.size) * 92))
            : Math.min(92, 4 + rowsRead / 600);
          setProgress(progress, `Procesando ${rowsRead.toLocaleString("es-CL")} filas...`);
        }
      },
      complete: () => {
        setProgress(100, "Archivo procesado.");
        window.setTimeout(hideProgress, 350);
        if (!state.sales.length) {
          setStatus("danger", "Sin ventas de gasolina");
          showMessage("No se encontraron ventas de Gasolina 93, 95 o 97 en el archivo.", "error");
          return;
        }
        $("analyzeBtn").disabled = false;
        setStatus("success", `${gasolineRows.toLocaleString("es-CL")} ventas encontradas`);
        const errorText = parseErrors
          ? ` El lector informó ${parseErrors.toLocaleString("es-CL")} advertencias de formato.`
          : "";
        showMessage(
          `Archivo listo: ${rowsRead.toLocaleString("es-CL")} filas leídas y ${gasolineRows.toLocaleString("es-CL")} ventas de gasolina encontradas.${errorText}`,
          parseErrors ? "warning" : "success"
        );
        analyze();
      },
      error: (error) => {
        hideProgress();
        setStatus("danger", "Error de lectura");
        showMessage(`No fue posible leer el CSV: ${escapeHtml(error?.message || String(error))}`, "error");
      }
    });
  }

  function getOptions() {
    return {
      minVariation: Number($("minVariation").value),
      maxVariation: Number($("maxVariation").value),
      maxGapMinutes: Number($("maxGap").value),
      confirmationTolerance: Number($("confirmationTolerance").value),
      confirmationLookAhead: 4,
      confirmationMinimum: 2,
      confirmationWindowMinutes: Number($("maxGap").value),
      eventWindowMinutes: 45,
      minValidPrice: 500,
      maxValidPrice: 4000
    };
  }

  function analyze() {
    if (!state.sales.length) return;
    const options = getOptions();
    if (!Number.isFinite(options.minVariation) || !Number.isFinite(options.maxVariation) || options.minVariation < 0) {
      showMessage("Revisa los valores mínimo y máximo de la variación.", "error");
      return;
    }
    if (options.minVariation > options.maxVariation) {
      showMessage("La variación mínima no puede ser mayor que la variación máxima.", "error");
      return;
    }

    state.analysis = CORE.analyzeSales(state.sales, options);
    renderKpis();
    renderEvents();
    renderResults();
    $("exportBtn").disabled = state.analysis.changes.length === 0;
    setStatus(
      state.analysis.changes.length ? "success" : "warning",
      `${state.analysis.changes.length.toLocaleString("es-CL")} cambios detectados`
    );

    const invalid = state.analysis.invalidPrice.length;
    showMessage(
      `Análisis actualizado con una variación entre $${formatNumber(options.minVariation)} y $${formatNumber(options.maxVariation)}, en un máximo de ${formatMinutes(options.maxGapMinutes)}.` +
      (invalid ? ` Se excluyeron ${invalid.toLocaleString("es-CL")} ventas con precio cero o fuera de rango.` : ""),
      invalid ? "warning" : "success"
    );
  }

  function renderEmpty() {
    ["kpiSales", "kpiChanges", "kpiDown", "kpiUp", "kpiConsistent", "kpiReview"].forEach((id) => {
      $(id).textContent = "—";
    });
    $("kpiPeriod").textContent = "Sin archivo";
    $("kpiEvents").textContent = "— eventos agrupados";
  }

  function renderKpis() {
    const summary = state.analysis.summary;
    $("kpiSales").textContent = summary.validSales.toLocaleString("es-CL");
    $("kpiChanges").textContent = summary.changes.toLocaleString("es-CL");
    $("kpiDown").textContent = summary.down.toLocaleString("es-CL");
    $("kpiUp").textContent = summary.up.toLocaleString("es-CL");
    $("kpiConsistent").textContent = summary.consistent.toLocaleString("es-CL");
    $("kpiReview").textContent = summary.review.toLocaleString("es-CL");
    $("kpiEvents").textContent = `${summary.eventCount.toLocaleString("es-CL")} eventos agrupados`;
    $("kpiPeriod").textContent = summary.dateFrom && summary.dateTo
      ? `${formatDate(summary.dateFrom)} al ${formatDate(summary.dateTo)}`
      : "Sin periodo";
  }

  function renderEvents() {
    const container = $("eventList");
    const events = state.analysis?.events || [];
    if (!events.length) {
      container.innerHTML = '<div class="vp-empty-panel">No se detectaron eventos con los parámetros actuales.</div>';
      return;
    }

    container.innerHTML = events.map((event) => {
      const direction = event.down && event.up ? "mixed" : event.down ? "down" : "up";
      const dateLabel = sameDay(event.start, event.end)
        ? `${formatDate(event.start)} · ${formatTime(event.start)} a ${formatTime(event.end)}`
        : `${formatDateTime(event.start)} a ${formatDateTime(event.end)}`;
      return `
        <article class="vp-event vp-event--${direction}">
          <div class="vp-event-head">
            <div>
              <h3>${escapeHtml(event.products.join(" · "))}</h3>
              <p>${dateLabel}</p>
            </div>
            <span class="vp-event-count">${event.changes.length} detecciones</span>
          </div>
          <div class="vp-event-stats">
            ${event.down ? `<span class="vp-event-chip vp-event-chip--down">${event.down} bajas</span>` : ""}
            ${event.up ? `<span class="vp-event-chip vp-event-chip--up">${event.up} subidas</span>` : ""}
            <span class="vp-event-chip">${event.consistent} consistentes</span>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderResults() {
    const rows = $("resultRows");
    if (!state.analysis) {
      rows.innerHTML = '<tr><td colspan="14" class="vp-empty">Carga un CSV para comenzar.</td></tr>';
      $("resultCount").textContent = "Sin resultados.";
      return;
    }

    const direction = $("directionFilter").value;
    const product = $("productFilter").value;
    const validation = $("validationFilter").value;
    const dateFrom = $("dateFrom").value;
    const dateTo = $("dateTo").value;
    const search = CORE.normalizeText($("searchFilter").value);

    state.filteredChanges = state.analysis.changes.filter((change) => {
      if (direction !== "all" && change.direction !== direction) return false;
      if (product !== "all" && change.product !== product) return false;
      if (validation === "consistent" && change.validation !== "consistent") return false;
      if (validation === "review" && change.validation === "consistent") return false;
      if (validation === "insufficient" && change.validation !== "insufficient") return false;
      const key = toDateKey(change.current.timestamp);
      if (dateFrom && key < dateFrom) return false;
      if (dateTo && key > dateTo) return false;
      if (search) {
        const haystack = CORE.normalizeText([
          change.current.attendant,
          change.current.pos,
          change.current.pump,
          change.current.transactionCode,
          change.current.transactionId,
          change.current.paymentMethod
        ].join(" "));
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    $("resultCount").textContent = `${state.filteredChanges.length.toLocaleString("es-CL")} de ${state.analysis.changes.length.toLocaleString("es-CL")} detecciones visibles.`;
    if (!state.filteredChanges.length) {
      rows.innerHTML = '<tr><td colspan="14" class="vp-empty">No hay detecciones para los filtros seleccionados.</td></tr>';
      return;
    }

    rows.innerHTML = state.filteredChanges.map((change) => {
      const isReviewed = Boolean(state.reviewed[change.key]);
      const validation = validationLabel(change);
      const transaction = change.current.transactionCode || change.current.transactionId || `Fila ${change.current.rowNumber}`;
      const shortTransaction = transaction.length > 18 ? `…${transaction.slice(-18)}` : transaction;
      const discount = sumFinite(change.current.discount, change.current.paymentDiscount);
      return `
        <tr>
          <td><span class="vp-status vp-status--${change.direction}">${change.direction === "down" ? "Baja" : "Subida"}</span></td>
          <td><span class="vp-status vp-status--${change.validation}">${validation}</span></td>
          <td><strong>${escapeHtml(change.product)}</strong></td>
          <td>${formatDateTime(change.current.timestamp)}</td>
          <td class="vp-money">${formatMoney(change.previousPrice)}</td>
          <td class="vp-money">${formatMoney(change.currentPrice)}</td>
          <td class="vp-money vp-delta--${change.direction}">${formatSignedMoney(change.delta)}</td>
          <td class="vp-align-right">${formatGap(change.gapMinutes)}</td>
          <td>${escapeHtml(change.current.attendant || "—")}</td>
          <td>${escapeHtml(change.current.pos || change.current.pump || "—")}</td>
          <td>${escapeHtml(change.current.paymentMethod || "—")}</td>
          <td class="vp-money">${formatMoney(discount)}</td>
          <td title="${escapeHtml(transaction)}">${escapeHtml(shortTransaction)}</td>
          <td><button class="vp-review-btn${isReviewed ? " is-reviewed" : ""}" type="button" data-review-key="${escapeHtml(change.key)}">${isReviewed ? "✓ Revisado" : "Marcar revisado"}</button></td>
        </tr>
      `;
    }).join("");
  }

  function validationLabel(change) {
    if (change.validation === "consistent") return `Consistente (${change.supportingSales})`;
    if (change.validation === "insufficient") return "Sin muestra";
    return "A revisar";
  }

  function clearFilters() {
    $("directionFilter").value = "all";
    $("productFilter").value = "all";
    $("validationFilter").value = "all";
    $("dateFrom").value = "";
    $("dateTo").value = "";
    $("searchFilter").value = "";
    renderResults();
  }

  function toggleReviewed(key) {
    if (state.reviewed[key]) delete state.reviewed[key];
    else state.reviewed[key] = new Date().toISOString();
    try {
      localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(state.reviewed));
    } catch (_) {
      showToast("No fue posible guardar la revisión en este navegador.", true);
    }
    renderResults();
  }

  function readReviewed() {
    try {
      return JSON.parse(localStorage.getItem(REVIEW_STORAGE_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function exportResults() {
    if (!state.analysis || !window.XLSX) {
      showToast("No fue posible cargar el exportador de Excel.", true);
      return;
    }
    const changes = state.filteredChanges.length ? state.filteredChanges : state.analysis.changes;
    const detail = changes.map((change) => ({
      "Dirección": change.direction === "down" ? "Baja" : "Subida",
      "Validación": validationLabel(change),
      "Producto": change.product,
      "Fecha y hora": formatDateTime(change.current.timestamp),
      "Precio anterior": change.previousPrice,
      "Precio actual": change.currentPrice,
      "Variación": change.delta,
      "Minutos desde venta anterior": round(change.gapMinutes, 1),
      "Atendedor": change.current.attendant,
      "POS": change.current.pos || change.current.pump,
      "Forma de pago": change.current.paymentMethod,
      "Descuento venta": finiteOrZero(change.current.discount),
      "Descuento pago": finiteOrZero(change.current.paymentDiscount),
      "Transacción": change.current.transactionCode || change.current.transactionId,
      "Fila de origen": change.current.rowNumber,
      "Revisado": state.reviewed[change.key] ? "Sí" : "No"
    }));
    const summary = [
      { "Indicador": "Archivo", "Valor": state.sourceFile?.name || "" },
      { "Indicador": "Ventas válidas de gasolina", "Valor": state.analysis.summary.validSales },
      { "Indicador": "Cambios detectados", "Valor": state.analysis.summary.changes },
      { "Indicador": "Bajas", "Valor": state.analysis.summary.down },
      { "Indicador": "Subidas", "Valor": state.analysis.summary.up },
      { "Indicador": "Cambios consistentes", "Valor": state.analysis.summary.consistent },
      { "Indicador": "A revisar", "Valor": state.analysis.summary.review },
      { "Indicador": "Variación mínima", "Valor": state.analysis.options.minVariation },
      { "Indicador": "Variación máxima", "Valor": state.analysis.options.maxVariation },
      { "Indicador": "Tiempo máximo (minutos)", "Valor": state.analysis.options.maxGapMinutes }
    ];

    const workbook = XLSX.utils.book_new();
    const detailSheet = XLSX.utils.json_to_sheet(detail);
    const summarySheet = XLSX.utils.json_to_sheet(summary);
    detailSheet["!cols"] = [
      { wch: 11 }, { wch: 19 }, { wch: 17 }, { wch: 19 }, { wch: 15 }, { wch: 14 },
      { wch: 12 }, { wch: 27 }, { wch: 24 }, { wch: 10 }, { wch: 22 }, { wch: 16 },
      { wch: 15 }, { wch: 28 }, { wch: 13 }, { wch: 10 }
    ];
    summarySheet["!cols"] = [{ wch: 32 }, { wch: 26 }];
    XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumen");
    XLSX.utils.book_append_sheet(workbook, detailSheet, "Cambios detectados");
    XLSX.writeFile(workbook, `validador_precios_${toDateKey(new Date())}.xlsx`);
    showToast(`Se exportaron ${changes.length.toLocaleString("es-CL")} detecciones.`, false);
  }

  function setProgress(percent, text) {
    $("progressWrap").hidden = false;
    $("progressBar").style.width = `${Math.max(0, Math.min(100, percent))}%`;
    $("progressText").textContent = text;
  }

  function hideProgress() {
    $("progressWrap").hidden = true;
  }

  function setStatus(type, text) {
    const badge = $("statusBadge");
    badge.className = `vp-badge vp-badge--${type}`;
    badge.textContent = text;
  }

  function showMessage(text, type) {
    const target = $("uploadMessage");
    target.innerHTML = text ? `<div class="vp-notice vp-notice--${type}">${text}</div>` : "";
  }

  function showToast(text, isError) {
    const toast = $("toast");
    toast.textContent = text;
    toast.className = `vp-toast${isError ? " is-error" : " is-success"}`;
    toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.hidden = true;
    }, 3500);
  }

  function formatMoney(value) {
    return `$${formatNumber(finiteOrZero(value))}`;
  }

  function formatSignedMoney(value) {
    const number = finiteOrZero(value);
    return `${number > 0 ? "+" : number < 0 ? "−" : ""}$${formatNumber(Math.abs(number))}`;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("es-CL", { maximumFractionDigits: 0 });
  }

  function formatDate(value) {
    return value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toLocaleDateString("es-CL")
      : "—";
  }

  function formatTime(value) {
    return value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false })
      : "—";
  }

  function formatDateTime(value) {
    return `${formatDate(value)} ${formatTime(value)}`;
  }

  function formatGap(value) {
    if (!Number.isFinite(value)) return "—";
    if (value < 1) return `${Math.max(0, Math.round(value * 60))} seg`;
    return `${round(value, 1).toLocaleString("es-CL")} min`;
  }

  function formatMinutes(value) {
    const minutes = Number(value || 0);
    if (minutes < 60) return `${minutes} minutos`;
    if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hora" : "horas"}`;
    return `${minutes} minutos`;
  }

  function formatFileSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toLocaleString("es-CL", { maximumFractionDigits: 1 })} MB`;
  }

  function toDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  function sameDay(a, b) {
    return toDateKey(a) === toDateKey(b);
  }

  function finiteOrZero(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function sumFinite(...values) {
    return values.reduce((total, value) => total + finiteOrZero(value), 0);
  }

  function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(Number(value || 0) * factor) / factor;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character]));
  }
})();
