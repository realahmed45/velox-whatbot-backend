/**
 * agentService — the Botlify Agent.
 *
 * The owner talks to it in plain language ("change Deluxe to 95 next weekend",
 * "who's checking in today?", "how did we do last month?") and it uses the real
 * tools in ./tools.js to answer or act.
 *
 * Safety model, deliberately simple:
 *  - read-only tools run immediately
 *  - anything that changes money, availability or a guest-visible fact returns a
 *    CONFIRMATION REQUEST instead of running. The UI shows "Do this?" and calls
 *    back with confirm:true, which replays that exact tool call.
 *  - the agent never invents data: every number it states comes from a tool.
 */
const logger = require("../../utils/logger");
const { toolSchemas, runTool, needsConfirm, byName } = require("./tools");

const MAX_STEPS = 5; // tool-call rounds per message — keeps latency sane

const SYSTEM_PROMPT = `You are Botlify, the assistant that runs a hotel's day-to-day operations.

You are talking to the hotel's owner or manager — not to a guest.

HOW YOU WORK
- Use the tools to get real data. NEVER guess or invent numbers, names, dates or prices.
- If a tool returns an error, say plainly what went wrong and what you need.
- Keep answers short and human. Lead with the answer, not a preamble.
- Prices, occupancy and revenue: state the figure, then one line of context if useful.
- When listing bookings or arrivals, use short lines, not tables.
- Use the hotel's own currency codes as returned by the tools.
- If the owner's request is ambiguous (which room? which dates?), ask ONE short question.
- Never mention tool names, JSON, or that you are an AI model.

WHAT YOU CAN DO
Answer questions about occupancy, arrivals, departures, revenue, guests, reviews and
pricing suggestions. Change rates, approve pricing suggestions, block rooms, check guests
in and out, update housekeeping, cancel bookings, reply to reviews, and message guests.

Actions that change something are confirmed with the owner before they run — that is
handled for you, so simply call the tool when asked to do something.`;

/**
 * Run one turn of the agent.
 *
 * @param {object} p
 * @param {object} p.workspace   the hotel's workspace doc
 * @param {object} [p.user]      the logged-in user (for audit fields)
 * @param {string} p.message     what the owner said
 * @param {Array}  [p.history]   [{role, content}] prior turns (trimmed by caller)
 * @param {object} [p.confirm]   {name, args} — a tool call the owner just approved
 * @returns {Promise<{reply, pendingAction?, actions:Array}>}
 *   pendingAction = { name, args, summary } → UI shows Approve/Cancel
 */
async function runAgent({ workspace, user, message, history = [], confirm = null }) {
  const { getAnyClient } = require("../ai");
  const client = getAnyClient && getAnyClient();
  if (!client) {
    return {
      reply: "The assistant is not configured yet. Add a Gemini API key to enable it.",
      actions: [],
    };
  }

  const ctx = { workspace, user };
  const actions = [];

  // The owner approved a pending action — run it first, then let the model
  // report the outcome in natural language.
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const h of history.slice(-10)) {
    if (h && h.role && h.content) {
      messages.push({ role: h.role, content: String(h.content).slice(0, 4000) });
    }
  }

  if (confirm && confirm.name) {
    const result = await runTool(confirm.name, confirm.args, ctx);
    actions.push({ name: confirm.name, args: confirm.args, result });
    messages.push({
      role: "user",
      content:
        "I approved this action. Result of " +
        confirm.name +
        ": " +
        JSON.stringify(result) +
        "\n\nTell me what happened in one or two short sentences.",
    });
  } else {
    messages.push({ role: "user", content: String(message || "").slice(0, 4000) });
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const tools = toolSchemas();

  for (let step = 0; step < MAX_STEPS; step++) {
    let response;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: 700,
      });
    } catch (err) {
      logger.error("[agent] model call failed", { err: err.message });
      return {
        reply: "I could not reach the assistant just now. Please try again in a moment.",
        actions,
      };
    }

    const choice = response.choices && response.choices[0];
    const msg = choice && choice.message;
    if (!msg) break;

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      return { reply: (msg.content || "").trim(), actions };
    }

    // Push the assistant's tool-call turn verbatim so the model keeps context.
    messages.push({
      role: "assistant",
      content: msg.content || "",
      tool_calls: calls,
    });

    for (const call of calls) {
      const name = call.function && call.function.name;
      let args = {};
      try {
        args = JSON.parse((call.function && call.function.arguments) || "{}");
      } catch {
        args = {};
      }

      // Anything that changes state stops here and asks the owner first.
      if (needsConfirm(name) && !confirm) {
        return {
          reply: (msg.content || "").trim(),
          pendingAction: {
            name,
            args,
            summary: describeAction(name, args),
          },
          actions,
        };
      }

      const result = await runTool(name, args, ctx);
      actions.push({ name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
  }

  return {
    reply: "I could not finish that — could you rephrase it?",
    actions,
  };
}

/** One plain-language line describing what an action will do, for the UI. */
function describeAction(name, args) {
  const a = args || {};
  switch (name) {
    case "set_rate":
      return (
        "Change " +
        (a.room || "the room") +
        " to " +
        a.rate +
        " per night" +
        (a.from ? " from " + a.from + (a.to ? " to " + a.to : "") : "") +
        " and push it to your channels."
      );
    case "approve_suggestion":
      return "Apply this pricing suggestion and update your channels.";
    case "set_housekeeping":
      return "Mark unit " + a.unit + " as " + (a.status || "").replace("_", " ") + ".";
    case "check_in_guest":
      return "Check in booking " + a.code + (a.unit ? " to unit " + a.unit : "") + ".";
    case "check_out_guest":
      return "Check out booking " + a.code + " and mark the unit dirty.";
    case "cancel_booking":
      return "Cancel booking " + a.code + ". This frees the room and voids its commission.";
    case "block_room":
      return (
        "Block " + (a.room || "the room") + " from " + a.from + " to " + a.to +
        " so it cannot be sold."
      );
    case "reply_to_review":
      return "Send this reply to the guest's review.";
    case "message_guest":
      return "Send this message to the guest of booking " + a.code + ".";
    default: {
      const tool = byName[name];
      return tool ? tool.description : "Run " + name + ".";
    }
  }
}

module.exports = { runAgent, describeAction, SYSTEM_PROMPT };
