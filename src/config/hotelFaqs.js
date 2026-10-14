/**
 * The 20 questions every hotel gets asked, with a starting answer for each.
 *
 * These seed "Train your AI" the first time a hotelier opens it. They are a
 * starting point, not a script: the hotelier edits, deletes and adds to them,
 * and the AI answers guests from whatever is left.
 *
 * Answers are written to be TRUE by default, never filled with [placeholders]:
 * the AI can return a matching answer verbatim, so a bracketed blank would go
 * straight to a guest. Where the property record knows the real value (name,
 * check-in time, city) it is used; otherwise the answer stays general enough
 * to be correct for most hotels until the hotelier tightens it.
 */

function defaultHotelFaqs(property = {}) {
  const name = property.name || "our hotel";
  const checkIn = property.checkInTime || "14:00";
  const checkOut = property.checkOutTime || "11:00";
  const place = [property.city, property.country].filter(Boolean).join(", ");
  const amenities = (property.amenities || []).map((a) => String(a).toLowerCase());
  const has = (word) => amenities.some((a) => a.includes(word));

  return [
    {
      question: "What time is check-in and check-out?",
      answer: `Check-in is from ${checkIn} and check-out is by ${checkOut}. If you need a different time, just let us know and we'll do our best.`,
    },
    {
      question: "Can I check in early or check out late?",
      answer:
        "Often, yes — it depends on what's booked that day. Tell us your arrival or departure time and we'll confirm as soon as we can.",
    },
    {
      question: "Is breakfast included?",
      answer:
        "That depends on the room and rate you book — it's shown with each room. Ask us about your dates and we'll tell you exactly what's included.",
    },
    {
      question: "Do you have free WiFi?",
      answer: has("wifi")
        ? "Yes, free WiFi is available throughout the property."
        : "Yes, WiFi is available for guests. We'll share the details when you arrive.",
    },
    {
      question: "Is there parking?",
      answer: has("parking")
        ? "Yes, we have parking on site for guests."
        : "Let us know if you're arriving by car and we'll tell you the best place to park.",
    },
    {
      question: "Do you offer airport pickup?",
      answer:
        "Yes, we can arrange an airport pickup. Send us your flight number and arrival time, and how many people are travelling, and we'll set it up.",
    },
    {
      question: "Where are you located?",
      answer: place
        ? `${name} is in ${place}. We'll send you directions and a map pin once you've booked.`
        : `We'll send you the exact address, directions and a map pin once you've booked.`,
    },
    {
      question: "What is your cancellation policy?",
      answer:
        "It depends on the rate you book — flexible rates can be cancelled free of charge up to a set date, non-refundable rates can't. Tell us your booking and we'll check yours.",
    },
    {
      question: "How do I pay?",
      answer:
        "You can pay on arrival. If you've booked through Booking.com, Airbnb or Expedia, payment follows that platform's terms.",
    },
    {
      question: "Do you have a swimming pool?",
      answer: has("pool")
        ? "Yes, guests are welcome to use our pool during their stay."
        : "We don't have a pool on site, but we're happy to recommend one nearby.",
    },
    {
      question: "Are pets allowed?",
      answer:
        "Please ask us before booking with a pet — we'll check whether we can accommodate them for your dates.",
    },
    {
      question: "Can I bring children?",
      answer:
        "Yes, children are very welcome. Let us know their ages when you book so we can make sure the room fits everyone.",
    },
    {
      question: "Can I add an extra bed?",
      answer:
        "In some rooms, yes. Tell us how many guests and we'll suggest the right room or arrange an extra bed if it's available.",
    },
    {
      question: "Do you have rooms available for my dates?",
      answer:
        "Tell us your check-in and check-out dates and how many guests, and we'll check live availability for you straight away.",
    },
    {
      question: "How much is a room per night?",
      answer:
        "Prices depend on the room and your dates. Send us your dates and number of guests and we'll give you the exact price.",
    },
    {
      question: "Is there a discount for longer stays?",
      answer:
        "We often have better rates for longer stays. Tell us your dates and we'll see what we can offer.",
    },
    {
      question: "Do you have a restaurant?",
      answer:
        "Ask us and we'll tell you what we serve and recommend the best places to eat nearby.",
    },
    {
      question: "Is smoking allowed?",
      answer:
        "Smoking isn't allowed inside the rooms. We're happy to point you to an outdoor area where it's permitted.",
    },
    {
      question: "Can you recommend things to do nearby?",
      answer:
        "Of course! Tell us what you enjoy — beaches, food, culture, nightlife — and we'll suggest our favourite spots.",
    },
    {
      question: "How can I contact the hotel?",
      answer: `Just message us here — we reply quickly, any time of day. If it's urgent, ${name}'s front desk can also help when you arrive.`,
    },
  ];
}

module.exports = { defaultHotelFaqs };
