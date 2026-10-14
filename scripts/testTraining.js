/**
 * "Train your AI" — the hotel's own answers must be what guests get.
 *
 * Proves the four things the feature promises: a new hotel starts with the 20
 * defaults; edits, deletes and additions take effect; a deleted answer is
 * never served again; and the AI answers a guest's question with the
 * hotelier's own wording when it matches.
 *
 * Runs against the real database with a throwaway workspace. The Gemini path
 * isn't exercised here (no key locally) — the instant-match path is, and that
 * is the one that returns the hotelier's words verbatim.
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

// Call a controller handler the way Express would, capturing the JSON.
const call = (handler, { body = {}, params = {}, workspace }) =>
  new Promise((resolve, reject) => {
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
      err ? resolve({ status: res.statusCode, error: err.message }) : reject(new Error("no response")),
    );
  });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Workspace = require("../src/models/Workspace");
  const c = require("../src/controllers/trainingController");
  const { matchFaq } = require("../src/services/ai");

  let ws;
  try {
    ws = await Workspace.create({
      name: "Training Test " + Date.now(),
      owner: new mongoose.Types.ObjectId(),
      industry: "hospitality",
    });
    const workspace = { _id: ws._id };

    console.log("\nA hotel opens Train your AI for the first time.");
    let r = await call(c.listFaqs, { workspace });
    ok(r.faqs.length === 20, `starts with the 20 defaults (${r.faqs.length})`);
    ok(r.faqs.every((f) => !/\[.*\]/.test(f.answer)), "no [placeholders] that could reach a guest");

    console.log("\nThe hotelier edits the breakfast answer.");
    const breakfast = r.faqs.find((f) => /breakfast/i.test(f.question));
    r = await call(c.updateFaq, {
      workspace,
      params: { id: String(breakfast._id) },
      body: { question: breakfast.question, answer: "Yes! Breakfast is included, served 7–10am by the pool." },
    });
    const edited = r.faqs.find((f) => String(f._id) === String(breakfast._id));
    ok(/by the pool/.test(edited.answer), "edit saved");

    console.log("\nA guest asks about breakfast.");
    let fresh = await Workspace.findById(ws._id);
    let hit = matchFaq(fresh.aiSettings.faqs, "Is breakfast included?");
    ok(hit && /by the pool/.test(hit.answer), "the AI gives the hotelier's NEW answer, word for word");

    console.log("\nThe hotelier adds their own question.");
    r = await call(c.addFaq, {
      workspace,
      body: { question: "Do you have a spa?", answer: "Yes — our spa is open 9am to 9pm, massages from USD 30." },
    });
    ok(r.faqs.length === 21, "now 21 questions");
    ok(/spa/i.test(r.faqs[0].question), "newest shows first");
    fresh = await Workspace.findById(ws._id);
    hit = matchFaq(fresh.aiSettings.faqs, "do you have a spa");
    ok(hit && /USD 30/.test(hit.answer), "the AI answers the new question from training");

    console.log("\nThe hotelier deletes the pet question.");
    const pets = r.faqs.find((f) => /pets/i.test(f.question));
    r = await call(c.deleteFaq, { workspace, params: { id: String(pets._id) } });
    ok(r.faqs.length === 20 && !r.faqs.some((f) => /pets/i.test(f.question)), "deleted");
    fresh = await Workspace.findById(ws._id);
    hit = matchFaq(fresh.aiSettings.faqs, "Are pets allowed?");
    ok(!hit || !/pets/i.test(hit.question), "a deleted answer is never served again");

    console.log("\nEmpty input is refused.");
    r = await call(c.addFaq, { workspace, body: { question: "  ", answer: "x" } });
    ok(r.status === 400, "blank question rejected");

    console.log("\nDeleting everything doesn't bring the defaults back.");
    await Workspace.updateOne({ _id: ws._id }, { $set: { "aiSettings.faqs": [] } });
    r = await call(c.listFaqs, { workspace });
    ok(r.faqs.length === 0, "stays empty — the hotelier's choice is respected");

    console.log("\nReset puts the 20 back.");
    r = await call(c.resetFaqs, { workspace });
    ok(r.faqs.length === 20, "restored");
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    if (ws) await Workspace.deleteOne({ _id: ws._id });
    console.log("\n" + "=".repeat(52) + "\n  " + pass + " passed, " + fail + " failed\n" + "=".repeat(52));
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
