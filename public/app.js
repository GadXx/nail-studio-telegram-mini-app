const state = {
  salon: null,
  selectedMasterId: null,
  selectedDate: "",
  selectedStart: null,
  photos: [],
  master: null,
  telegramUser: null,
  appointmentPage: 1,
  masterDate: "",
  toastTimer: null,
  team: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clientView = $("#client-view");
const masterView = $("#master-view");

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Не удалось выполнить запрос.");
  return result;
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", error);
  toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 4400);
}

function isoDateInTimezone(timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateISO, days) {
  const value = new Date(`${dateISO}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function formatDate(dateISO) {
  if (!dateISO) return "—";
  const [year, month, day] = dateISO.split("-").map(Number);
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function setDateBounds(input) {
  if (!state.salon || !input) return;
  const today = isoDateInTimezone(state.salon.timezone);
  input.min = today;
  input.max = addDays(today, state.salon.horizonDays - 1);
  if (!input.value || input.value < input.min || input.value > input.max) input.value = today;
}

function selectedMaster() {
  return state.salon?.masters.find((master) => master.id === state.selectedMasterId);
}

function renderMasters() {
  const container = $("#master-options");
  container.replaceChildren();
  for (const master of state.salon.masters) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `master-option${master.id === state.selectedMasterId ? " is-selected" : ""}`;
    button.setAttribute("aria-pressed", String(master.id === state.selectedMasterId));
    button.innerHTML = `<span class="master-avatar" aria-hidden="true">${escapeHTML(master.name.slice(0, 1))}</span><span>${escapeHTML(master.name)}</span>`;
    button.addEventListener("click", () => {
      state.selectedMasterId = master.id;
      state.selectedStart = null;
      renderMasters();
      updateSummary();
      loadSlots();
    });
    container.append(button);
  }
}

function updateSummary() {
  const master = selectedMaster();
  $("#summary-master").textContent = master?.name ?? "Выбери мастера";
  $("#summary-date").textContent = state.selectedDate ? formatDate(state.selectedDate) : "—";
  $("#summary-time").textContent = state.selectedStart?.label ?? "—";
  $("#summary-duration").textContent = `${state.salon.durationMinutes} минут`;
  $("#submit-booking").disabled = !master || !state.selectedStart;
}

async function loadSlots() {
  const container = $("#time-slots");
  state.selectedDate = $("#booking-date").value;
  state.selectedStart = null;
  updateSummary();
  const master = selectedMaster();
  if (!master) {
    container.innerHTML = '<span class="muted">Сначала выбери мастера</span>';
    return;
  }
  container.innerHTML = '<span class="muted">Ищем свободное время…</span>';
  try {
    const { slots } = await api(`/api/availability?masterId=${encodeURIComponent(master.id)}&date=${encodeURIComponent(state.selectedDate)}`);
    if (!slots.length) {
      container.innerHTML = '<span class="muted">На эту дату свободного времени нет. Попробуй другой день.</span>';
      return;
    }
    container.replaceChildren();
    for (const slot of slots) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slot-button";
      button.textContent = slot.label;
      button.addEventListener("click", () => {
        state.selectedStart = slot;
        container.querySelectorAll(".slot-button").forEach((item) => item.classList.remove("is-selected"));
        button.classList.add("is-selected");
        updateSummary();
      });
      container.append(button);
    }
  } catch (error) {
    container.innerHTML = '<span class="muted">Не удалось загрузить время.</span>';
    showToast(error.message, true);
  }
}

function clearPhotoPreviews() {
  for (const image of $("#photo-previews").querySelectorAll("img")) URL.revokeObjectURL(image.src);
  $("#photo-previews").replaceChildren();
}

function renderPhotoPreviews() {
  clearPhotoPreviews();
  state.photos.forEach((file, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "photo-preview-wrap";
    const image = document.createElement("img");
    image.className = "photo-preview";
    image.alt = file.name;
    image.src = URL.createObjectURL(file);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "photo-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Удалить фото ${index + 1}`);
    remove.addEventListener("click", () => {
      state.photos.splice(index, 1);
      renderPhotoPreviews();
    });
    wrapper.append(image, remove);
    $("#photo-previews").append(wrapper);
  });
}

function resetClientBooking(keepMaster = true) {
  const masterId = keepMaster ? state.selectedMasterId : null;
  $("#booking-form").reset();
  $("#booking-photos").value = "";
  clearPhotoPreviews();
  state.photos = [];
  state.selectedMasterId = masterId;
  state.selectedStart = null;
  renderMasters();
  updateSummary();
  if (masterId) loadSlots();
  else $("#time-slots").innerHTML = '<span class="muted">Сначала выбери мастера</span>';
}

function renderPhotoLink(booking, index) {
  const url = `/api/master/bookings/${booking.id}/photos/${index}`;
  return `<button type="button" class="photo-open" data-action="photo" data-url="${url}" aria-label="Открыть фото ${index + 1}">
    <img src="${url}" alt="Фото клиента ${index + 1}" loading="lazy" />
  </button>`;
}

function bookingCard(booking) {
  const cancelled = booking.status !== "active";
  const photos = (booking.photos ?? []).map((_, index) => renderPhotoLink(booking, index)).join("");
  const contact = [
    booking.telegramUsername ? `<a href="https://t.me/${encodeURIComponent(booking.telegramUsername)}">@${escapeHTML(booking.telegramUsername)}</a>` : "",
    booking.phone ? `<a href="tel:${escapeHTML(booking.phone)}">${escapeHTML(booking.phone)}</a>` : "",
  ].filter(Boolean).join(" · ") || "Клиент не указан";
  const customer = booking.customerName || (booking.source === "master" ? "Запись без данных клиента" : "Клиент");
  return `<article class="appointment-card${cancelled ? " is-cancelled" : ""}" data-booking-id="${booking.id}">
    <div class="appointment-top">
      <div><p class="appointment-date">${escapeHTML(booking.dateLabel)} · ${escapeHTML(booking.timeLabel)}</p>
        <h3 class="appointment-name">${escapeHTML(customer)}</h3></div>
      <span class="appointment-status">${cancelled ? "Отменена" : "Активна"}</span>
    </div>
    <p class="appointment-meta">${contact}${booking.photoCount ? ` · ${booking.photoCount} фото` : ""}</p>
    ${booking.description ? `<p class="appointment-description">${escapeHTML(booking.description)}</p>` : ""}
    ${photos ? `<div class="appointment-photos">${photos}</div>` : ""}
    <div class="appointment-actions">
      ${cancelled ? "" : `<button class="small-button" data-action="cancel" data-id="${booking.id}">Отменить</button>
        <button class="small-button" data-action="reschedule" data-id="${booking.id}">Перенести</button>`}
      <button class="small-button danger" data-action="delete" data-id="${booking.id}">Удалить</button>
    </div>
    ${cancelled ? "" : `<div class="move-panel" id="move-panel-${booking.id}" hidden>
      <label>Новая дата <input class="text-input date-input" data-move-date="${booking.id}" type="date" /></label>
      <div class="slots" data-move-slots="${booking.id}"><span class="muted">Выбери дату</span></div>
      <button class="small-button move-confirm" data-action="move-confirm" data-id="${booking.id}" disabled>Подтвердить перенос</button>
    </div>`}
  </article>`;
}

async function loadMasterBookings(page = state.appointmentPage) {
  const list = $("#appointments-list");
  list.innerHTML = '<div class="empty-state">Загружаем записи…</div>';
  try {
    const data = await api(`/api/master/bookings?page=${page}`);
    state.appointmentPage = data.page;
    list.innerHTML = data.bookings.length
      ? data.bookings.map(bookingCard).join("")
      : '<div class="empty-state">Записей пока нет. Можно добавить запись самостоятельно.</div>';
    const pagination = $("#appointments-pagination");
    pagination.replaceChildren();
    if (data.pages > 1) {
      if (data.page > 1) pagination.append(paginationButton("← Назад", data.page - 1));
      pagination.append(paginationButton(`${data.page} / ${data.pages}`, null));
      if (data.page < data.pages) pagination.append(paginationButton("Дальше →", data.page + 1));
    }
  } catch (error) {
    list.innerHTML = `<div class="empty-state">${escapeHTML(error.message)}</div>`;
  }
}

function paginationButton(label, page) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (page === null) button.disabled = true;
  else button.addEventListener("click", () => loadMasterBookings(page));
  return button;
}

async function loadMasterSlots() {
  const container = $("#master-time-slots");
  state.masterDate = $("#master-date").value;
  container.innerHTML = '<span class="muted">Ищем свободное время…</span>';
  try {
    const { slots } = await api(`/api/availability?masterId=${encodeURIComponent(state.master.id)}&date=${encodeURIComponent(state.masterDate)}`);
    if (!slots.length) {
      container.innerHTML = '<span class="muted">Свободного времени нет.</span>';
      return;
    }
    container.replaceChildren();
    for (const slot of slots) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slot-button";
      button.textContent = slot.label;
      button.addEventListener("click", async () => {
        try {
          await api("/api/master/bookings", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ startsAt: slot.startsAt }),
          });
          showToast(`Время ${formatDate(state.masterDate)}, ${slot.label} забронировано.`);
          $("#master-create-panel").hidden = true;
          loadMasterBookings(1);
        } catch (error) {
          showToast(error.message, true);
          loadMasterSlots();
        }
      });
      container.append(button);
    }
  } catch (error) {
    container.innerHTML = `<span class="muted">${escapeHTML(error.message)}</span>`;
  }
}

function minutesToTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

async function loadMasterSchedule() {
  const data = await api("/api/master/schedule");
  $("#daily-start").value = data.dailyStart;
  $("#daily-end").value = data.dailyEnd;
  renderBlocks(data.blocks);
}

function renderBlocks(blocks) {
  const list = $("#block-list");
  list.innerHTML = blocks.length ? blocks.map((block) => {
    const label = block.startMinute === null
      ? "Весь день"
      : `${minutesToTime(block.startMinute)}–${minutesToTime(block.endMinute)}`;
    return `<div class="block-item"><span>${escapeHTML(formatDate(block.date))} · ${label}</span>
      <button class="small-button danger" type="button" data-action="delete-block" data-id="${block.id}">Убрать</button></div>`;
  }).join("") : '<p class="muted">Нерабочих периодов пока нет.</p>';
}

async function loadMoveSlots(bookingId) {
  const dateInput = $(`[data-move-date="${bookingId}"]`);
  const container = $(`[data-move-slots="${bookingId}"]`);
  const confirm = $(`[data-action="move-confirm"][data-id="${bookingId}"]`);
  if (!dateInput || !container) return;
  setDateBounds(dateInput);
  container.innerHTML = '<span class="muted">Ищем свободное время…</span>';
  confirm.disabled = true;
  try {
    const query = new URLSearchParams({ masterId: state.master.id, date: dateInput.value, ignoreBookingId: bookingId });
    const { slots } = await api(`/api/availability?${query}`);
    if (!slots.length) {
      container.innerHTML = '<span class="muted">На эту дату свободного времени нет.</span>';
      return;
    }
    container.replaceChildren();
    for (const slot of slots) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slot-button";
      button.textContent = slot.label;
      button.addEventListener("click", () => {
        container.querySelectorAll(".slot-button").forEach((item) => item.classList.remove("is-selected"));
        button.classList.add("is-selected");
        confirm.dataset.startsAt = slot.startsAt;
        confirm.disabled = false;
      });
      container.append(button);
    }
  } catch (error) {
    container.innerHTML = `<span class="muted">${escapeHTML(error.message)}</span>`;
  }
}

async function loadTeam() {
  const overview = await api("/api/main/overview");
  state.team = overview;
  renderTeam(overview);
}

function renderTeam(overview) {
  const requests = $("#team-requests");
  requests.innerHTML = overview.requests.length ? `<h3>Заявки</h3>${overview.requests.map((request) => `
    <article class="team-card request-card">
      <div><strong>${escapeHTML(request.requestedName)}</strong><p class="appointment-meta">Заявка на доступ мастера</p></div>
      <div class="request-actions"><input class="text-input request-name" data-request-name="${escapeHTML(request.telegramId)}" value="${escapeHTML(request.requestedName)}" aria-label="Имя мастера" />
        <button class="small-button" data-action="approve-request" data-id="${escapeHTML(request.telegramId)}">Одобрить</button>
        <button class="small-button danger" data-action="reject-request" data-id="${escapeHTML(request.telegramId)}">Отклонить</button></div>
    </article>`).join("")}` : '<p class="muted">Заявок на доступ пока нет.</p>';
  const activeTargets = overview.masters.filter((master) => master.active);
  $("#team-list").innerHTML = overview.masters.map((master) => {
    const future = master.upcomingBookings ?? [];
    const action = master.isMain ? "Главный мастер" : !master.active ? "Отключён" : future.length
      ? `Будущих записей: ${future.length}. Сначала перенеси или отмени их.`
      : `<button class="small-button danger" data-action="deactivate-master" data-id="${escapeHTML(master.id)}">Отключить от новых записей</button>`;
    return `<article class="team-card">
      <div class="team-card-heading"><div><strong>${escapeHTML(master.name)}</strong><span class="team-role">${master.isMain ? "Главный мастер" : master.active ? "Мастер" : "Отключён"}</span></div>
        ${!master.isMain && master.active ? action : ""}</div>
      ${future.length ? `<div class="team-bookings"><h4>Будущие записи</h4>${future.map((booking) => `
        <div class="team-booking" data-team-booking="${booking.id}">
          <div><strong>${escapeHTML(booking.customerName || "Запись без имени")}</strong><span>${escapeHTML(booking.dateLabel)} · ${escapeHTML(booking.timeLabel)}</span></div>
          <div class="appointment-actions"><button class="small-button" data-action="team-transfer-toggle" data-id="${booking.id}">Передать другому мастеру</button>
            <button class="small-button danger" data-action="team-cancel" data-id="${booking.id}">Отменить</button></div>
          <div class="team-transfer" id="team-transfer-${booking.id}" hidden>
            <label>Мастер <select class="text-input" data-transfer-master="${booking.id}">${activeTargets.filter((target) => target.id !== master.id).map((target) => `<option value="${escapeHTML(target.id)}">${escapeHTML(target.name)}</option>`).join("")}</select></label>
            <label>Дата <input class="text-input date-input" data-transfer-date="${booking.id}" type="date" /></label>
            <div class="slots" data-transfer-slots="${booking.id}"><span class="muted">Выбери дату</span></div>
            <button class="small-button move-confirm" data-action="team-transfer-save" data-id="${booking.id}" disabled>Перенести запись</button>
          </div>
        </div>`).join("")}</div>` : ""}
      ${!master.active && master.historyCount ? `<details class="team-history"><summary>История записей · ${master.historyCount}</summary>
        ${master.history.map((booking) => `<div class="history-item"><span>${escapeHTML(booking.dateLabel)} · ${escapeHTML(booking.timeLabel)} · ${escapeHTML(booking.customerName || "Без имени")}</span><span>${booking.status === "active" ? "Активна" : "Отменена"}</span></div>`).join("")}
      </details>` : ""}
    </article>`;
  }).join("");
}

async function loadTeamTransferSlots(bookingId) {
  const masterId = $(`[data-transfer-master="${bookingId}"]`).value;
  const dateInput = $(`[data-transfer-date="${bookingId}"]`);
  const container = $(`[data-transfer-slots="${bookingId}"]`);
  const confirm = $(`[data-action="team-transfer-save"][data-id="${bookingId}"]`);
  setDateBounds(dateInput);
  confirm.disabled = true;
  container.innerHTML = '<span class="muted">Ищем свободное время…</span>';
  try {
    const query = new URLSearchParams({ masterId, date: dateInput.value });
    const { slots } = await api(`/api/availability?${query}`);
    if (!slots.length) {
      container.innerHTML = '<span class="muted">На эту дату свободного времени нет.</span>';
      return;
    }
    container.replaceChildren();
    for (const slot of slots) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slot-button";
      button.textContent = slot.label;
      button.addEventListener("click", () => {
        container.querySelectorAll(".slot-button").forEach((item) => item.classList.remove("is-selected"));
        button.classList.add("is-selected");
        confirm.dataset.startsAt = slot.startsAt;
        confirm.disabled = false;
      });
      container.append(button);
    }
  } catch (error) {
    container.innerHTML = `<span class="muted">${escapeHTML(error.message)}</span>`;
  }
}

function showMasterDashboard(master) {
  state.master = master;
  clientView.classList.remove("is-visible");
  masterView.classList.add("is-visible");
  $("#dashboard-panel").hidden = false;
  $("#master-greeting").textContent = `Привет, ${master.name}`;
  $("#topbar-note").innerHTML = '<span class="status-dot"></span> Рабочий календарь';
  $("#team-panel").hidden = !master.isMain;
  setDateBounds($("#master-date"));
  setDateBounds($("#block-date"));
  loadMasterBookings(1);
  loadMasterSchedule().catch((error) => showToast(error.message, true));
  if (master.isMain) loadTeam().catch((error) => showToast(error.message, true));
}

function showClientView() {
  masterView.classList.remove("is-visible");
  clientView.classList.add("is-visible");
  $("#topbar-note").innerHTML = '<span class="status-dot"></span> Онлайн-запись';
}

$("#booking-date").addEventListener("change", loadSlots);
$("#master-date").addEventListener("change", loadMasterSlots);

$("#booking-photos").addEventListener("change", (event) => {
  const chosen = Array.from(event.target.files ?? []);
  const valid = chosen.filter((file) => ["image/jpeg", "image/png", "image/webp"].includes(file.type));
  if (valid.length !== chosen.length) showToast("Выбери фото JPEG, PNG или WebP.", true);
  const remaining = Math.max(0, 3 - state.photos.length);
  state.photos.push(...valid.slice(0, remaining));
  if (valid.length > remaining) showToast("Можно приложить не больше трёх фото.", true);
  event.target.value = "";
  renderPhotoPreviews();
});

$("#booking-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedMasterId || !state.selectedStart) return;
  const button = $("#submit-booking");
  const formData = new FormData();
  formData.set("masterId", state.selectedMasterId);
  formData.set("startsAt", state.selectedStart.startsAt);
  formData.set("customerName", $("#customer-name").value.trim());
  formData.set("phone", $("#customer-phone").value.trim());
  formData.set("description", $("#description").value.trim());
  for (const photo of state.photos) formData.append("photos", photo, photo.name);
  button.disabled = true;
  button.querySelector("span").textContent = "Сохраняем запись…";
  try {
    const { bookingId } = await api("/api/bookings", { method: "POST", body: formData });
    const master = selectedMaster();
    const bookedDate = state.selectedDate;
    const bookedTime = state.selectedStart.label;
    resetClientBooking(true);
    showToast(`Ты записана к ${master.name} ${formatDate(bookedDate)} в ${bookedTime}. Номер записи: ${bookingId}.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.querySelector("span").textContent = "Подтвердить запись";
    updateSummary();
  }
});

$("#request-master-access").addEventListener("click", async () => {
  const button = $("#request-master-access");
  button.disabled = true;
  try {
    await api("/api/master-requests", { method: "POST" });
    $("#master-request-status").textContent = "Заявка отправлена главному мастеру.";
    button.hidden = true;
  } catch (error) {
    button.disabled = false;
    showToast(error.message, true);
  }
});

$("#schedule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#schedule-warning").textContent = "";
  try {
    const result = await api("/api/master/schedule", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dailyStart: $("#daily-start").value, dailyEnd: $("#daily-end").value }),
    });
    $("#schedule-warning").textContent = result.affectedBookings.length
      ? `Часы сохранены. ${result.affectedBookings.length} существующих записей выходят за новые рабочие часы и остались в календаре.`
      : "Рабочие часы сохранены для каждого дня.";
    showToast("Рабочие часы обновлены.");
    loadMasterBookings(state.appointmentPage);
  } catch (error) {
    showToast(error.message, true);
  }
});

$("#block-all-day").addEventListener("change", (event) => {
  $("#block-times").hidden = event.target.checked;
});

$("#block-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#block-warning").textContent = "";
  try {
    const result = await api("/api/master/availability-blocks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: $("#block-date").value,
        allDay: $("#block-all-day").checked,
        startTime: $("#block-start").value,
        endTime: $("#block-end").value,
      }),
    });
    $("#block-warning").textContent = result.affectedBookings.length
      ? `Отмечено. На это время уже есть ${result.affectedBookings.length} записей — они сохранены.`
      : "Нерабочее время отмечено.";
    $("#block-form").reset();
    $("#block-all-day").checked = true;
    $("#block-times").hidden = true;
    setDateBounds($("#block-date"));
    await loadMasterSchedule();
    loadMasterBookings(state.appointmentPage);
  } catch (error) {
    showToast(error.message, true);
  }
});

$("#toggle-create-booking").addEventListener("click", () => {
  const panel = $("#master-create-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    setDateBounds($("#master-date"));
    loadMasterSlots();
  }
});

$("#appointments-list").addEventListener("change", (event) => {
  const dateInput = event.target.closest("[data-move-date]");
  if (dateInput) loadMoveSlots(dateInput.dataset.moveDate);
});

$("#appointments-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "photo") {
    $("#photo-modal-image").src = button.dataset.url;
    $("#photo-modal").showModal();
  }
  if (action === "reschedule") {
    const panel = $(`#move-panel-${id}`);
    panel.hidden = !panel.hidden;
    if (!panel.hidden) loadMoveSlots(id);
  }
  if (action === "move-confirm") {
    button.disabled = true;
    try {
      const result = await api(`/api/master/bookings/${id}/reschedule`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startsAt: Number(button.dataset.startsAt) }),
      });
      showToast(result.notificationSent
        ? `Запись перенесена на ${result.dateLabel} в ${result.timeLabel}. Клиент уведомлён.`
        : "Запись перенесена. Не удалось уведомить клиента — свяжись с ним самостоятельно.", !result.notificationSent);
      loadMasterBookings(state.appointmentPage);
    } catch (error) {
      showToast(error.message, true);
      button.disabled = false;
    }
  }
  if (action === "cancel") {
    if (!window.confirm("Отменить эту запись? Время снова станет доступно для записи.")) return;
    try {
      const result = await api(`/api/master/bookings/${id}/cancel`, { method: "POST" });
      showToast(result.notificationSent ? "Запись отменена, клиент уведомлён." : "Запись отменена.");
      loadMasterBookings(state.appointmentPage);
    } catch (error) { showToast(error.message, true); }
  }
  if (action === "delete") {
    if (!window.confirm("Удалить запись навсегда? Это действие нельзя отменить.")) return;
    try {
      await api(`/api/master/bookings/${id}`, { method: "DELETE" });
      showToast("Запись удалена.");
      loadMasterBookings(state.appointmentPage);
    } catch (error) { showToast(error.message, true); }
  }
});

$("#block-list").addEventListener("click", async (event) => {
  const button = event.target.closest('[data-action="delete-block"]');
  if (!button) return;
  try {
    await api(`/api/master/availability-blocks/${button.dataset.id}`, { method: "DELETE" });
    await loadMasterSchedule();
    loadMasterBookings(state.appointmentPage);
  } catch (error) { showToast(error.message, true); }
});

$("#team-requests").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const telegramId = button.dataset.id;
  try {
    if (button.dataset.action === "approve-request") {
      const name = $(`[data-request-name="${telegramId}"]`).value.trim();
      await api(`/api/main/requests/${telegramId}/approve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      showToast("Мастер добавлен. По умолчанию доступны часы с 10:00 до 20:00.");
    } else {
      await api(`/api/main/requests/${telegramId}/reject`, { method: "POST" });
      showToast("Заявка отклонена.");
    }
    await loadTeam();
    state.salon = await api("/api/salon");
  } catch (error) { showToast(error.message, true); }
});

$("#team-list").addEventListener("change", (event) => {
  const dateInput = event.target.closest("[data-transfer-date]");
  const masterSelect = event.target.closest("[data-transfer-master]");
  const bookingId = dateInput?.dataset.transferDate ?? masterSelect?.dataset.transferMaster;
  if (bookingId) loadTeamTransferSlots(bookingId);
});

$("#team-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "team-transfer-toggle") {
    const panel = $(`#team-transfer-${id}`);
    panel.hidden = !panel.hidden;
    if (!panel.hidden) loadTeamTransferSlots(id);
  } else if (action === "team-transfer-save") {
    const masterId = $(`[data-transfer-master="${id}"]`).value;
    button.disabled = true;
    try {
      const result = await api(`/api/main/bookings/${id}/transfer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterId, startsAt: Number(button.dataset.startsAt) }),
      });
      showToast(result.notificationSent ? "Запись передана, клиент уведомлён." : "Запись передана. Клиенту нужно сообщить об изменении.", !result.notificationSent);
      await loadTeam();
    } catch (error) { showToast(error.message, true); button.disabled = false; }
  } else if (action === "team-cancel") {
    if (!window.confirm("Отменить запись? Клиент получит уведомление в Telegram, если это возможно.")) return;
    try {
      const result = await api(`/api/main/bookings/${id}/cancel`, { method: "POST" });
      showToast(result.notificationSent ? "Запись отменена, клиент уведомлён." : "Запись отменена.");
      await loadTeam();
    } catch (error) { showToast(error.message, true); }
  } else if (action === "deactivate-master") {
    if (!window.confirm("Отключить мастера от новых записей? История записей сохранится.")) return;
    try {
      await api(`/api/main/masters/${id}/deactivate`, { method: "POST" });
      showToast("Мастер отключён от новых записей.");
      await loadTeam();
      state.salon = await api("/api/salon");
      renderMasters();
    } catch (error) { showToast(error.message, true); }
  }
});

$("#photo-modal-close").addEventListener("click", () => $("#photo-modal").close());
$("#photo-modal").addEventListener("click", (event) => {
  if (event.target === $("#photo-modal")) $("#photo-modal").close();
});

async function initialize() {
  try {
    const telegram = window.Telegram?.WebApp;
    if (!telegram?.initData) {
      const { botUrl } = await api("/api/telegram/config");
      $("#telegram-gate-message").textContent = botUrl
        ? "Это приложение работает внутри Telegram. Открой бота и нажми «Открыть приложение»."
        : "Для запуска настрой Telegram-бота и открой приложение по его кнопке.";
      if (botUrl) {
        const link = $("#open-telegram-bot");
        link.href = botUrl;
        link.hidden = false;
      }
      return;
    }

    telegram.ready();
    telegram.expand();
    const auth = await api("/api/auth/telegram", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: telegram.initData }),
    });
    state.telegramUser = auth.user;
    state.master = auth.master;
    $("#telegram-gate").hidden = true;
    $("#customer-name").value = [auth.user.firstName, auth.user.lastName].filter(Boolean).join(" ");
    const hasUsername = Boolean(auth.user.username);
    $("#customer-phone").required = !hasUsername;
    $("#phone-label").textContent = hasUsername ? "Номер телефона" : "Номер телефона · обязательно";
    $("#phone-hint").textContent = hasUsername
      ? `Мастер сможет связаться с тобой в Telegram как @${auth.user.username}. Телефон указывать не обязательно.`
      : "У тебя нет Telegram username, поэтому укажи номер телефона для связи.";
    $("#master-request-area").hidden = Boolean(auth.master);
    if (!auth.master && auth.masterRequest?.status === "pending") {
      $("#request-master-access").hidden = true;
      $("#master-request-status").textContent = "Заявка отправлена главному мастеру и ожидает подтверждения.";
    } else if (!auth.master && auth.masterRequest?.status === "rejected") {
      $("#master-request-status").textContent = "Предыдущую заявку отклонили. Можно отправить новую.";
    }

    state.salon = await api("/api/salon");
    document.title = `${state.salon.name} · запись онлайн`;
    $("#salon-name").textContent = state.salon.name;
    $("#footer-name").textContent = state.salon.name;
    $("#summary-duration").textContent = `${state.salon.durationMinutes} минут`;
    setDateBounds($("#booking-date"));
    state.selectedDate = $("#booking-date").value;
    renderMasters();
    updateSummary();
    if (auth.master) showMasterDashboard(auth.master);
    else showClientView();
  } catch (error) {
    $("#telegram-gate-message").textContent = error.message;
  }
}

initialize();
