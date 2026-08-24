// One-off patcher: repair the escaped regex literals in listBookings that got
// mangled by shell quoting. Deleted after use.
const fs = require("fs");
const p = "src/controllers/hotelController.js";
let s = fs.readFileSync(p, "utf8");

const broken = `    const esc = term.replace(/[.*+?^\${}()|[\\]\\]/g, "\\$&");`;
const fixed = `    const esc = term.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");`;

if (s.includes(broken)) {
  s = s.replace(broken, fixed);
  fs.writeFileSync(p, s);
  console.log("regex repaired");
} else {
  // Fall back: rewrite the whole line by locating it.
  const lines = s.split("\n");
  const i = lines.findIndex((l) => l.includes("const esc = term.replace("));
  if (i === -1) {
    console.log("line not found");
  } else {
    lines[i] = '    const esc = term.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");';
    fs.writeFileSync(p, lines.join("\n"));
    console.log("regex line rewritten at", i + 1);
  }
}
