/**
 * Flow Starters — ready-made SINGLE flows a user can install in one click and
 * then edit in the visual builder.
 *
 * These differ from FLOW_TEMPLATES (industry packs that install several flows
 * at once): each starter is ONE focused flow solving ONE job, so it drops onto
 * the canvas as an editable starting point.
 *
 * Wiring rules baked in here (must match the runtime engine):
 *  - every flow begins with a node of `type: "trigger"`
 *  - menu options route by OUTGOING EDGE ORDER (option 1 → 1st edge, …)
 *  - condition nodes branch via sourceHandle "true" / "false"
 *  - {{name}}, {{username}} and any ask_question variableName are substituted
 */

// ── tiny builders so the definitions below stay readable ────────────────────
let _i = 0;
const nid = (p) => `${p}_${++_i}`;

const trigger = (keywords, opts = {}) => ({
  id: nid("trg"),
  type: "trigger",
  nodeType: keywords ? "keyword_trigger" : "any_message_trigger",
  position: { x: 300, y: 40 },
  data: keywords
    ? { label: "Keyword Trigger", keywords, matchType: opts.matchType || "contains" }
    : { label: "Any Message" },
});

const text = (message, pos) => ({
  id: nid("txt"),
  type: "action",
  nodeType: "send_text",
  position: pos,
  data: { label: "Send Text", message },
});

const ask = (questionText, variableName, pos) => ({
  id: nid("ask"),
  type: "action",
  nodeType: "ask_question",
  position: pos,
  data: { label: "Ask Question", questionText, variableName },
});

const menu = (content, options, pos) => ({
  id: nid("menu"),
  type: "action",
  nodeType: "button_menu",
  position: pos,
  data: { label: "Button Menu", content, buttonsJson: options.join("\n") },
});

const cond = (conditionVariable, conditionOperator, conditionValue, pos) => ({
  id: nid("cond"),
  type: "condition",
  nodeType: "condition",
  position: pos,
  data: { label: "Condition", conditionVariable, conditionOperator, conditionValue },
});

const tag = (tagName, pos) => ({
  id: nid("tag"),
  type: "action",
  nodeType: "tag_contact",
  position: pos,
  data: { label: "Tag Contact", tagName },
});

const agent = (agentNote, pos) => ({
  id: nid("agt"),
  type: "action",
  nodeType: "assign_agent",
  position: pos,
  data: { label: "Assign Agent", agentNote },
});

const edge = (source, target, sourceHandle) => ({
  id: `e_${source}_${target}${sourceHandle ? `_${sourceHandle}` : ""}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
});

// Straight-line helper: chain nodes top to bottom.
const chain = (nodes) => nodes.slice(0, -1).map((n, i) => edge(n.id, nodes[i + 1].id));

// ── Starter definitions ─────────────────────────────────────────────────────
const build = () => {
  const S = [];

  const add = (meta, nodes, edges) =>
    S.push({ ...meta, flow: { name: meta.name, description: meta.description, nodes, edges } });

  // 1. Price enquiry
  {
    const t = trigger(["price", "pricing", "how much", "cost"]);
    const a = text(
      "Hey {{name}}! 👋 Our packages start at PKR 5,000.\n\nWant me to send the full price list?",
      { x: 300, y: 190 },
    );
    const g = tag("price-enquiry", { x: 300, y: 330 });
    add(
      {
        key: "price_enquiry",
        name: "Price enquiry auto-reply",
        description: "Replies instantly when someone asks about price, and tags them as a lead.",
        icon: "💰",
        category: "Sales",
      },
      [t, a, g],
      chain([t, a, g]),
    );
  }

  // 2. Lead qualification with budget branch
  {
    const t = trigger(["quote", "interested", "enquiry", "inquiry"]);
    const q = ask("Great! What's your budget for this? (just the number)", "budget", { x: 300, y: 190 });
    const c = cond("budget", "greater_than", "500", { x: 300, y: 330 });
    const hot = text("Perfect — that works! 🎉 Someone from our team will call you shortly.", { x: 120, y: 480 });
    const hotTag = tag("hot-lead", { x: 120, y: 610 });
    const asg = agent("Hot lead from flow — budget above threshold", { x: 120, y: 740 });
    const cold = text("Thanks! Here's our starter package — a great place to begin 👇", { x: 520, y: 480 });
    const coldTag = tag("nurture", { x: 520, y: 610 });
    add(
      {
        key: "lead_qualify_budget",
        name: "Lead qualifier (budget branch)",
        description: "Asks the budget, then routes big spenders to your team and others to a starter offer.",
        icon: "🎯",
        category: "Sales",
      },
      [t, q, c, hot, hotTag, asg, cold, coldTag],
      [
        edge(t.id, q.id),
        edge(q.id, c.id),
        edge(c.id, hot.id, "true"),
        edge(hot.id, hotTag.id),
        edge(hotTag.id, asg.id),
        edge(c.id, cold.id, "false"),
        edge(cold.id, coldTag.id),
      ],
    );
  }

  // 3. Support triage menu
  {
    const t = trigger(["help", "support", "issue", "problem"]);
    const m = menu("How can we help you today?", ["Order status", "Returns & refunds", "Talk to a human"], { x: 300, y: 190 });
    const o1 = text("Please share your order number and I'll check it right away 📦", { x: 40, y: 380 });
    const o2 = text("No problem! Returns are accepted within 7 days. Share your order number to start 🔄", { x: 330, y: 380 });
    const o3 = agent("Customer asked for a human via support menu", { x: 620, y: 380 });
    const o3b = text("Sure — connecting you with our team now. Hang tight! 🙌", { x: 620, y: 510 });
    add(
      {
        key: "support_triage",
        name: "Support triage menu",
        description: "A 3-option menu that answers common issues and escalates the rest to a human.",
        icon: "🛠️",
        category: "Support",
      },
      [t, m, o1, o2, o3, o3b],
      [edge(t.id, m.id), edge(m.id, o1.id), edge(m.id, o2.id), edge(m.id, o3.id), edge(o3.id, o3b.id)],
    );
  }

  // 4. Order taking
  {
    const t = trigger(["order", "buy", "purchase"]);
    const m = menu("Awesome! What would you like to order?", ["Small", "Medium", "Large"], { x: 300, y: 190 });
    const s = text("Great pick — Small it is! ✅", { x: 40, y: 380 });
    const md = text("Great pick — Medium it is! ✅", { x: 330, y: 380 });
    const l = text("Great pick — Large it is! ✅", { x: 620, y: 380 });
    const addr = ask("Perfect. What's your delivery address?", "address", { x: 330, y: 520 });
    const ph = ask("And a phone number we can reach you on?", "phone", { x: 330, y: 660 });
    const done = text("Order noted! 🎉 We'll confirm on {{phone}} shortly.", { x: 330, y: 800 });
    const g = tag("order-pending", { x: 330, y: 930 });
    const asg = agent("New order from flow — confirm and dispatch", { x: 330, y: 1060 });
    add(
      {
        key: "order_taking",
        name: "Take an order",
        description: "Collects size, address and phone, tags the order and hands it to your team.",
        icon: "🛒",
        category: "Sales",
      },
      [t, m, s, md, l, addr, ph, done, g, asg],
      [
        edge(t.id, m.id),
        edge(m.id, s.id),
        edge(m.id, md.id),
        edge(m.id, l.id),
        edge(s.id, addr.id),
        edge(md.id, addr.id),
        edge(l.id, addr.id),
        edge(addr.id, ph.id),
        edge(ph.id, done.id),
        edge(done.id, g.id),
        edge(g.id, asg.id),
      ],
    );
  }

  // 5. Appointment booking
  {
    const t = trigger(["book", "booking", "appointment", "slot"]);
    const m = menu("Which service would you like to book?", ["Consultation", "Full session", "Follow-up"], { x: 300, y: 190 });
    const c1 = text("Consultation — great choice!", { x: 40, y: 380 });
    const c2 = text("Full session — great choice!", { x: 330, y: 380 });
    const c3 = text("Follow-up — great choice!", { x: 620, y: 380 });
    const when = ask("What day and time suits you best?", "slot", { x: 330, y: 520 });
    const nm = ask("And your name for the booking?", "custName", { x: 330, y: 660 });
    const done = text("Booked ✅ Thanks {{custName}} — we've got you down for {{slot}}. See you then!", { x: 330, y: 800 });
    const g = tag("booking", { x: 330, y: 930 });
    add(
      {
        key: "appointment_booking",
        name: "Book an appointment",
        description: "Menu of services, then collects the preferred time and name.",
        icon: "📅",
        category: "Bookings",
      },
      [t, m, c1, c2, c3, when, nm, done, g],
      [
        edge(t.id, m.id),
        edge(m.id, c1.id),
        edge(m.id, c2.id),
        edge(m.id, c3.id),
        edge(c1.id, when.id),
        edge(c2.id, when.id),
        edge(c3.id, when.id),
        edge(when.id, nm.id),
        edge(nm.id, done.id),
        edge(done.id, g.id),
      ],
    );
  }

  // 6. Lead magnet delivery
  {
    const t = trigger(["guide", "freebie", "ebook", "pdf"]);
    const e = ask("Happy to send it! What's your best email?", "email", { x: 300, y: 190 });
    const d = text("Sent! 📩 Check {{email}} (peek in spam just in case).", { x: 300, y: 330 });
    const g = tag("lead-magnet", { x: 300, y: 460 });
    add(
      {
        key: "lead_magnet",
        name: "Lead magnet + email capture",
        description: "Trades a free guide for their email address and tags them.",
        icon: "🎁",
        category: "Growth",
      },
      [t, e, d, g],
      chain([t, e, d, g]),
    );
  }

  // 7. Discount code
  {
    const t = trigger(["discount", "promo", "coupon", "offer"]);
    const a = text("Here's your code 🎉\n\n**WELCOME10** — 10% off your first order.\n\nValid for 48 hours!", { x: 300, y: 190 });
    const g = tag("discount-claimed", { x: 300, y: 330 });
    add(
      {
        key: "discount_code",
        name: "Send a discount code",
        description: "Instantly delivers a promo code to anyone who asks for a discount.",
        icon: "🏷️",
        category: "Growth",
      },
      [t, a, g],
      chain([t, a, g]),
    );
  }

  // 8. Business hours / location
  {
    const t = trigger(["hours", "open", "timing", "location", "address", "where"]);
    const a = text("We're open Mon–Sat, 10am–8pm 🕙\n\n📍 Find us here: [add your address]\n\nAnything else I can help with?", { x: 300, y: 190 });
    add(
      {
        key: "hours_location",
        name: "Hours & location reply",
        description: "Answers the classic 'are you open / where are you' question.",
        icon: "📍",
        category: "Support",
      },
      [t, a],
      chain([t, a]),
    );
  }

  // 9. Shipping info
  {
    const t = trigger(["shipping", "delivery", "how long", "dispatch"]);
    const a = text("We dispatch within 24 hours 🚚\n\n• Karachi/Lahore: 2–3 days\n• Rest of Pakistan: 3–5 days\n• COD available\n\nWant to place an order?", { x: 300, y: 190 });
    add(
      {
        key: "shipping_info",
        name: "Shipping & delivery info",
        description: "Explains delivery times and COD without you lifting a finger.",
        icon: "🚚",
        category: "Support",
      },
      [t, a],
      chain([t, a]),
    );
  }

  // 10. Order status
  {
    const t = trigger(["track", "order status", "where is my order"]);
    const q = ask("Sure! What's your order number?", "orderNo", { x: 300, y: 190 });
    const a = text("Thanks! Checking {{orderNo}} now — our team will update you in a few minutes ⏳", { x: 300, y: 330 });
    const asg = agent("Order status request — customer waiting", { x: 300, y: 460 });
    add(
      {
        key: "order_status",
        name: "Order status check",
        description: "Collects the order number and routes it to your team.",
        icon: "📦",
        category: "Support",
      },
      [t, q, a, asg],
      chain([t, q, a, asg]),
    );
  }

  // 11. Welcome new follower
  {
    const t = trigger(["hi", "hello", "hey", "salam"]);
    const a = text("Hey {{name}}! 👋 Thanks for reaching out.\n\nWhat can I help you with today?", { x: 300, y: 190 });
    const m = menu("Pick an option:", ["See prices", "Place an order", "Talk to a human"], { x: 300, y: 330 });
    const o1 = text("Our packages start at PKR 5,000 — want the full list?", { x: 40, y: 520 });
    const o2 = text("Amazing! Just tell me what you'd like and I'll set it up 🛍️", { x: 330, y: 520 });
    const o3 = agent("Customer asked for a human from the welcome menu", { x: 620, y: 520 });
    add(
      {
        key: "welcome_menu",
        name: "Welcome + quick menu",
        description: "Greets first-time DMs and offers three fast paths.",
        icon: "👋",
        category: "Growth",
      },
      [t, a, m, o1, o2, o3],
      [edge(t.id, a.id), edge(a.id, m.id), edge(m.id, o1.id), edge(m.id, o2.id), edge(m.id, o3.id)],
    );
  }

  // 12. Feedback collection
  {
    const t = trigger(["feedback", "review", "suggestion"]);
    const q = ask("We'd love that! How would you rate us out of 10?", "rating", { x: 300, y: 190 });
    const c = cond("rating", "greater_than", "7", { x: 300, y: 330 });
    const happy = text("That means the world 🙏 Would you mind leaving us a review on our page?", { x: 120, y: 480 });
    const happyTag = tag("promoter", { x: 120, y: 610 });
    const sad = text("Thank you for the honesty — we want to fix this. What went wrong?", { x: 520, y: 480 });
    const sadAsg = agent("Low rating — needs a personal follow-up", { x: 520, y: 610 });
    add(
      {
        key: "feedback_nps",
        name: "Feedback / NPS collector",
        description: "Asks for a score, then thanks promoters and escalates unhappy customers.",
        icon: "⭐",
        category: "Support",
      },
      [t, q, c, happy, happyTag, sad, sadAsg],
      [
        edge(t.id, q.id),
        edge(q.id, c.id),
        edge(c.id, happy.id, "true"),
        edge(happy.id, happyTag.id),
        edge(c.id, sad.id, "false"),
        edge(sad.id, sadAsg.id),
      ],
    );
  }

  // 13. Waitlist
  {
    const t = trigger(["waitlist", "notify", "restock", "sold out"]);
    const e = ask("I'll add you to the list! What's your email or phone?", "contactInfo", { x: 300, y: 190 });
    const a = text("Done ✅ You're on the waitlist — we'll message you the moment it's back.", { x: 300, y: 330 });
    const g = tag("waitlist", { x: 300, y: 460 });
    add(
      {
        key: "waitlist",
        name: "Restock waitlist",
        description: "Captures contact details for out-of-stock items.",
        icon: "📝",
        category: "Growth",
      },
      [t, e, a, g],
      chain([t, e, a, g]),
    );
  }

  // 14. Course / service enquiry
  {
    const t = trigger(["course", "class", "admission", "enroll"]);
    const m = menu("Which programme are you interested in?", ["Beginner", "Advanced", "One-on-one"], { x: 300, y: 190 });
    const b = text("The Beginner programme runs 6 weeks — perfect if you're starting out 🌱", { x: 40, y: 380 });
    const adv = text("Advanced is 8 weeks and goes deep 🚀", { x: 330, y: 380 });
    const one = text("One-on-one is fully tailored to you 🎓", { x: 620, y: 380 });
    const nm = ask("Great choice! What's your name so we can send details?", "custName", { x: 330, y: 520 });
    const done = text("Thanks {{custName}} — details are on the way!", { x: 330, y: 660 });
    const g = tag("course-lead", { x: 330, y: 790 });
    add(
      {
        key: "course_enquiry",
        name: "Course / programme enquiry",
        description: "Explains each programme, then captures the lead's name.",
        icon: "🎓",
        category: "Sales",
      },
      [t, m, b, adv, one, nm, done, g],
      [
        edge(t.id, m.id),
        edge(m.id, b.id),
        edge(m.id, adv.id),
        edge(m.id, one.id),
        edge(b.id, nm.id),
        edge(adv.id, nm.id),
        edge(one.id, nm.id),
        edge(nm.id, done.id),
        edge(done.id, g.id),
      ],
    );
  }

  // 15. Portfolio / catalogue
  {
    const t = trigger(["catalogue", "catalog", "portfolio", "samples", "work"]);
    const a = text("Of course! Here's a look at our recent work 👇\n\n[add your catalogue link]", { x: 300, y: 190 });
    const q = ask("Anything specific you're looking for?", "lookingFor", { x: 300, y: 330 });
    const done = text("Got it — {{lookingFor}}. Let me pull together some options for you!", { x: 300, y: 470 });
    const asg = agent("Catalogue enquiry — send tailored options", { x: 300, y: 600 });
    add(
      {
        key: "catalogue_request",
        name: "Send catalogue / portfolio",
        description: "Shares your work, then asks what they need so you can tailor a reply.",
        icon: "📁",
        category: "Sales",
      },
      [t, a, q, done, asg],
      chain([t, a, q, done, asg]),
    );
  }

  // 16. Collab / partnership
  {
    const t = trigger(["collab", "collaboration", "partnership", "sponsor", "pr"]);
    const q = ask("Love that! Tell me a bit about your brand and what you have in mind.", "collabIdea", { x: 300, y: 190 });
    const a = text("Thanks for sharing! Our team reviews collabs weekly and will get back to you 🤝", { x: 300, y: 330 });
    const g = tag("collab-request", { x: 300, y: 460 });
    add(
      {
        key: "collab_request",
        name: "Collaboration requests",
        description: "Filters brand/collab DMs into a tagged, reviewable queue.",
        icon: "🤝",
        category: "Growth",
      },
      [t, q, a, g],
      chain([t, q, a, g]),
    );
  }

  // 17. Job applications
  {
    const t = trigger(["job", "hiring", "vacancy", "apply", "cv"]);
    const q = ask("Great! Which role are you applying for?", "role", { x: 300, y: 190 });
    const a = text("Thanks! Please email your CV to [your email] with '{{role}}' in the subject 📧", { x: 300, y: 330 });
    const g = tag("job-applicant", { x: 300, y: 460 });
    add(
      {
        key: "job_applications",
        name: "Job application handler",
        description: "Routes hiring DMs and tells applicants exactly how to apply.",
        icon: "💼",
        category: "Support",
      },
      [t, q, a, g],
      chain([t, q, a, g]),
    );
  }

  // 18. Payment / how to pay
  {
    const t = trigger(["payment", "pay", "account number", "easypaisa", "jazzcash"]);
    const a = text("Here's how you can pay 💳\n\n• JazzCash: [number]\n• EasyPaisa: [number]\n• Bank: [details]\n\nSend a screenshot once done and we'll confirm!", { x: 300, y: 190 });
    const asg = agent("Payment enquiry — confirm receipt", { x: 300, y: 330 });
    add(
      {
        key: "payment_info",
        name: "Payment instructions",
        description: "Shares your payment methods and flags the chat for confirmation.",
        icon: "💳",
        category: "Sales",
      },
      [t, a, asg],
      chain([t, a, asg]),
    );
  }

  // 19. Giveaway entry
  {
    const t = trigger(["giveaway", "contest", "enter", "win"]);
    const a = text("You're in! 🎉 To complete your entry:\n\n1. Follow us\n2. Like the post\n3. Tag 2 friends\n\nWinners announced Friday!", { x: 300, y: 190 });
    const g = tag("giveaway-entry", { x: 300, y: 330 });
    add(
      {
        key: "giveaway_entry",
        name: "Giveaway entry",
        description: "Confirms entry, lists the rules, and tags entrants for the draw.",
        icon: "🎉",
        category: "Growth",
      },
      [t, a, g],
      chain([t, a, g]),
    );
  }

  // 20. Wholesale / bulk
  {
    const t = trigger(["wholesale", "bulk", "reseller", "distributor"]);
    const q = ask("We do! Roughly what quantity are you looking for?", "qty", { x: 300, y: 190 });
    const a = text("Thanks! For {{qty}} units we can offer special pricing — sending details now 📄", { x: 300, y: 330 });
    const g = tag("wholesale-lead", { x: 300, y: 460 });
    const asg = agent("Wholesale enquiry — send bulk pricing", { x: 300, y: 590 });
    add(
      {
        key: "wholesale_enquiry",
        name: "Wholesale / bulk enquiry",
        description: "Captures quantity and routes bulk buyers to your team.",
        icon: "📦",
        category: "Sales",
      },
      [t, q, a, g, asg],
      chain([t, q, a, g, asg]),
    );
  }

  // 21. Abandoned interest follow-up
  {
    const t = trigger(["thinking", "later", "maybe", "not sure"]);
    const a = text("Totally understandable! 😊 Can I send you a quick summary to look over?", { x: 300, y: 190 });
    const g = tag("nurture", { x: 300, y: 330 });
    add(
      {
        key: "soft_objection",
        name: "Soft objection handler",
        description: "Keeps hesitant buyers warm instead of losing them.",
        icon: "💭",
        category: "Sales",
      },
      [t, a, g],
      chain([t, a, g]),
    );
  }

  // 22. Human handoff
  {
    const t = trigger(["human", "agent", "person", "representative", "talk to someone"]);
    const a = text("Of course — connecting you with a real person now 🙌 They'll reply shortly.", { x: 300, y: 190 });
    const asg = agent("Customer explicitly asked for a human", { x: 300, y: 330 });
    add(
      {
        key: "human_handoff",
        name: "Talk to a human",
        description: "Instantly pauses the bot and alerts your team when someone asks for a person.",
        icon: "🙋",
        category: "Support",
      },
      [t, a, asg],
      chain([t, a, asg]),
    );
  }

  return S;
};

const FLOW_STARTERS = build();

const STARTER_CATEGORIES = ["Sales", "Support", "Growth", "Bookings"];

module.exports = { FLOW_STARTERS, STARTER_CATEGORIES };
