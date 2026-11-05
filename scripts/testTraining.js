/**
 * "Train your AI" — the hotel's own knowledge must be what guests get.
 *
 * Proves: a new hotel gets the full default knowledge; an unanswered question
 * is never sent to a guest; edits/adds/deletes take effect; contacts reach the
 * AI with private numbers kept private; the readiness check tracks what's
 * missing; and a hotel seeded with the old 20 questions is upgraded without
 * losing its own answers.
 *
 * Run: node scripts/testTraining.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

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

const call = (handler, { body = {}, params = {}, workspace }) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(d) {
        resolve({ status: this.statusCode, ...d });
      },
    };
    handler({ body, params, workspace }, res, (err) =>
      resolve({ status: res.statusCode, error: err && err.message }),
    );
  });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Workspace = require("../src/models/Workspace");
  const c = require("../src/controllers/trainingController");
  const { matchFaq, buildSystemPrompt } = require("../src/services/ai");

  const made = [];
  try {
    const ws = await Workspace.create({
      name: "Training Test " + Date.now(),
      owner: new mongoose.Types.ObjectId(),
      industry: "hospitality",
      features: { hotelBookings: true },
    });
    made.push(ws._id);
    const workspace = { _id: ws._id };

    console.log("\nA new hotel opens Train your AI.");
    let r = await call(c.listFaqs, { workspace });
    ok(r.faqs.length >= 100, `full default knowledge (${r.faqs.length} questions)`);
    ok(r.categories.length >= 10, `${r.categories.length} topic tabs`);
    ok(r.faqs.every((f) => !/\[.*\]/.test(f.answer)), "no [placeholders] that could reach a guest");
    ok(r.playbook.length >= 10, `behaviour rules seeded (${r.playbook.length})`);
    ok(!r.readiness.complete && r.readiness.missingContacts.length > 0, `readiness flags what's missing (${r.readiness.percent}%)`);

    console.log("\nAn unanswered question is never sent to a guest.");
    let fresh = await Workspace.findById(ws._id);
    const wifi = fresh.aiSettings.faqs.find((f) => /wifi password/i.test(f.question));
    ok(wifi && !wifi.answer && wifi.required, "WiFi password starts unanswered and required");
    let hit = matchFaq(fresh.aiSettings.faqs, "What is the WiFi password?");
    ok(!hit, "the AI does not answer it from training");

    console.log("\nThe hotelier fills it in.");
    r = await call(c.updateFaq, { workspace, params: { id: String(wifi._id) }, body: { question: wifi.question, answer: "It's SunsetGuest2026 — network 'Sunset Beach'." } });
    fresh = await Workspace.findById(ws._id);
    hit = matchFaq(fresh.aiSettings.faqs, "what is the wifi password");
    ok(hit && /SunsetGuest2026/.test(hit.answer), "now the guest gets it, word for word");
    ok(!r.readiness.missingAnswers.some((m) => /wifi/i.test(m.question)), "and it drops off the missing list");

    console.log("\nAdd and delete.");
    r = await call(c.addFaq, { workspace, body: { question: "Do you have yoga classes?", answer: "Yes, every morning at 7am by the pool.", category: "facilities" } });
    ok(r.faqs[0].category === "facilities", "added under the right tab");
    const before = r.faqs.length;
    r = await call(c.deleteFaq, { workspace, params: { id: String(r.faqs[0]._id) } });
    if (!r.faqs) console.log("   delete returned:", r.status, r.error);
    ok(r.faqs.length === before - 1, "deleted");

    console.log("\nContacts reach the AI; private numbers stay private.");
    r = await call(c.saveContacts, { workspace, body: { contacts: [
      { role: "front_desk", name: "Reception", whatsapp: "+62 811 1111 111", availability: "24/7", shareWithGuests: true },
      { role: "emergency", name: "Made", whatsapp: "+62 811 2222 222", availability: "24/7", shareWithGuests: true },
      { role: "manager", name: "Ketut", whatsapp: "+62 811 3333 333", shareWithGuests: false },
      { role: "maintenance_emergency", name: "Wayan", whatsapp: "+62 811 4444 444", availability: "nights", shareWithGuests: false },
    ] } });
    ok(r.contacts.length === 4, "contacts saved");
    ok(r.readiness.missingContacts.length === 0, "all required contacts filled");
    r = await call(c.saveContacts, { workspace, body: { contacts: [{ role: "front_desk", name: "x", whatsapp: "not a number" }] } });
    ok(r.status === 400, "a bad phone number is refused");

    fresh = await Workspace.findById(ws._id);
    const prompt = buildSystemPrompt(fresh, { name: "Guest" }, "", "");
    ok(/\+62 811 1111 111/.test(prompt) && /MAY give this number/.test(prompt), "shareable number is offered to the AI");
    ok(/Ketut/.test(prompt) && /NEVER share this number/.test(prompt) && !/\+62 811 3333 333/.test(prompt), "the manager's private number is never in the prompt");
    ok(/HOW TO HANDLE SITUATIONS/.test(prompt) && /emergency/i.test(prompt), "behaviour rules reach the AI");
    ok(/guest concierge/.test(prompt), "the AI speaks as the hotel's concierge");

    console.log("\nA hotel from the old 20-question version is upgraded.");
    const old = await Workspace.create({
      name: "Old Hotel " + Date.now(),
      owner: new mongoose.Types.ObjectId(),
      industry: "hospitality",
      aiSettings: { faqsSeeded: true, faqs: [
        { question: "Is breakfast included?", answer: "Yes, 7-10am by the pool." },
        { question: "Do you have a rooftop bar?", answer: "Yes, open from 5pm." },
      ] },
    });
    made.push(old._id);
    r = await call(c.listFaqs, { workspace: { _id: old._id } });
    const bf = r.faqs.find((f) => /breakfast included/i.test(f.question));
    ok(bf.answer === "Yes, 7-10am by the pool." && bf.category === "food", "their answer kept, filed under Food & drink");
    ok(r.faqs.some((f) => /rooftop/i.test(f.question)), "their own extra question kept");
    ok(r.faqs.length > 100, `new default questions merged in (${r.faqs.length})`);
    ok(r.faqs.filter((f) => /breakfast included/i.test(f.question)).length === 1, "no duplicates");
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    await Workspace.deleteMany({ _id: { $in: made } });
    console.log("\n" + "=".repeat(52) + "\n  " + pass + " passed, " + fail + " failed\n" + "=".repeat(52));
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
