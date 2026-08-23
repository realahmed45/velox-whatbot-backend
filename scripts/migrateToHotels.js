/**
 * One-off migration: bring PRE-PIVOT workspaces onto the hotel product.
 *
 * Workspaces created before the hotel pivot have no `features.hotelBookings`
 * flag (so the AI's hotel booking block never activates) and may sit on a
 * legacy Instagram plan. This backfills them without touching anything a user
 * has deliberately configured.
 *
 * Run once after deploy:  node scripts/migrateToHotels.js
 * Safe to re-run (idempotent). Add --dry to preview without writing.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const DRY = process.argv.includes("--dry");

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI missing — aborting.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const Workspace = require("../src/models/Workspace");

  // 1. Turn the hotel modules on wherever the flag was never set.
  const needsFlags = await Workspace.countDocuments({
    "features.hotelBookings": { $exists: false },
  });
  console.log(`workspaces missing hotel feature flags: ${needsFlags}`);
  if (needsFlags && !DRY) {
    const r = await Workspace.updateMany(
      { "features.hotelBookings": { $exists: false } },
      { $set: { "features.hotelBookings": true, "features.transfers": true } },
    );
    console.log(`  → updated ${r.modifiedCount}`);
  }

  // 2. Move legacy Instagram plans onto the hotel plan so entitlement and the
  //    billing UI agree. Trial/active state and provider ids are preserved.
  const legacy = ["ig_starter", "ig_pro", "growth", "scale", "business", "agency"];
  const needsPlan = await Workspace.countDocuments({
    "subscription.plan": { $in: legacy },
  });
  console.log(`workspaces on legacy plans: ${needsPlan}`);
  if (needsPlan && !DRY) {
    const r = await Workspace.updateMany(
      { "subscription.plan": { $in: legacy } },
      { $set: { "subscription.plan": "hotel_pro" } },
    );
    console.log(`  → updated ${r.modifiedCount}`);
  }

  // 3. Legacy verticals keep their industry, but a workspace that never picked
  //    one ("other"/"general") becomes hospitality so onboarding doesn't gate.
  const needsIndustry = await Workspace.countDocuments({
    industry: { $in: ["other", "general"] },
  });
  console.log(`workspaces with no real vertical: ${needsIndustry}`);
  if (needsIndustry && !DRY) {
    const r = await Workspace.updateMany(
      { industry: { $in: ["other", "general"] } },
      { $set: { industry: "hospitality" } },
    );
    console.log(`  → updated ${r.modifiedCount}`);
  }

  console.log(DRY ? "DRY RUN — nothing written." : "Migration complete.");
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
