/**
 * mozioService — thin client for the Mozio Partner API (airport transfers).
 *
 * Env:
 *   MOZIO_API_KEY   — partner key (auth header "API-KEY"). Absent → not configured.
 *   MOZIO_BASE_URL  — defaults to the Mozio testing environment.
 *
 * Mozio's flow is async: POST a search, poll for priced results, POST a
 * reservation, poll for confirmation. Their exact response shapes vary between
 * API revisions, so everything here reads keys defensively and NEVER throws —
 * every public function resolves to { ok: true, ... } or { ok: false, error }.
 */
const axios = require("axios");
const logger = require("../../utils/logger");

const BASE_URL =
  process.env.MOZIO_BASE_URL || "https://api-testing.mozio.com/v2";

const isConfigured = () => !!process.env.MOZIO_API_KEY;

const http = () =>
  axios.create({
    baseURL: BASE_URL,
    timeout: 20000,
    headers: {
      "API-KEY": process.env.MOZIO_API_KEY || "",
      "Content-Type": "application/json",
    },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** First non-nullish value among alternate keys of an object. */
const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
};

/** Extract a numeric price from the many shapes Mozio uses. */
const extractPrice = (result) => {
  const tp = pick(result || {}, "total_price", "price", "amount");
  if (tp == null) return null;
  if (typeof tp === "number") return tp;
  if (typeof tp === "string") {
    const n = Number(tp);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(
    pick(tp, "total_price_value", "value", "amount", "total", "price"),
  );
  return Number.isFinite(n) ? n : null;
};

const extractCurrency = (result) => {
  const tp = pick(result || {}, "total_price", "price") || {};
  return (
    pick(tp, "total_price_currency", "currency", "currency_code") ||
    pick(result || {}, "currency", "currency_code") ||
    null
  );
};

/** Pull a results array out of whatever envelope the poll returned. */
const extractResults = (data) => {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  const candidates = [
    data.results,
    data.body?.results,
    data.data?.results,
    data.body,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return [];
};

/**
 * Search one-way transfers. Datetime must be local to the pickup point,
 * "YYYY-MM-DD HH:mm" or ISO — passed through as given.
 *
 * @returns {Promise<{ok:true, searchId, results:Array, cheapest?:object}
 *                  |{ok:false, error:string}>}
 */
async function searchTransfers({
  pickupAddress,
  dropoffAddress,
  pickupDatetime,
  passengers = 2,
}) {
  if (!isConfigured()) return { ok: false, error: "mozio_not_configured" };
  try {
    const payload = {
      start_address: pickupAddress,
      end_address: dropoffAddress,
      mode: "one_way",
      pickup_datetime: pickupDatetime,
      num_passengers: Number(passengers) || 2,
      currency: "USD",
    };
    const { data: started } = await http().post("/search/", payload);
    logger.debug("[mozio] search started", { raw: started });
    const searchId = pick(started || {}, "search_id", "id", "searchId");
    if (!searchId) {
      return { ok: false, error: "mozio_search_no_id" };
    }

    // Poll a few times for priced results.
    let results = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(attempt === 0 ? 1500 : 2000);
      try {
        const { data: polled } = await http().get(`/search/${searchId}/poll/`);
        logger.debug("[mozio] search poll", { attempt, raw: polled });
        results = extractResults(polled);
        const moreComing = pick(polled || {}, "more_coming", "in_progress");
        if (results.length && !moreComing) break;
        if (results.length && attempt >= 2) break; // good enough
      } catch (pollErr) {
        logger.debug("[mozio] search poll error", { err: pollErr.message });
      }
    }
    if (!results.length) return { ok: false, error: "mozio_no_results" };

    // Cheapest priced result first.
    const priced = results
      .map((r) => ({ raw: r, price: extractPrice(r) }))
      .filter((r) => r.price != null)
      .sort((a, b) => a.price - b.price);
    const cheapest = priced[0]?.raw || results[0];
    return { ok: true, searchId, results, cheapest };
  } catch (err) {
    logger.warn("[mozio] search failed", {
      err: err.message,
      data: err.response?.data,
    });
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

/**
 * Book a search result.
 *
 * @returns {Promise<{ok:true, reservationId, confirmationNumber, raw}
 *                  |{ok:false, error:string}>}
 */
async function bookTransfer({ searchId, resultId, guest = {}, flightNumber }) {
  if (!isConfigured()) return { ok: false, error: "mozio_not_configured" };
  try {
    const name = String(guest.name || "Guest").trim();
    const [firstName, ...rest] = name.split(/\s+/);
    const payload = {
      search_id: searchId,
      result_id: resultId,
      email: guest.email || "bookings@botlify.site",
      country_code_name: "US",
      phone_number: guest.phone || "",
      first_name: firstName || "Guest",
      last_name: rest.join(" ") || firstName || "Guest",
      airline_iata_code: undefined,
      flight_number: flightNumber || undefined,
    };
    const { data: created } = await http().post("/reservations/", payload);
    logger.debug("[mozio] reservation started", { raw: created });

    // The POST may already carry the reservation, or we poll by search id.
    let reservation = extractReservation(created);
    for (let attempt = 0; attempt < 6 && !reservation; attempt++) {
      await sleep(2000);
      try {
        const { data: polled } = await http().get(
          `/reservations/${searchId}/poll/`,
        );
        logger.debug("[mozio] reservation poll", { attempt, raw: polled });
        const status = String(
          pick(polled || {}, "status", "state") || "",
        ).toLowerCase();
        if (status === "failed" || status === "error") {
          return { ok: false, error: "mozio_reservation_failed" };
        }
        reservation = extractReservation(polled);
      } catch (pollErr) {
        logger.debug("[mozio] reservation poll error", { err: pollErr.message });
      }
    }
    if (!reservation) return { ok: false, error: "mozio_reservation_timeout" };

    return {
      ok: true,
      reservationId: String(
        pick(reservation, "id", "reservation_id", "hashed_id") || "",
      ),
      confirmationNumber: String(
        pick(reservation, "confirmation_number", "confirmation", "voucher_number") ||
          "",
      ),
      raw: reservation,
    };
  } catch (err) {
    logger.warn("[mozio] booking failed", {
      err: err.message,
      data: err.response?.data,
    });
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

/** Find a reservation object in a POST/poll response envelope. */
function extractReservation(data) {
  if (!data) return null;
  const list = pick(data, "reservations") || pick(data.body || {}, "reservations");
  const candidate = Array.isArray(list) ? list[0] : pick(data, "reservation");
  const res = candidate || null;
  if (!res) return null;
  const hasId = pick(res, "id", "reservation_id", "hashed_id");
  const hasConf = pick(res, "confirmation_number", "confirmation", "voucher_number");
  return hasId || hasConf ? res : null;
}

/** Cancel a Mozio reservation. Best-effort. */
async function cancelReservation(reservationId) {
  if (!isConfigured()) return { ok: false, error: "mozio_not_configured" };
  if (!reservationId) return { ok: false, error: "missing_reservation_id" };
  try {
    const { data } = await http().delete(`/reservations/${reservationId}/`);
    logger.debug("[mozio] reservation cancelled", { reservationId, raw: data });
    return { ok: true };
  } catch (err) {
    logger.warn("[mozio] cancel failed", {
      err: err.message,
      data: err.response?.data,
    });
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

module.exports = {
  isConfigured,
  searchTransfers,
  bookTransfer,
  cancelReservation,
};
