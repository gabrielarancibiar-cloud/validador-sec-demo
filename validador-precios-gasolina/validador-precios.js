(() => {
  "use strict";

  const CORE = window.PriceChangeCore;
  const $ = (id) => document.getElementById(id);
  const REVIEW_STORAGE_KEY = "valepac_price_period_reviews_v1";
  const state = {
    sourceFile: null,
    sales: [],
    analysis: null,
    filteredPeriods: [],
    filteredExceptions: [],
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

    ["productFilter", "directionFilter", "dateFrom", "dateTo"].forEach((id) => {
      $(id).addEventListener("change", renderPeriods);
    });
    $("searchFilter").addEventListener("input", renderPeriods);

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

    $("exceptionRows").addEventListener("click", (event) => {
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
    state.filteredPeriods = [];
    state.filteredExceptions = [];
    $("fileName").textContent = `${file.name} · ${formatFileSize(file.size)}`;
    $("dropzone").classList.add("has-file");
    $("analyzeBtn").disabled = true;
    $("exportBtn").disabled = true;
    setStatus("neutral", "Procesando CSV");
    setProgress(2, "Leyendo precios y cantidades...");
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
      stableTolerance: Number($("stableTolerance").value),
      confirmationWindowMinutes: Number($("confirmationWindow").value),
      transitionLookAhead: 8,
      transitionConfirmationSales: 3,
      seedSales: 8,
      minValidPrice: 500,
      maxValidPrice: 4000
    };
  }

  function analyze() {
    if (!state.sales.length) return;
    const options = getOptions();
    if (
      !Number.isFinite(options.minVariation) ||
      !Number.isFinite(options.maxVariation) ||
      !Number.isFinite(options.stableTolerance) ||
      options.minVariation < 0 ||
      options.stableTolerance < 0
    ) {
      showMessage("Revisa los valores de la regla de segmentación.", "error");
      return;
    }
    if (options.minVariation > options.maxVariation) {
      showMessage("El cambio mínimo no puede ser mayor que el cambio máximo.", "error");
      return;
    }

    state.analysis = CORE.analyzeStablePeriods(state.sales, options);
    renderKpis();
    renderProductSummary();
    renderPeriods();
    $("exportBtn").disabled = state.analysis.periods.length === 0;
    setStatus("success", `${state.analysis.periods.length.toLocaleString("es-CL")} periodos detectados`);

    const excluded = state.analysis.invalidPrice.length + state.analysis.invalidLiters.length;
    showMessage(
      `Se detectaron ${state.analysis.periods.length.toLocaleString("es-CL")} periodos estables y se acumularon ${formatLiters(state.analysis.summary.stableLiters)} dentro de sus niveles de precio.` +
      (excluded ? ` Se excluyeron ${excluded.toLocaleString("es-CL")} registros con precio o cantidad no válidos.` : ""),
      excluded ? "warning" : "success"
    );
  }

  function renderEmpty() {
    ["kpiTotalLiters", "kpiStableLiters", "kpiPeriods", "kpiDown", "kpiUp", "kpiExceptionLiters"].forEach((id) => {
      $(id).textContent = "—";
    });
    $("kpiPeriod").textContent = "Sin archivo";
    $("kpiCoverage").textContent = "— de cobertura";
    $("kpiExceptionSales").textContent = "Ventas aisladas";
  }

  function renderKpis() {
    const summary = state.analysis.summary;
    const exceptionSales = state.analysis.periods.reduce((total, period) => total + period.exceptionSales.length, 0);
    $("kpiTotalLiters").textContent = formatLiters(summary.totalLiters);
    $("kpiStableLiters").textContent = formatLiters(summary.stableLiters);
    $("kpiPeriods").textContent = summary.periods.toLocaleString("es-CL");
    $("kpiDown").textContent = summary.down.toLocaleString("es-CL");
    $("kpiUp").textContent = summary.up.toLocaleString("es-CL");
    $("kpiExceptionLiters").textContent = formatLiters(summary.exceptionLiters);
    $("kpiCoverage").textContent = `${formatPercent(summary.stableCoverage)} de cobertura`;
    $("kpiExceptionSales").textContent = `${exceptionSales.toLocaleString("es-CL")} ventas aisladas`;
    $("kpiPeriod").textContent = summary.dateFrom && summary.dateTo
      ? `${formatDate(summary.dateFrom)} al ${formatDate(summary.dateTo)}`
      : "Sin periodo";
  }

  function renderProductSummary() {
    const container = $("productSummary");
    const products = ["Gasolina 93", "Gasolina 95", "Gasolina 97"];
    container.innerHTML = products.map((product) => {
      const periods = state.analysis.periods.filter((period) => period.product === product);
      if (!periods.length) return "";
      const stableLiters = sum(periods.map((period) => period.stableLiters));
      const exceptionLiters = sum(periods.map((period) => period.exceptionLiters));
      const stableSales = sum(periods.map((period) => period.stableSales.length));
      const lastPeriod = [...periods].sort((a, b) => b.sequence - a.sequence)[0];
      return `
        <article class="vp-product-card">
          <div class="vp-product-card-head">
            <div>
              <span>${escapeHtml(product)}</span>
              <strong>${formatMoney(lastPeriod.stablePrice)}</strong>
              <small>Último precio estable</small>
            </div>
            <span class="vp-product-periods">${periods.length} periodos</span>
          </div>
          <div class="vp-product-metrics">
            <div><span>Litros estables</span><strong>${formatLiters(stableLiters)}</strong></div>
            <div><span>Ventas agrupadas</span><strong>${stableSales.toLocaleString("es-CL")}</strong></div>
            <div><span>Fuera de nivel</span><strong>${formatLiters(exceptionLiters)}</strong></div>
          </div>
        </article>
      `;
    }).join("") || '<div class="vp-empty-panel">No hay productos para mostrar.</div>';
  }

  function renderPeriods() {
    const rows = $("periodRows");
    if (!state.analysis) {
      rows.innerHTML = '<tr><td colspan="12" class="vp-empty">Carga un CSV para comenzar.</td></tr>';
      $("resultCount").textContent = "Sin resultados.";
      renderExceptions();
      return;
    }

    const product = $("productFilter").value;
    const direction = $("directionFilter").value;
    const dateFrom = $("dateFrom").value;
    const dateTo = $("dateTo").value;
    const search = CORE.normalizeText($("searchFilter").value).replace(/\$/g, "");

    state.filteredPeriods = state.analysis.periods.filter((period) => {
      if (product !== "all" && period.product !== product) return false;
      if (direction !== "all" && period.direction !== direction) return false;
      const startKey = toDateKey(period.start);
      const endKey = toDateKey(period.end);
      if (dateFrom && endKey < dateFrom) return false;
      if (dateTo && startKey > dateTo) return false;
      if (search) {
        const prices = [period.stablePrice, ...period.priceBreakdown.map((item) => item.price)].join(" ");
        if (!CORE.normalizeText(prices).includes(search)) return false;
      }
      return true;
    });

    const visibleLiters = sum(state.filteredPeriods.map((period) => period.stableLiters));
    $("resultCount").textContent = `${state.filteredPeriods.length.toLocaleString("es-CL")} de ${state.analysis.periods.length.toLocaleString("es-CL")} periodos visibles · ${formatLiters(visibleLiters)} estables.`;

    if (!state.filteredPeriods.length) {
      rows.innerHTML = '<tr><td colspan="12" class="vp-empty">No hay periodos para los filtros seleccionados.</td></tr>';
      renderExceptions();
      return;
    }

    rows.innerHTML = state.filteredPeriods.map((period) => {
      const prices = period.priceBreakdown.map((item) =>
        `<span class="vp-price-chip" title="${item.sales} ventas">${formatMoney(item.price)} · ${formatLiters(item.liters)}</span>`
      ).join("");
      return `
        <tr>
          <td><strong>${escapeHtml(period.product)}</strong></td>
          <td><span class="vp-period-number">#${period.sequence}</span></td>
          <td>${movementBadge(period.direction)}</td>
          <td class="vp-money">${formatMoney(period.stablePrice)}</td>
          <td class="vp-money ${period.direction === "down" ? "vp-delta--down" : period.direction === "up" ? "vp-delta--up" : ""}">${period.changeDelta === null ? "—" : formatSignedMoney(period.changeDelta)}</td>
          <td>${formatDateTime(period.start)}</td>
          <td>${formatDateTime(period.end)}</td>
          <td class="vp-align-right">${formatDuration(period.start, period.end)}</td>
          <td class="vp-align-right">${period.stableSales.length.toLocaleString("es-CL")}</td>
          <td class="vp-money vp-liters-main">${formatLiters(period.stableLiters)}</td>
          <td><div class="vp-price-list">${prices}</div></td>
          <td class="vp-money ${period.exceptionLiters ? "vp-delta--up" : ""}">${formatLiters(period.exceptionLiters)}</td>
        </tr>
      `;
    }).join("");
    renderExceptions();
  }

  function renderExceptions() {
    const rows = $("exceptionRows");
    if (!state.analysis) {
      rows.innerHTML = '<tr><td colspan="10" class="vp-empty">Sin datos.</td></tr>';
      return;
    }

    state.filteredExceptions = state.filteredPeriods.flatMap((period) =>
      period.exceptionSales.map((sale) => ({ period, sale }))
    ).sort((a, b) => a.sale.timestamp - b.sale.timestamp);

    $("exceptionCount").textContent = state.filteredExceptions.length
      ? `${state.filteredExceptions.length.toLocaleString("es-CL")} ventas visibles que no formaron un nuevo periodo confirmado.`
      : "No existen ventas fuera del nivel para los filtros seleccionados.";

    if (!state.filteredExceptions.length) {
      rows.innerHTML = '<tr><td colspan="10" class="vp-empty">No hay ventas aisladas para mostrar.</td></tr>';
      return;
    }

    rows.innerHTML = state.filteredExceptions.map(({ period, sale }) => {
      const transaction = sale.transactionCode || sale.transactionId || `Fila ${sale.rowNumber}`;
      const shortTransaction = transaction.length > 18 ? `…${transaction.slice(-18)}` : transaction;
      const reviewKey = `${period.id}|${transaction}|${sale.timestamp.getTime()}`;
      const isReviewed = Boolean(state.reviewed[reviewKey]);
      return `
        <tr>
          <td><strong>${escapeHtml(period.product)}</strong></td>
          <td>${formatDateTime(sale.timestamp)}</td>
          <td class="vp-money">${formatMoney(sale.price)}</td>
          <td class="vp-money">${formatMoney(period.stablePrice)}</td>
          <td class="vp-money ${sale.price - period.stablePrice < 0 ? "vp-delta--down" : "vp-delta--up"}">${formatSignedMoney(sale.price - period.stablePrice)}</td>
          <td class="vp-money">${formatLiters(sale.liters)}</td>
          <td>${escapeHtml(sale.attendant || "—")}</td>
          <td>${escapeHtml(sale.pos || sale.pump || "—")}</td>
          <td title="${escapeHtml(transaction)}">${escapeHtml(shortTransaction)}</td>
          <td><button class="vp-review-btn${isReviewed ? " is-reviewed" : ""}" type="button" data-review-key="${escapeHtml(reviewKey)}">${isReviewed ? "✓ Revisado" : "Marcar revisado"}</button></td>
        </tr>
      `;
    }).join("");
  }

  function movementBadge(direction) {
    if (direction === "down") return '<span class="vp-status vp-status--down">Baja</span>';
    if (direction === "up") return '<span class="vp-status vp-status--up">Subida</span>';
    return '<span class="vp-status vp-status--initial">Inicial</span>';
  }

  function clearFilters() {
    $("productFilter").value = "all";
    $("directionFilter").value = "all";
    $("dateFrom").value = "";
    $("dateTo").value = "";
    $("searchFilter").value = "";
    renderPeriods();
  }

  function toggleReviewed(key) {
    if (state.reviewed[key]) delete state.reviewed[key];
    else state.reviewed[key] = new Date().toISOString();
    try {
      localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(state.reviewed));
    } catch (_) {
      showToast("No fue posible guardar la revisión en este navegador.", true);
    }
    renderExceptions();
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
    const periods = state.filteredPeriods.length ? state.filteredPeriods : state.analysis.periods;
    const exceptions = periods.flatMap((period) => period.exceptionSales.map((sale) => ({ period, sale })));
    const periodRows = periods.map((period) => ({
      "Producto": period.product,
      "Periodo": period.sequence,
      "Origen": period.direction === "initial" ? "Inicial" : period.direction === "down" ? "Baja" : "Subida",
      "Precio estable": period.stablePrice,
      "Precio anterior": period.previousPrice,
      "Cambio": period.changeDelta,
      "Desde": formatDateTime(period.start),
      "Hasta": formatDateTime(period.end),
      "Ventas estables": period.stableSales.length,
      "Litros estables": period.stableLiters,
      "Ventas fuera de nivel": period.exceptionSales.length,
      "Litros fuera de nivel": period.exceptionLiters,
      "Litros totales del periodo": period.totalLiters
    }));
    const breakdownRows = periods.flatMap((period) => period.priceBreakdown.map((item) => ({
      "Producto": period.product,
      "Periodo": period.sequence,
      "Precio estable principal": period.stablePrice,
      "Precio incluido": item.price,
      "Ventas": item.sales,
      "Litros": item.liters,
      "Desde": formatDateTime(period.start),
      "Hasta": formatDateTime(period.end)
    })));
    const exceptionRows = exceptions.map(({ period, sale }) => {
      const transaction = sale.transactionCode || sale.transactionId || `Fila ${sale.rowNumber}`;
      const reviewKey = `${period.id}|${transaction}|${sale.timestamp.getTime()}`;
      return {
        "Producto": period.product,
        "Periodo": period.sequence,
        "Fecha y hora": formatDateTime(sale.timestamp),
        "Precio venta": sale.price,
        "Precio estable": period.stablePrice,
        "Diferencia": sale.price - period.stablePrice,
        "Litros": sale.liters,
        "Atendedor": sale.attendant,
        "POS": sale.pos || sale.pump,
        "Transacción": transaction,
        "Revisado": state.reviewed[reviewKey] ? "Sí" : "No"
      };
    });
    const summaryRows = [
      { "Indicador": "Archivo", "Valor": state.sourceFile?.name || "" },
      { "Indicador": "Litros analizados", "Valor": state.analysis.summary.totalLiters },
      { "Indicador": "Litros en precios estables", "Valor": state.analysis.summary.stableLiters },
      { "Indicador": "Cobertura estable", "Valor": state.analysis.summary.stableCoverage },
      { "Indicador": "Periodos detectados", "Valor": state.analysis.summary.periods },
      { "Indicador": "Cambios por baja", "Valor": state.analysis.summary.down },
      { "Indicador": "Cambios por subida", "Valor": state.analysis.summary.up },
      { "Indicador": "Litros fuera de nivel", "Valor": state.analysis.summary.exceptionLiters },
      { "Indicador": "Cambio mínimo", "Valor": state.analysis.options.minVariation },
      { "Indicador": "Cambio máximo", "Valor": state.analysis.options.maxVariation },
      { "Indicador": "Banda estable", "Valor": state.analysis.options.stableTolerance }
    ];

    const workbook = XLSX.utils.book_new();
    const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
    const periodsSheet = XLSX.utils.json_to_sheet(periodRows);
    const breakdownSheet = XLSX.utils.json_to_sheet(breakdownRows);
    const exceptionsSheet = XLSX.utils.json_to_sheet(exceptionRows);
    summarySheet["!cols"] = [{ wch: 31 }, { wch: 28 }];
    periodsSheet["!cols"] = [
      { wch: 17 }, { wch: 9 }, { wch: 11 }, { wch: 15 }, { wch: 15 }, { wch: 11 },
      { wch: 19 }, { wch: 19 }, { wch: 16 }, { wch: 15 }, { wch: 20 }, { wch: 19 }, { wch: 21 }
    ];
    breakdownSheet["!cols"] = [{ wch: 17 }, { wch: 9 }, { wch: 22 }, { wch: 16 }, { wch: 11 }, { wch: 14 }, { wch: 19 }, { wch: 19 }];
    exceptionsSheet["!cols"] = [{ wch: 17 }, { wch: 9 }, { wch: 19 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 24 }, { wch: 10 }, { wch: 28 }, { wch: 11 }];
    summarySheet["B5"].z = "0.00%";

    XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumen");
    XLSX.utils.book_append_sheet(workbook, periodsSheet, "Periodos estables");
    XLSX.utils.book_append_sheet(workbook, breakdownSheet, "Detalle por precio");
    XLSX.utils.book_append_sheet(workbook, exceptionsSheet, "Fuera de nivel");
    XLSX.writeFile(workbook, `periodos_precios_gasolina_${toDateKey(new Date())}.xlsx`);
    showToast(`Se exportaron ${periods.length.toLocaleString("es-CL")} periodos.`, false);
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

  function formatLiters(value) {
    const number = finiteOrZero(value);
    return `${number.toLocaleString("es-CL", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} L`;
  }

  function formatPercent(value) {
    return Number(value || 0).toLocaleString("es-CL", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  function formatDuration(start, end) {
    const minutes = Math.max(0, Math.round((end - start) / 60000));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    if (hours < 24) return `${hours} h${remaining ? ` ${remaining} min` : ""}`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days} d${remainingHours ? ` ${remainingHours} h` : ""}`;
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

  function finiteOrZero(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function sum(values) {
    return values.reduce((total, value) => total + finiteOrZero(value), 0);
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
