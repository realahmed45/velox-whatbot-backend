/**
 * Channex ARI throttle — the revenue engine must not trip the rate limit.
 *
 * Channex allows 20 availability/rate writes per minute per property. In auto
 * mode the revenue engine applies one suggestion per room type in a loop, so a
 * hotel with enough rooms would walk into a 429 and silently stop pushing
 * prices — the OTA keeps selling yesterday's rate while Botlify believes it
 * updated.
 *
 * Asserts two things: ARI writes are spaced out, and reads are NOT (throttling
 * imports would make onboarding crawl for no reason).
 *
 * Run: node scripts/testRateLimit.js
 */
process.env.CHANNEX_API_KEY = process.env.CHANNEX_API_KEY || "test-key";

let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label);
  }
};
const say = (s) => console.log("\n" + s);

(async () => {
  try {
    // Stub the network before the service builds its client.
    const axios = require("axios");
    const realCreate = axios.create.bind(axios);
    const calls = [];
    let failNext429 = 0;

    axios.create = (cfg) => {
      const instance = realCreate(cfg);
      // Replace the transport, keeping the service's own interceptors intact.
      instance.defaults.adapter = async (config) => {
        calls.push({ url: config.url, at: Date.now() });
        if (failNext429 > 0) {
          failNext429--;
          const err = new Error("Too Many Requests");
          err.config = config;
          err.response = { status: 429, headers: { "retry-after": "1" }, data: {} };
          throw err;
        }
        return { data: { data: [] }, status: 200, headers: {}, config };
      };
      return instance;
    };

    const channex = require("../src/services/channels/channexService");

    const property = { channel: { channexPropertyId: "prop-1" } };
    const roomType = {
      _id: "rt-1",
      channexRoomTypeId: "room-1",
      channexRatePlanId: "plan-1",
    };
    const day = (n) => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + n);
      return d;
    };

    say("A 60-day rate push is ONE batched call, not 60.");
    calls.length = 0;
    await channex.pushRateRange(property, roomType, day(1), day(61), 150);
    ok(calls.length === 1, `one request for 60 nights (got ${calls.length})`);

    say("Consecutive ARI writes are spaced apart (20/min = one per 3s).");
    calls.length = 0;
    const t0 = Date.now();
    await channex.pushRateRange(property, roomType, day(1), day(2), 100);
    await channex.pushRateRange(property, roomType, day(2), day(3), 110);
    await channex.pushRateRange(property, roomType, day(3), day(4), 120);
    const elapsed = Date.now() - t0;
    ok(calls.length === 3, `three writes issued (got ${calls.length})`);
    // Three writes = at least two gaps of 3s.
    ok(
      elapsed >= 6000,
      `spaced to respect 20/min — took ${elapsed}ms, expected >=6000ms`,
    );

    say("A 429 is retried rather than dropped.");
    calls.length = 0;
    failNext429 = 1;
    await channex.pushRateRange(property, roomType, day(5), day(6), 130);
    ok(calls.length === 2, `retried after 429 (attempts: ${calls.length})`);

    say("Reads are NOT throttled — imports must stay fast.");
    calls.length = 0;
    const r0 = Date.now();
    await channex.listProperties();
    await channex.listProperties();
    await channex.listProperties();
    const readMs = Date.now() - r0;
    ok(readMs < 1000, `three reads ran immediately (${readMs}ms)`);

    axios.create = realCreate;
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    console.log(
      "\n" + "=".repeat(52) + "\n  " + pass + " passed, " + fail + " failed\n" + "=".repeat(52),
    );
    process.exit(fail ? 1 : 0);
  }
})();
