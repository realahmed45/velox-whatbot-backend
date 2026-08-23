/**
 * verticalPacks.js — the single source of truth for how Botlify adapts to a
 * business category.
 *
 * Each pack turns a bare "industry" string into a fully-configured workspace:
 *   • goal            → drives the AI prompt (support/sales/leads/bookings)
 *   • features        → which modules are ON for this vertical (appointments,
 *                       catalog, orders, reservations, leadCapture)
 *   • persona         → seeds aiSettings (aiRole / brandVoice / guardrails)
 *   • messages        → tailored welcome / fallback / away copy
 *   • faqStarters     → a vertical-specific FAQ starter pack
 *   • flowTemplateKey → which existing FLOW_TEMPLATES pack to auto-install
 *   • slotDefaults    → default appointment services + hours (booking verticals)
 *   • detectionHints  → keywords the AI/heuristic detector matches against
 *   • requireApprovalByDefault → medical verticals hold bookings for review
 *
 * `industry` on the Workspace model is validated against KEYS below, so any new
 * vertical must be added to BOTH this registry and the model enum.
 */

// Sensible default working hours for booking verticals (Mon–Sat, 9–6, closed Sun).
const DEFAULT_HOURS = [
  { day: "monday", isOpen: true, openTime: "09:00", closeTime: "18:00" },
  { day: "tuesday", isOpen: true, openTime: "09:00", closeTime: "18:00" },
  { day: "wednesday", isOpen: true, openTime: "09:00", closeTime: "18:00" },
  { day: "thursday", isOpen: true, openTime: "09:00", closeTime: "18:00" },
  { day: "friday", isOpen: true, openTime: "09:00", closeTime: "18:00" },
  { day: "saturday", isOpen: true, openTime: "10:00", closeTime: "16:00" },
  { day: "sunday", isOpen: false, openTime: "09:00", closeTime: "18:00" },
];

const OFF = {
  appointments: false,
  catalog: false,
  orders: false,
  reservations: false,
  leadCapture: false,
  // Hotel product modules — every pack must state them explicitly, otherwise
  // applying a vertical would wipe the schema defaults (features is replaced,
  // not merged, in verticalService.applyVertical).
  hotelBookings: false,
  transfers: false,
};

/**
 * PACKS — keyed by industry. Order here is the order shown in the picker grid.
 */
const PACKS = {
  ecommerce: {
    label: "Online Store / eCommerce",
    emoji: "🛍️",
    tagline: "Sell products, take orders, answer buyers 24/7.",
    goal: "sales",
    features: { ...OFF, catalog: true, orders: true, leadCapture: true },
    flowTemplateKey: "ecommerce",
    detectionHints: [
      "shop", "store", "buy", "cart", "checkout", "shipping", "product",
      "order", "collection", "sale", "discount", "shopify", "clothing",
      "boutique", "brand", "merch", "apparel", "cosmetics", "jewelry",
    ],
    persona: {
      aiRole:
        "You are the friendly sales assistant for an online store. You help shoppers find the right product, answer questions about price, sizing, stock and shipping, and guide them to place an order.",
      brandVoice: "Warm, upbeat and helpful — like a great in-store associate.",
      guardrails:
        "Never invent products, prices or stock. Only use the catalog. If unsure, offer to check and take their details.",
    },
    messages: {
      welcome:
        "Hey {first_name}! 👋 Welcome in! Looking for something specific or just browsing? I can help you find the perfect pick 🛍️",
      fallback:
        "Thanks {first_name}! 🙏 Let me grab those details for you — meanwhile, is there a specific product you're after?",
      away:
        "Thanks for the message! We're away right now but I've noted it — we'll get back to you very soon. In the meantime, feel free to ask me anything about our products! 🛍️",
    },
    faqStarters: [
      { question: "Do you ship nationwide?", answer: "Yes! We ship across the country. Delivery usually takes 3–5 business days." },
      { question: "How can I pay?", answer: "You can pay by card, bank transfer, or cash on delivery — whatever's easiest for you." },
      { question: "What's your return policy?", answer: "You can return unused items within 7 days for an exchange or refund. Just message us here." },
      { question: "Do you have this in my size?", answer: "Tell me the item and your size and I'll check availability for you right away!" },
    ],
  },

  restaurant: {
    label: "Restaurant / Café",
    emoji: "🍽️",
    tagline: "Share your menu, take reservations, answer diners fast.",
    goal: "bookings",
    features: { ...OFF, reservations: true, catalog: true, leadCapture: true },
    flowTemplateKey: "restaurant",
    detectionHints: [
      "restaurant", "cafe", "café", "menu", "dine", "food", "cuisine",
      "reservation", "table", "booking", "eat", "kitchen", "bistro",
      "delivery", "takeaway", "coffee", "bakery", "pizza", "burger",
    ],
    persona: {
      aiRole:
        "You are the host for a restaurant. You share the menu, answer questions about dishes, hours and location, and help guests book a table.",
      brandVoice: "Warm, welcoming and appetite-whetting.",
      guardrails:
        "Only describe dishes and prices from the menu provided. For reservations, always collect date, time and party size.",
    },
    messages: {
      welcome:
        "Hi {first_name}! 👋 Thanks for reaching out! Would you like to see our menu, book a table, or ask about something specific? 🍽️",
      fallback:
        "Thanks {first_name}! 🙏 Let me help — would you like our menu or to reserve a table?",
      away:
        "Thanks for reaching out! We're away from the phones right now but I've got your message. Ask me about our menu or hours in the meantime! 🍽️",
    },
    faqStarters: [
      { question: "What are your opening hours?", answer: "We're open Mon–Sat 12pm–11pm, and Sundays 1pm–10pm. Come hungry! 🍽️" },
      { question: "Do you take reservations?", answer: "Absolutely! Tell me your preferred date, time and how many people, and I'll get you booked." },
      { question: "Do you have vegetarian options?", answer: "Yes, we have plenty of vegetarian and vegan dishes. I can share the menu if you'd like!" },
      { question: "Do you offer delivery?", answer: "Yes! We deliver in the local area. Let me know your location and I'll confirm." },
    ],
  },

  beauty_salon: {
    label: "Salon / Spa / Beauty",
    emoji: "💅",
    tagline: "Book appointments, list services, fill your calendar.",
    goal: "bookings",
    features: { ...OFF, appointments: true, leadCapture: true },
    flowTemplateKey: "beauty_salon",
    detectionHints: [
      "salon", "spa", "beauty", "hair", "nails", "makeup", "lashes",
      "facial", "massage", "waxing", "appointment", "booking", "stylist",
      "barber", "grooming", "skincare", "manicure", "pedicure",
    ],
    slotDefaults: {
      slotMinutes: 45,
      bufferMinutes: 10,
      hours: DEFAULT_HOURS,
      services: [
        { name: "Haircut & Styling", durationMinutes: 45, price: 0 },
        { name: "Manicure", durationMinutes: 30, price: 0 },
        { name: "Facial", durationMinutes: 60, price: 0 },
      ],
    },
    persona: {
      aiRole:
        "You are the receptionist for a beauty salon/spa. You describe services, quote prices, and book appointments into available time slots.",
      brandVoice: "Friendly, pampering and reassuring.",
      guardrails:
        "Only offer appointment times the system says are open. Always collect the client's name, phone, chosen service and preferred time before confirming.",
    },
    messages: {
      welcome:
        "Hi {first_name}! ✨ Thanks for reaching out! Would you like to book an appointment or hear about our services? I'm here to help 💅",
      fallback:
        "Thanks {first_name}! 🙏 I can help you book — which service are you interested in, and when works for you?",
      away:
        "Thanks so much! We're with clients right now, but I've got your message. Want to book an appointment? Just tell me the service and I'll find you a slot! ✨",
    },
    faqStarters: [
      { question: "How do I book an appointment?", answer: "Just tell me the service you'd like and your preferred day/time — I'll check what's open and book you in! 💅" },
      { question: "What services do you offer?", answer: "We offer hair, nails, facials, waxing and more. Ask me about any service for details and pricing." },
      { question: "Where are you located?", answer: "I can share our location and directions — would you like the map link?" },
      { question: "Can I reschedule?", answer: "Of course! Just message us here with your new preferred time and we'll sort it out." },
    ],
  },

  dental_clinic: {
    label: "Dental Clinic",
    emoji: "🦷",
    tagline: "Book patient appointments, answer dental questions.",
    goal: "bookings",
    features: { ...OFF, appointments: true, leadCapture: true },
    flowTemplateKey: "appointment",
    requireApprovalByDefault: true,
    detectionHints: [
      "dental", "dentist", "teeth", "tooth", "orthodont", "braces",
      "implant", "cleaning", "whitening", "clinic", "oral", "cavity",
      "root canal", "checkup", "hygiene",
    ],
    slotDefaults: {
      slotMinutes: 30,
      bufferMinutes: 10,
      hours: DEFAULT_HOURS,
      services: [
        { name: "Check-up & Consultation", durationMinutes: 30, price: 0 },
        { name: "Teeth Cleaning", durationMinutes: 45, price: 0 },
        { name: "Whitening", durationMinutes: 60, price: 0 },
      ],
    },
    persona: {
      aiRole:
        "You are the front-desk assistant for a dental clinic. You answer common dental questions, explain services and help patients book appointments into open slots.",
      brandVoice: "Calm, professional, reassuring and clear.",
      guardrails:
        "Never give a diagnosis or medical/dental advice — encourage the patient to book a visit for anything clinical. Only offer appointment times the system says are open. Always collect name, phone, reason for visit and preferred time.",
    },
    messages: {
      welcome:
        "Hello {first_name}! 🦷 Thanks for contacting our clinic. Would you like to book an appointment or ask a question? I'm happy to help.",
      fallback:
        "Thank you {first_name}. 🙏 I can help you book a visit — what would you like to come in for, and when suits you?",
      away:
        "Thank you for reaching out! Our team is with patients right now, but I've noted your message. Would you like to book an appointment? Just let me know the reason and a good time. 🦷",
    },
    faqStarters: [
      { question: "How do I book an appointment?", answer: "Just tell me what you'd like to come in for and your preferred day/time — I'll check the schedule and book you in. 🦷" },
      { question: "Do you accept walk-ins?", answer: "We recommend booking ahead so we can reserve time for you, but message us and we'll do our best to fit you in." },
      { question: "Does it hurt?", answer: "We take great care to keep you comfortable. For anything specific, it's best to book a check-up so the dentist can advise you properly." },
      { question: "Where are you located?", answer: "I can share our clinic location and directions — would you like the map link?" },
    ],
  },

  medical: {
    label: "Doctor / Medical / Therapy",
    emoji: "🩺",
    tagline: "Book consultations, answer patient questions.",
    goal: "bookings",
    features: { ...OFF, appointments: true, leadCapture: true },
    flowTemplateKey: "appointment",
    requireApprovalByDefault: true,
    detectionHints: [
      "doctor", "clinic", "medical", "physician", "therapy", "therapist",
      "psycholog", "counsel", "consultation", "patient", "health",
      "physio", "nutrition", "dietician", "wellness", "practitioner",
    ],
    slotDefaults: {
      slotMinutes: 30,
      bufferMinutes: 10,
      hours: DEFAULT_HOURS,
      services: [
        { name: "Consultation", durationMinutes: 30, price: 0 },
        { name: "Follow-up Visit", durationMinutes: 20, price: 0 },
      ],
    },
    persona: {
      aiRole:
        "You are the assistant for a medical/health practice. You answer general questions about services and hours and help patients book a consultation into an open slot.",
      brandVoice: "Professional, empathetic, calm and trustworthy.",
      guardrails:
        "Never diagnose, prescribe or give medical advice. For any health concern, encourage booking a consultation. Only offer appointment times the system says are open. Always collect name, phone, reason and preferred time.",
    },
    messages: {
      welcome:
        "Hello {first_name}! 🩺 Thanks for reaching out. Would you like to book a consultation or ask about our services? I'm here to help.",
      fallback:
        "Thank you {first_name}. 🙏 I can help you book a consultation — what would you like to be seen for, and when works for you?",
      away:
        "Thank you for your message! Our team is with patients right now. If you'd like to book a consultation, tell me the reason and a preferred time and I'll get you scheduled. 🩺",
    },
    faqStarters: [
      { question: "How do I book a consultation?", answer: "Just tell me the reason for your visit and your preferred day/time — I'll check availability and book you in. 🩺" },
      { question: "What are your hours?", answer: "I can share our clinic hours — would you like me to list them?" },
      { question: "Do you do online consultations?", answer: "Please message us your preference — I can note it and our team will confirm what's available." },
      { question: "Where are you located?", answer: "I can share our location and directions — would you like the map link?" },
    ],
  },

  fitness: {
    label: "Gym / Fitness / Coaching",
    emoji: "💪",
    tagline: "Book sessions, capture leads, grow your members.",
    goal: "bookings",
    features: { ...OFF, appointments: true, leadCapture: true },
    flowTemplateKey: "appointment",
    detectionHints: [
      "gym", "fitness", "trainer", "coach", "workout", "training",
      "yoga", "pilates", "crossfit", "bootcamp", "personal training",
      "membership", "class", "session", "nutrition", "transformation",
    ],
    slotDefaults: {
      slotMinutes: 60,
      bufferMinutes: 0,
      hours: DEFAULT_HOURS,
      services: [
        { name: "Free Trial Session", durationMinutes: 45, price: 0 },
        { name: "Personal Training", durationMinutes: 60, price: 0 },
        { name: "Consultation", durationMinutes: 30, price: 0 },
      ],
    },
    persona: {
      aiRole:
        "You are the assistant for a gym/fitness coach. You explain programs and pricing, capture interested leads, and book trial sessions or consultations.",
      brandVoice: "Motivating, energetic and encouraging.",
      guardrails:
        "Only offer session times the system says are open. Capture the person's name and contact when they show interest. Don't give specific medical or injury advice — recommend a consultation.",
    },
    messages: {
      welcome:
        "Hey {first_name}! 💪 Thanks for reaching out! Ready to get started? I can tell you about our programs or book you a trial session — what are your goals?",
      fallback:
        "Thanks {first_name}! 🙏 Let's get you moving — want to book a free trial session or hear about our plans?",
      away:
        "Thanks for the message! We're mid-session right now but I've got you. Want to book a free trial? Just tell me when works and I'll sort it! 💪",
    },
    faqStarters: [
      { question: "Do you offer a free trial?", answer: "Yes! Tell me a day/time that works and I'll book your free trial session. 💪" },
      { question: "How much is membership?", answer: "I can walk you through our plans — what are you looking to achieve? That way I'll recommend the best fit." },
      { question: "What are your class timings?", answer: "I can share our class schedule — want me to list what's coming up?" },
      { question: "Do you do online coaching?", answer: "We do! Message me your goals and I'll explain how our online coaching works." },
    ],
  },

  real_estate: {
    label: "Real Estate",
    emoji: "🏠",
    tagline: "Qualify buyers & renters, capture serious leads.",
    goal: "leads",
    features: { ...OFF, leadCapture: true, appointments: true },
    flowTemplateKey: "real_estate",
    detectionHints: [
      "real estate", "property", "properties", "realtor", "rent", "buy",
      "sale", "apartment", "house", "flat", "villa", "plot", "listing",
      "agent", "broker", "mortgage", "viewing", "lease",
    ],
    slotDefaults: {
      slotMinutes: 45,
      bufferMinutes: 15,
      hours: DEFAULT_HOURS,
      services: [
        { name: "Property Viewing", durationMinutes: 45, price: 0 },
        { name: "Consultation", durationMinutes: 30, price: 0 },
      ],
    },
    persona: {
      aiRole:
        "You are a real-estate assistant. You qualify whether someone wants to buy, rent or sell, capture their budget, area and requirements, and book property viewings.",
      brandVoice: "Professional, helpful and consultative.",
      guardrails:
        "Always find out intent (buy/rent/sell), budget and preferred area. Capture name and contact for follow-up. Only offer viewing times the system says are open.",
    },
    messages: {
      welcome:
        "Hi {first_name}! 🏠 Thanks for your interest! Are you looking to buy, rent, or sell? Tell me a bit about what you need and I'll help you out.",
      fallback:
        "Thanks {first_name}! 🙏 To find the right match — are you looking to buy or rent, and which area/budget are you thinking?",
      away:
        "Thanks for reaching out! Our agents are with clients right now. Tell me if you're looking to buy, rent or sell and your budget/area — I'll pass it on and someone will follow up. 🏠",
    },
    faqStarters: [
      { question: "Do you have properties in my budget?", answer: "Tell me your budget and preferred area and I'll match you with the best options we have. 🏠" },
      { question: "Can I book a viewing?", answer: "Absolutely! Let me know the property and a time that suits you and I'll arrange the viewing." },
      { question: "Do you help with selling?", answer: "Yes! Share a few details about your property and our team will get back to you with a valuation." },
      { question: "Are there any rentals available?", answer: "Yes — tell me your budget, area and move-in date and I'll show you what's available." },
    ],
  },

  professional_services: {
    label: "Professional Services / Agency",
    emoji: "💼",
    tagline: "Capture leads & book consultations for your firm.",
    goal: "leads",
    features: { ...OFF, leadCapture: true, appointments: true },
    flowTemplateKey: "lead_qualification",
    detectionHints: [
      "agency", "consulting", "consultant", "marketing", "design",
      "developer", "freelance", "law", "legal", "lawyer", "accounting",
      "accountant", "services", "studio", "b2b", "solutions", "firm",
    ],
    slotDefaults: {
      slotMinutes: 30,
      bufferMinutes: 10,
      hours: DEFAULT_HOURS,
      services: [
        { name: "Discovery Call", durationMinutes: 30, price: 0 },
        { name: "Consultation", durationMinutes: 45, price: 0 },
      ],
    },
    persona: {
      aiRole:
        "You are the assistant for a professional-services firm/agency. You understand what the prospect needs, capture their details, and book a discovery call.",
      brandVoice: "Professional, sharp and confident.",
      guardrails:
        "Qualify the prospect's need and budget where natural. Capture name and contact. Only offer call times the system says are open. Don't over-promise deliverables or pricing.",
    },
    messages: {
      welcome:
        "Hi {first_name}! 💼 Thanks for reaching out! Tell me a bit about what you're looking for and I'll point you in the right direction — or book you a quick call.",
      fallback:
        "Thanks {first_name}! 🙏 So I can help best — what are you looking to get done, and would a quick discovery call work?",
      away:
        "Thanks for your message! The team is heads-down right now, but I've noted it. Share what you need and your contact, and we'll follow up — or I can book you a discovery call. 💼",
    },
    faqStarters: [
      { question: "What services do you offer?", answer: "I can walk you through what we do — tell me a bit about your project and I'll explain how we can help. 💼" },
      { question: "How much do you charge?", answer: "Pricing depends on scope — the best next step is a quick discovery call. Want me to book one?" },
      { question: "Can we schedule a call?", answer: "Absolutely! Tell me a day/time that works and I'll set up a discovery call." },
      { question: "How long does a project take?", answer: "It varies by scope — let's get on a quick call and we'll give you a clear timeline." },
    ],
  },

  education: {
    label: "Education / Tutoring / Courses",
    emoji: "🎓",
    tagline: "Enroll students, book demos, answer course questions.",
    goal: "leads",
    features: { ...OFF, leadCapture: true, appointments: true },
    flowTemplateKey: "lead_qualification",
    detectionHints: [
      "academy", "school", "course", "class", "tutor", "tutoring",
      "coaching", "education", "learn", "training", "lesson", "student",
      "enroll", "admission", "workshop", "bootcamp", "institute",
    ],
    slotDefaults: {
      slotMinutes: 45,
      bufferMinutes: 10,
      hours: DEFAULT_HOURS,
      services: [
        { name: "Free Demo Class", durationMinutes: 45, price: 0 },
        { name: "Counselling Session", durationMinutes: 30, price: 0 },
      ],
    },
    persona: {
      aiRole:
        "You are the admissions assistant for an education provider. You explain courses and fees, capture interested students, and book demo classes or counselling sessions.",
      brandVoice: "Encouraging, clear and supportive.",
      guardrails:
        "Capture the student's name, contact and the course they're interested in. Only offer demo/counselling times the system says are open. Be accurate about course details.",
    },
    messages: {
      welcome:
        "Hi {first_name}! 🎓 Thanks for your interest! Which course or program are you curious about? I can share details or book you a free demo class.",
      fallback:
        "Thanks {first_name}! 🙏 Which course are you interested in? I can share the details and even book you a free demo.",
      away:
        "Thanks for reaching out! Our team is in class right now. Tell me which course you're interested in and your contact, and we'll follow up — or I can book you a free demo. 🎓",
    },
    faqStarters: [
      { question: "What courses do you offer?", answer: "I can share our full course list — is there a subject or skill you're most interested in? 🎓" },
      { question: "How much are the fees?", answer: "Fees depend on the course — tell me which one and I'll share the details, or book you a free demo." },
      { question: "Can I get a free demo class?", answer: "Yes! Tell me a day/time that suits you and I'll book your free demo class." },
      { question: "Do you offer online classes?", answer: "We do! Let me know your preference and I'll explain how our online classes work." },
    ],
  },

  automotive: {
    label: "Automotive / Car Services",
    emoji: "🚗",
    tagline: "Book services, quote repairs, answer car owners.",
    goal: "bookings",
    features: { ...OFF, appointments: true, leadCapture: true, catalog: true },
    flowTemplateKey: "appointment",
    detectionHints: [
      "car", "auto", "automotive", "vehicle", "garage", "mechanic",
      "repair", "service", "tyre", "tire", "detailing", "wash",
      "workshop", "spare parts", "dealership", "motor", "bike",
    ],
    slotDefaults: {
      slotMinutes: 60,
      bufferMinutes: 15,
      hours: DEFAULT_HOURS,
      services: [
        { name: "General Service", durationMinutes: 90, price: 0 },
        { name: "Inspection / Diagnostics", durationMinutes: 45, price: 0 },
        { name: "Car Wash / Detailing", durationMinutes: 60, price: 0 },
      ],
    },
    persona: {
      aiRole:
        "You are the service assistant for an automotive workshop. You answer questions about services and parts, give rough guidance, and book service appointments.",
      brandVoice: "Straightforward, honest and helpful.",
      guardrails:
        "Don't give exact repair quotes without an inspection — book the car in instead. Only offer service times the system says are open. Collect the customer's name, phone, vehicle and issue.",
    },
    messages: {
      welcome:
        "Hi {first_name}! 🚗 Thanks for reaching out! What can we help with — a service, a repair, or a question? Tell me about your vehicle.",
      fallback:
        "Thanks {first_name}! 🙏 Tell me your vehicle and the issue, and I'll book you in for a look.",
      away:
        "Thanks for the message! The team's in the workshop right now. Tell me your vehicle and what's needed, and I'll book you in or have someone follow up. 🚗",
    },
    faqStarters: [
      { question: "How do I book a service?", answer: "Tell me your vehicle and what's needed, plus a preferred day/time, and I'll book you in. 🚗" },
      { question: "How much is a service?", answer: "It depends on the vehicle and work — the best next step is to book an inspection so we can quote accurately." },
      { question: "Do you have spare parts?", answer: "Tell me the part and your vehicle model and I'll check availability for you." },
      { question: "Where are you located?", answer: "I can share our workshop location and directions — want the map link?" },
    ],
  },

  hospitality: {
    label: "Hotel / Travel / Hospitality",
    emoji: "🏨",
    tagline: "Handle bookings & enquiries, capture guests.",
    goal: "bookings",
    features: {
      ...OFF,
      reservations: true,
      leadCapture: true,
      hotelBookings: true,
      transfers: true,
    },
    flowTemplateKey: "restaurant",
    detectionHints: [
      "hotel", "resort", "guesthouse", "hostel", "travel", "tour",
      "trip", "booking", "stay", "room", "vacation", "holiday",
      "airbnb", "bnb", "lodge", "accommodation", "tourism",
    ],
    persona: {
      aiRole:
        "You are the reservations assistant for a hotel/travel business. You answer questions about rooms, rates, availability and amenities, and capture booking enquiries.",
      brandVoice: "Warm, gracious and welcoming.",
      guardrails:
        "For bookings, collect check-in/out dates, number of guests and room preference. Be accurate about rates and availability, and pass complex requests to the team.",
    },
    messages: {
      welcome:
        "Hello {first_name}! 🏨 Thanks for reaching out! Are you looking to book a stay or ask about our rooms and rates? I'm happy to help.",
      fallback:
        "Thank you {first_name}! 🙏 For your booking — what dates are you thinking, and how many guests?",
      away:
        "Thank you for your message! Our front desk is busy right now. Share your dates and number of guests and I'll note your enquiry so we can confirm availability. 🏨",
    },
    faqStarters: [
      { question: "Do you have rooms available?", answer: "Tell me your check-in and check-out dates and number of guests, and I'll check availability for you. 🏨" },
      { question: "What are your rates?", answer: "Rates vary by room and season — share your dates and I'll give you the details." },
      { question: "What amenities do you offer?", answer: "I can list our amenities — is there anything specific you'd like to know about?" },
      { question: "Where are you located?", answer: "I can share our location and directions — would you like the map link?" },
    ],
  },

  events: {
    label: "Events / Photography / Catering",
    emoji: "🎉",
    tagline: "Capture event leads, quote packages, book dates.",
    goal: "leads",
    features: { ...OFF, leadCapture: true, appointments: true },
    flowTemplateKey: "lead_qualification",
    detectionHints: [
      "event", "events", "wedding", "photography", "photographer",
      "videographer", "catering", "party", "planner", "decor",
      "venue", "booking", "shoot", "celebration", "dj", "band",
    ],
    slotDefaults: {
      slotMinutes: 45,
      bufferMinutes: 15,
      hours: DEFAULT_HOURS,
      services: [
        { name: "Consultation Call", durationMinutes: 30, price: 0 },
        { name: "Venue / Package Discussion", durationMinutes: 45, price: 0 },
      ],
    },
    persona: {
      aiRole:
        "You are the assistant for an events/photography/catering business. You capture the event type, date, guest count and budget, and book a consultation.",
      brandVoice: "Excited, warm and detail-oriented.",
      guardrails:
        "Always capture event type, date and rough guest count/budget. Don't lock in a final quote without a consultation. Only offer consultation times the system says are open.",
    },
    messages: {
      welcome:
        "Hi {first_name}! 🎉 Thanks for reaching out — exciting! Tell me about your event (type, date, size) and I'll share how we can make it special.",
      fallback:
        "Thanks {first_name}! 🙏 To help plan — what's the event, the date, and roughly how many guests?",
      away:
        "Thanks so much for reaching out! We're on a shoot/event right now. Share your event type, date and size and we'll follow up with the perfect package. 🎉",
    },
    faqStarters: [
      { question: "Are you available on my date?", answer: "Tell me your event date and type and I'll check our availability right away! 🎉" },
      { question: "What packages do you offer?", answer: "We have packages for different event sizes and budgets — tell me about your event and I'll recommend the best fit." },
      { question: "How much do you charge?", answer: "Pricing depends on the event — share the date, type and guest count and I'll get you a tailored quote." },
      { question: "Can we book a consultation?", answer: "Absolutely! Tell me a day/time that works and I'll book a consultation call." },
    ],
  },

  general: {
    label: "Something Else / General",
    emoji: "💬",
    tagline: "A smart assistant tailored to your business.",
    goal: "support",
    features: { ...OFF, leadCapture: true },
    flowTemplateKey: "general_faq",
    detectionHints: [],
    persona: {
      aiRole:
        "You are a friendly, professional assistant for this business. You answer customer questions accurately, help them with what they need, and capture leads when someone shows real interest.",
      brandVoice: "Warm, professional and helpful.",
      guardrails:
        "Only use the business information provided — never invent facts. When unsure, offer to take the customer's details so the team can follow up.",
    },
    messages: {
      welcome:
        "Hey {first_name}! 👋 Thanks so much for reaching out. How can I help you today?",
      fallback:
        "Thanks {first_name}! 🙏 Tell me a little more about what you need and I'll do my best to help.",
      away:
        "Thanks for reaching out! We're away right now but we've got your message and will reply as soon as we're back. In the meantime, ask me anything! 🙌",
    },
    faqStarters: [
      { question: "What do you offer?", answer: "I'd be happy to explain! Tell me what you're looking for and I'll point you in the right direction." },
      { question: "How can I contact you?", answer: "You're in the right place — just message us here and we'll help you out!" },
      { question: "What are your hours?", answer: "I can share our hours — would you like me to list them?" },
      { question: "Where are you located?", answer: "I can share our location and directions — want the map link?" },
    ],
  },
};

/** All valid vertical keys, in picker order. */
const VERTICAL_KEYS = Object.keys(PACKS);

/** Look up a pack, falling back to `general` for unknown/`other`. */
function getPack(key) {
  return PACKS[key] || PACKS.general;
}

/** Does this vertical use the appointment scheduler? */
function usesAppointments(key) {
  return !!getPack(key).features.appointments;
}

/**
 * Client-safe list for the onboarding picker — no persona/prompt internals,
 * just what the UI needs to render the grid.
 */
function pickerList() {
  return VERTICAL_KEYS.map((key) => ({
    key,
    label: PACKS[key].label,
    emoji: PACKS[key].emoji,
    tagline: PACKS[key].tagline,
    features: PACKS[key].features,
  }));
}

module.exports = {
  PACKS,
  VERTICAL_KEYS,
  DEFAULT_HOURS,
  getPack,
  usesAppointments,
  pickerList,
};
