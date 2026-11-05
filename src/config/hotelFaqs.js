/**
 * Everything guests ask a hotel, grouped the way a front desk thinks about it.
 *
 * This seeds "Train your AI". Three kinds of entry:
 *
 *  - An ANSWERED question: true for almost any hotel, worded so it can go to a
 *    guest verbatim. The hotelier tightens it if they like.
 *  - An UNANSWERED question (answer ""): only the hotel knows — the WiFi
 *    password, the laundry price. The AI ignores it until it's filled in, and
 *    the page shows it as "Needs your answer". Never a [placeholder]: a matched
 *    answer is sent word for word, so a bracketed blank would reach a guest.
 *  - `required: true`: the AI can't run a hotel without it. These drive the
 *    "Your AI is missing a few details" prompt until they're answered.
 *
 * Where the property record already knows a fact (name, check-in time, city,
 * pool, parking) the answer uses it.
 */

const CATEGORIES = [
  { key: "booking", label: "Booking & rates" },
  { key: "arrival", label: "Check-in & arrival" },
  { key: "room", label: "Rooms & comfort" },
  { key: "food", label: "Food & drink" },
  { key: "housekeeping", label: "Housekeeping & laundry" },
  { key: "facilities", label: "Pool, spa & facilities" },
  { key: "tech", label: "WiFi & tech" },
  { key: "transport", label: "Transport & directions" },
  { key: "local", label: "Local area & activities" },
  { key: "family", label: "Kids, pets & access" },
  { key: "payments", label: "Payments & policies" },
  { key: "issues", label: "Problems & requests" },
  { key: "departure", label: "Check-out & departure" },
  { key: "occasions", label: "Special occasions" },
];

function defaultHotelFaqs(property = {}) {
  const name = property.name || "our hotel";
  const checkIn = property.checkInTime || "14:00";
  const checkOut = property.checkOutTime || "11:00";
  const place = [property.city, property.country].filter(Boolean).join(", ");
  const amenities = (property.amenities || []).map((a) => String(a).toLowerCase());
  const has = (w) => amenities.some((a) => a.includes(w));

  // [category, question, answer, required?]
  const rows = [
    // ── Booking & rates ──────────────────────────────────────────────────
    ["booking", "Do you have rooms available for my dates?", "Tell us your check-in and check-out dates and how many guests, and we'll check live availability for you straight away."],
    ["booking", "How much is a room per night?", "Prices depend on the room and your dates. Send us your dates and number of guests and we'll give you the exact price."],
    ["booking", "What types of rooms do you have?", "We have a few room types to suit couples, families and groups. Tell us how many of you are travelling and we'll suggest the best fit."],
    ["booking", "Can I book directly with you?", "Yes — you can book right here in this chat, or on our website. Booking direct with us is the simplest way."],
    ["booking", "Is there a discount for longer stays?", "We often have better rates for longer stays. Tell us your dates and we'll see what we can offer."],
    ["booking", "Do you have any special offers right now?", "Send us your dates and we'll check for the best rate available for your stay."],
    ["booking", "Can I change my booking dates?", "Usually, yes. Send us your booking name and the new dates and we'll check availability for you."],
    ["booking", "Can I add another night to my stay?", "Happy to check! Tell us which night you'd like to add and we'll confirm if your room is free."],
    ["booking", "Can I book for someone else?", "Of course. Just give us the guest's name and contact number so we can welcome them properly."],
    ["booking", "Do you offer group bookings?", "Yes, we can host groups. Tell us how many rooms, the dates and the number of guests and we'll put together an offer."],
    ["booking", "How do I know my booking is confirmed?", "You'll receive a confirmation with your booking reference. If you can't find it, send us your name and dates and we'll check."],
    ["booking", "Is the price per room or per person?", "Our prices are per room, per night, unless we tell you otherwise."],
    ["booking", "Are taxes included in the price?", "", true],

    // ── Check-in & arrival ───────────────────────────────────────────────
    ["arrival", "What time is check-in?", `Check-in is from ${checkIn}. If you're arriving earlier, let us know and we'll do our best to have your room ready.`, true],
    ["arrival", "Can I check in early?", "Often, yes — it depends on what's booked that day. Tell us your arrival time and we'll confirm as soon as we can."],
    ["arrival", "I'm arriving late at night, is that okay?", "", true],
    ["arrival", "Can I leave my luggage before check-in?", "Yes, you're welcome to leave your bags with us before check-in, free of charge."],
    ["arrival", "What do I need to bring to check in?", "Please bring a valid photo ID or passport for each adult guest. We'll take care of the rest when you arrive."],
    ["arrival", "Is there a deposit at check-in?", "", false],
    ["arrival", "What is your address?", place ? `${name} is in ${place}. We'll send you directions and a map pin before you arrive.` : "", true],
    ["arrival", "How do I find you?", "We'll send you a map pin and simple directions. If you get lost, message us here and we'll guide you."],
    ["arrival", "Is there someone at reception 24 hours?", "", true],
    ["arrival", "Can I check in without staff (self check-in)?", "", false],

    // ── Rooms & comfort ──────────────────────────────────────────────────
    ["room", "Do the rooms have air conditioning?", "", false],
    ["room", "What size bed is in the room?", "It depends on the room type. Tell us which room you're interested in and we'll tell you the bed setup."],
    ["room", "Can I get twin beds instead of a double?", "In some rooms, yes. Let us know when you book and we'll do our best to arrange it."],
    ["room", "Can I add an extra bed?", "In some rooms, yes. Tell us how many guests and we'll suggest the right room or arrange an extra bed if it's available."],
    ["room", "Is there a private bathroom?", "", false],
    ["room", "Is there hot water?", "Yes, all our rooms have hot water."],
    ["room", "Is there a hair dryer in the room?", "", false],
    ["room", "Do you provide toiletries?", "Yes, we provide basic toiletries. If you need anything extra, just ask."],
    ["room", "Are towels provided?", "Yes, towels are provided. Ask us if you'd like pool or beach towels too."],
    ["room", "Is there a safe in the room?", "", false],
    ["room", "Is there a fridge or minibar?", "", false],
    ["room", "Is there a kettle or coffee in the room?", "", false],
    ["room", "Is there a TV in the room?", "", false],
    ["room", "Can I request a quiet room?", "Of course — tell us and we'll do our best to give you a quieter room."],
    ["room", "Can I get a room with a view?", "We'll do our best! Let us know what you'd like and we'll check what's available for your dates."],
    ["room", "Are the rooms non-smoking?", "Yes, our rooms are non-smoking. We're happy to point you to an outdoor area where smoking is allowed."],
    ["room", "Can I get extra pillows or blankets?", "Of course — just message us and we'll bring them to your room."],

    // ── Food & drink ─────────────────────────────────────────────────────
    ["food", "Is breakfast included?", "", true],
    ["food", "What time is breakfast served?", "", true],
    ["food", "Do you have a restaurant?", "", false],
    ["food", "Can I order room service?", "", false],
    ["food", "Do you cater for vegetarians or vegans?", "Yes, we're happy to help. Let us know your dietary needs and we'll make sure there's something for you."],
    ["food", "I have a food allergy, can you help?", "Please tell us exactly what you're allergic to and we'll let the kitchen know. Your safety comes first."],
    ["food", "Do you serve halal food?", "", false],
    ["food", "Can I get a packed breakfast for an early departure?", "We can often prepare something for an early start. Let us know the day before and what time you're leaving."],
    ["food", "Can you recommend restaurants nearby?", "Of course! Tell us what you feel like eating and your budget and we'll suggest our favourite spots."],
    ["food", "Is drinking water provided?", "Yes, we provide drinking water. Please don't drink tap water — ask us if you need more bottles."],
    ["food", "Do you have a bar?", "", false],
    ["food", "Can food be delivered to the hotel?", "Yes, you can order delivery to the hotel. Give the driver our address and we'll help you collect it."],

    // ── Housekeeping & laundry ───────────────────────────────────────────
    ["housekeeping", "Do you have a laundry service?", "", true],
    ["housekeeping", "How much does laundry cost?", "", false],
    ["housekeeping", "How long does laundry take?", "", false],
    ["housekeeping", "How often is the room cleaned?", "", true],
    ["housekeeping", "Can I have my room cleaned now?", "Of course — let us know when you'd like it done and we'll arrange it."],
    ["housekeeping", "I don't want my room cleaned today", "No problem at all — we'll leave your room as it is. Just message us if you need fresh towels or anything else."],
    ["housekeeping", "Can I get fresh towels?", "Of course — message us and we'll bring fresh towels to your room."],
    ["housekeeping", "When are the sheets changed?", "", false],
    ["housekeeping", "Is there an iron I can use?", "", false],

    // ── Pool, spa & facilities ───────────────────────────────────────────
    ["facilities", "Do you have a swimming pool?", has("pool") ? "Yes, guests are welcome to use our pool during their stay." : "", false],
    ["facilities", "What are the pool hours?", "", false],
    ["facilities", "Do you have a spa or massage?", "", false],
    ["facilities", "Do you have a gym?", has("gym") || has("fitness") ? "Yes, we have a gym for guests." : "", false],
    ["facilities", "Is there parking?", has("parking") ? "Yes, we have parking on site for guests." : "", false],
    ["facilities", "Do you rent scooters or bicycles?", "", false],
    ["facilities", "Is there a place to work or a desk?", "", false],
    ["facilities", "Can I use the facilities after check-out?", "Often, yes. Let us know and we'll check what we can arrange for you."],

    // ── WiFi & tech ──────────────────────────────────────────────────────
    ["tech", "Is there WiFi?", has("wifi") ? "Yes, free WiFi is available throughout the property." : "Yes, WiFi is available for guests.", false],
    ["tech", "What is the WiFi password?", "", true],
    ["tech", "The WiFi isn't working, what do I do?", "Sorry about that! Please try turning WiFi off and on again on your device. If it still doesn't work, tell us your room and we'll fix it."],
    ["tech", "What type of power plugs do you have?", "", false],
    ["tech", "Can I borrow a phone charger or adapter?", "We may have one available — ask us and we'll check."],

    // ── Transport & directions ───────────────────────────────────────────
    ["transport", "Do you offer airport pickup?", "Yes, we can arrange an airport pickup. Send us your flight number, arrival time and how many people are travelling and we'll set it up."],
    ["transport", "How much is the airport pickup?", "", true],
    ["transport", "How far is the airport?", "", false],
    ["transport", "Can you book me a taxi?", "Of course — tell us where you're going and when, and we'll arrange it for you."],
    ["transport", "Can you arrange a driver for a day trip?", "Yes, we can arrange a driver for the day. Tell us where you'd like to go and we'll give you a price."],
    ["transport", "Is it easy to get around from here?", "Yes — we can arrange taxis and drivers, and we'll happily recommend the best way to get to the places you want to see."],
    ["transport", "Can you arrange a drop-off to the airport?", "Yes, we can. Tell us your flight time and we'll suggest when to leave and book your driver."],

    // ── Local area & activities ──────────────────────────────────────────
    ["local", "What is there to do nearby?", "Lots! Tell us what you enjoy — beaches, food, culture, nightlife — and we'll suggest our favourite spots."],
    ["local", "How far is the beach?", "", false],
    ["local", "Can you book tours or activities?", "Yes, we can help arrange tours and activities. Tell us what you're interested in and we'll find the best options."],
    ["local", "Is there a supermarket or shop nearby?", "", false],
    ["local", "Is there an ATM nearby?", "", false],
    ["local", "Is there a pharmacy nearby?", "", false],
    ["local", "Where is the nearest hospital?", "", true],
    ["local", "Is the area safe at night?", "Yes, the area is generally safe. As anywhere, keep your valuables secure, and message us any time if you need help."],

    // ── Kids, pets & accessibility ───────────────────────────────────────
    ["family", "Can I bring children?", "Yes, children are very welcome. Let us know their ages when you book so we can make sure the room fits everyone."],
    ["family", "Do you have a baby cot?", "", false],
    ["family", "Is there a charge for children?", "", false],
    ["family", "Are pets allowed?", "", true],
    ["family", "Is the hotel wheelchair accessible?", "", false],
    ["family", "Are there stairs to the rooms?", "", false],

    // ── Payments & policies ──────────────────────────────────────────────
    ["payments", "How do I pay?", "", true],
    ["payments", "Do you accept credit cards?", "", false],
    ["payments", "Can I pay in cash?", "", false],
    ["payments", "What is your cancellation policy?", "", true],
    ["payments", "Can I get a refund?", "It depends on the rate you booked. Send us your booking name and dates and we'll check what applies to your booking."],
    ["payments", "Can I get an invoice or receipt?", "Of course — tell us the name and details you'd like on it and we'll send it to you."],
    ["payments", "Is smoking allowed?", "Smoking isn't allowed inside the rooms. We're happy to point you to an outdoor area where it's permitted."],
    ["payments", "Can I have visitors in my room?", "", false],
    ["payments", "Are there quiet hours?", "", false],

    // ── Problems & requests ──────────────────────────────────────────────
    ["issues", "Something in my room is broken", "Sorry about that! Tell us your room number and what's wrong, and we'll get it fixed as quickly as possible."],
    ["issues", "The air conditioning isn't working", "Sorry about that! Tell us your room number and we'll send someone to fix it right away."],
    ["issues", "There's no hot water", "Sorry! Please let the water run for a minute first. If it's still cold, tell us your room number and we'll sort it out."],
    ["issues", "My room is noisy", "Sorry to hear that. Tell us your room number and we'll see what we can do — including moving you if a quieter room is free."],
    ["issues", "I lost something", "Tell us what you lost and roughly where, and we'll check with the team straight away."],
    ["issues", "I want to make a complaint", "We're really sorry. Please tell us what happened — we'll pass it straight to the manager and make it right."],
    ["issues", "I locked myself out of my room", "No problem — tell us your room number and we'll get you back in."],
    ["issues", "I need a doctor", "If it's an emergency, please call the emergency number we'll share right away. Otherwise tell us what you need and we'll help you find a doctor."],

    // ── Check-out & departure ────────────────────────────────────────────
    ["departure", "What time is check-out?", `Check-out is by ${checkOut}. If you need a little longer, let us know and we'll do our best.`, true],
    ["departure", "Can I check out late?", "Often, yes — it depends on the next booking. Tell us what time you'd like and we'll confirm."],
    ["departure", "Can I leave my luggage after check-out?", "Yes, you're welcome to leave your bags with us after check-out."],
    ["departure", "How do I check out?", "Just come to reception before check-out time, or message us here if you're leaving early."],
    ["departure", "Can I get a ride to the airport when I leave?", "Yes — send us your flight time and we'll arrange your drop-off."],

    // ── Special occasions ────────────────────────────────────────────────
    ["occasions", "It's our honeymoon, can you do something special?", "Congratulations! Let us know your dates and we'll see what we can prepare to make your stay special."],
    ["occasions", "Can you arrange a birthday surprise?", "We'd love to help. Tell us the date and what you have in mind, and we'll let you know what we can arrange."],
    ["occasions", "Can you decorate the room?", "", false],
    ["occasions", "Can you arrange a romantic dinner?", "", false],
    ["occasions", "Can you arrange flowers or a cake?", "", false],
  ];

  return rows.map(([category, question, answer, required]) => ({
    category,
    question,
    answer: answer || "",
    required: !!required,
  }));
}

/**
 * The people behind the hotel — who the AI points guests to, and who the
 * hotelier needs on file. `required` drives the completeness prompt.
 */
const CONTACT_ROLES = [
  { key: "front_desk", label: "Front desk / reception", required: true, share: true },
  { key: "manager", label: "Manager", required: true, share: false },
  { key: "owner", label: "Owner", required: false, share: false },
  { key: "emergency", label: "Emergency contact", required: true, share: true },
  { key: "maintenance_emergency", label: "Emergency maintenance (night & urgent)", required: true, share: false },
  { key: "maintenance", label: "Maintenance (regular, during the week)", required: false, share: false },
  { key: "cleaning", label: "Cleaning / housekeeping", required: false, share: false },
  { key: "taxi", label: "Taxi / driver", required: false, share: true },
  { key: "restaurant", label: "Restaurant / kitchen", required: false, share: true },
];

/**
 * How the AI should behave when a guest is in a tricky spot. Each one is an
 * instruction to the AI, not a reply to a guest.
 */
function defaultPlaybook() {
  return [
    ["An emergency (fire, medical, injury, safety)", "Stay calm and act first. Give the guest the emergency contact's number straight away and tell them to call it now. If it's life-threatening, tell them to call the local emergency number (112 in Indonesia). Keep replies short."],
    ["Something is broken at night (no water, power, AC, lock)", "Apologise, ask for the room number, and give them the emergency maintenance contact's number if we've shared it. Never promise a fix time we can't keep."],
    ["Something needs fixing but isn't urgent", "Apologise, ask for the room number and what's wrong, and tell them it will be fixed during the day. Don't give out the maintenance team's personal number."],
    ["An angry or upset guest", "Apologise sincerely, don't argue or make excuses, and let them know the manager will follow up. Keep it short and human."],
    ["A complaint about cleanliness", "Apologise and ask for the room number. Tell them we'll have it cleaned right away."],
    ["A guest asks for a refund or money back", "Be kind but don't promise a refund. Tell them the manager handles refunds and will get back to them."],
    ["A guest asks for a discount", "Be friendly. You may mention longer-stay or direct-booking rates if we offer them, but never invent a discount."],
    ["Lost property", "Ask what they lost and where, and tell them the team will check. Don't promise we've found it until we have."],
    ["A noise complaint about other guests", "Apologise and tell them we'll deal with it now. Never share other guests' details."],
    ["A guest wants to speak to a person", "Say of course, and that a member of the team will reply shortly. Give the front desk number if they need to call."],
    ["A question you don't know the answer to", "Never guess or make up facts, prices or policies. Say you'll check with the team and get back to them."],
    ["A guest asks for the owner's or staff's personal number", "Don't share personal numbers. Offer the front desk number instead."],
    ["A guest booked through Booking.com, Airbnb or Expedia", "Help them with their stay, but never ask them to cancel and rebook direct, and never send links or contact details meant to take them off that platform."],
  ].map(([situation, response]) => ({ situation, response }));
}

module.exports = { CATEGORIES, CONTACT_ROLES, defaultHotelFaqs, defaultPlaybook };
