/**
 * Transfer pricing — what the guest pays and what the driver gets.
 *
 *  - Hotel's own service: the hotel's flat price (Property.transfers.ownServicePrice).
 *    Botlify keeps TRANSFER_HOTEL_FEE_RATE of it (default 10%) via split.
 *  - Botlify drivers: Botlify sets the fare per airport.
 *      PLATFORM_TRANSFER_PRICES   JSON, e.g. {"DPS":350000,"CGK":400000}
 *      PLATFORM_TRANSFER_PRICE    fallback fare for any other airport (default 350000)
 *      PLATFORM_TRANSFER_CURRENCY default IDR
 *      DRIVER_PAYOUT_RATE         driver's share of the fare (default 0.75)
 *    Botlify keeps the rest.
 */
const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);

function platformPriceTable() {
  try {
    return JSON.parse(process.env.PLATFORM_TRANSFER_PRICES || "{}") || {};
  } catch {
    return {};
  }
}

/** {price, currency, driverPayout, platformMargin} for a Botlify-driver trip. */
function platformQuote(airportCode = "") {
  const currency = (process.env.PLATFORM_TRANSFER_CURRENCY || "IDR").toUpperCase();
  const table = platformPriceTable();
  const code = String(airportCode || "").toUpperCase();
  const price = num(table[code], num(process.env.PLATFORM_TRANSFER_PRICE, 350000));
  const rate = Math.min(1, Math.max(0, num(process.env.DRIVER_PAYOUT_RATE, 0.75)));
  const round = (n) => (currency === "IDR" ? Math.round(n) : Math.round(n * 100) / 100);
  const driverPayout = round(price * rate);
  return { price, currency, driverPayout, platformMargin: round(price - driverPayout) };
}

/** Botlify's fee on a hotel-run pickup (0..1). */
const hotelTransferFeeRate = () => Math.min(0.5, Math.max(0, num(process.env.TRANSFER_HOTEL_FEE_RATE, 0.1)));

module.exports = { platformQuote, hotelTransferFeeRate };
