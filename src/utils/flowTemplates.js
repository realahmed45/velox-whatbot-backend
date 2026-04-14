/**
 * Pre-built Flow Templates for 5 industries
 * Each template contains ready-to-use nodes and edges
 */
const FLOW_TEMPLATES = [
  {
    key: "restaurant",
    name: "Restaurant / Food Delivery",
    description:
      "Welcome message, menu sharing, reservation booking, order status, closing hours",
    icon: "🍽️",
    keyFlows: ["Welcome + Menu", "Reservation Booking", "Order Status"],
    estimatedDailyMessages: "40–80",
    flows: [
      {
        name: "Welcome & Menu",
        description: "Greet new customers and share the menu",
        priority: 10,
        nodes: [
          {
            id: "trigger-1",
            type: "trigger",
            nodeType: "first_message",
            position: { x: 250, y: 50 },
            data: { label: "First Message" },
          },
          {
            id: "action-1",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 180 },
            data: {
              label: "Welcome Message",
              message:
                "Assalamoalaikum! 👋 Welcome to *{{businessName}}*!\n\nWe're happy you reached out. How can we help you today?\n\nReply with a number:\n1️⃣ View Menu\n2️⃣ Book a Table\n3️⃣ Order Status\n4️⃣ Talk to us",
            },
          },
          {
            id: "action-2",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 340 },
            data: {
              label: "Capture Choice",
              questionText: "Please reply with 1, 2, 3, or 4 👆",
              variableName: "menuChoice",
              questionTimeout: 300,
            },
          },
          {
            id: "action-3",
            type: "action",
            nodeType: "tag_contact",
            position: { x: 250, y: 500 },
            data: { label: "Tag as Lead", tagName: "lead" },
          },
          {
            id: "action-4",
            type: "action",
            nodeType: "end_flow",
            position: { x: 250, y: 640 },
            data: { label: "End" },
          },
        ],
        edges: [
          { id: "e1", source: "trigger-1", target: "action-1" },
          { id: "e2", source: "action-1", target: "action-2" },
          { id: "e3", source: "action-2", target: "action-3" },
          { id: "e4", source: "action-3", target: "action-4" },
        ],
      },
      {
        name: "Reservation Booking",
        description: "Collect reservation details from customer",
        priority: 5,
        nodes: [
          {
            id: "t1",
            type: "trigger",
            nodeType: "keyword_match",
            position: { x: 250, y: 50 },
            data: {
              label: "Reservation Keywords",
              keywords: [
                "book",
                "reserve",
                "table",
                "booking",
                "reservation",
                "2",
              ],
              matchType: "contains",
            },
          },
          {
            id: "a1",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 180 },
            data: {
              label: "Great!",
              message:
                "Great! Let's book your table 🍽️\n\nI'll need a few details.",
            },
          },
          {
            id: "a2",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 320 },
            data: {
              label: "Ask Name",
              questionText: "What's your name?",
              variableName: "customerName",
            },
          },
          {
            id: "a3",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 460 },
            data: {
              label: "Ask Party Size",
              questionText: "How many people? 👥",
              variableName: "partySize",
            },
          },
          {
            id: "a4",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 600 },
            data: {
              label: "Ask Date/Time",
              questionText: "Preferred date and time? (e.g. Tomorrow 7pm)",
              variableName: "reservationDateTime",
            },
          },
          {
            id: "a5",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 740 },
            data: {
              label: "Confirm",
              message:
                "✅ Perfect! Reservation request received:\n\n👤 Name: {{customerName}}\n👥 Party: {{partySize}} people\n📅 Time: {{reservationDateTime}}\n\nWe'll confirm shortly. See you soon!",
            },
          },
          {
            id: "a6",
            type: "action",
            nodeType: "tag_contact",
            position: { x: 250, y: 880 },
            data: { label: "Tag Reservation", tagName: "reservation" },
          },
          {
            id: "a7",
            type: "action",
            nodeType: "assign_agent",
            position: { x: 250, y: 1020 },
            data: { label: "Notify Staff" },
          },
        ],
        edges: [
          { id: "e1", source: "t1", target: "a1" },
          { id: "e2", source: "a1", target: "a2" },
          { id: "e3", source: "a2", target: "a3" },
          { id: "e4", source: "a3", target: "a4" },
          { id: "e5", source: "a4", target: "a5" },
          { id: "e6", source: "a5", target: "a6" },
          { id: "e7", source: "a6", target: "a7" },
        ],
      },
    ],
  },
  {
    key: "beauty_salon",
    name: "Beauty Salon / Clinic",
    description:
      "Services list, appointment booking wizard, price enquiry, reminders",
    icon: "💅",
    keyFlows: ["Welcome + Services", "Appointment Booking", "Price Enquiry"],
    estimatedDailyMessages: "30–60",
    flows: [
      {
        name: "Welcome & Services",
        priority: 10,
        nodes: [
          {
            id: "t1",
            type: "trigger",
            nodeType: "first_message",
            position: { x: 250, y: 50 },
            data: { label: "First Message" },
          },
          {
            id: "a1",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 180 },
            data: {
              label: "Welcome",
              message:
                "Hi there! 💅 Welcome to *{{businessName}}*!\n\nHow can we help you today?\n\n1️⃣ Book an Appointment\n2️⃣ View Services & Prices\n3️⃣ Check Availability\n4️⃣ Talk to us",
            },
          },
          {
            id: "a2",
            type: "action",
            nodeType: "tag_contact",
            position: { x: 250, y: 340 },
            data: { label: "Tag Lead", tagName: "lead" },
          },
          {
            id: "a3",
            type: "action",
            nodeType: "end_flow",
            position: { x: 250, y: 480 },
            data: { label: "End" },
          },
        ],
        edges: [
          { id: "e1", source: "t1", target: "a1" },
          { id: "e2", source: "a1", target: "a2" },
          { id: "e3", source: "a2", target: "a3" },
        ],
      },
      {
        name: "Appointment Booking",
        priority: 5,
        nodes: [
          {
            id: "t1",
            type: "trigger",
            nodeType: "keyword_match",
            position: { x: 250, y: 50 },
            data: {
              label: "Booking Keywords",
              keywords: ["book", "appointment", "appoint", "available", "1"],
              matchType: "contains",
            },
          },
          {
            id: "a1",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 180 },
            data: {
              label: "Ask Name",
              questionText: "Sure! What's your name? 😊",
              variableName: "customerName",
            },
          },
          {
            id: "a2",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 320 },
            data: {
              label: "Ask Service",
              questionText:
                "Which service are you interested in?\n(e.g. Hair color, Facial, Nails)",
              variableName: "serviceType",
            },
          },
          {
            id: "a3",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 460 },
            data: {
              label: "Ask Date",
              questionText:
                "When would you like to come? 📅\n(e.g. Saturday 3pm)",
              variableName: "preferredDateTime",
            },
          },
          {
            id: "a4",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 600 },
            data: {
              label: "Confirm",
              message:
                "✅ Appointment request received!\n\n👤 {{customerName}}\n💄 Service: {{serviceType}}\n📅 Preferred: {{preferredDateTime}}\n\nWe'll confirm availability shortly!",
            },
          },
          {
            id: "a5",
            type: "action",
            nodeType: "tag_contact",
            position: { x: 250, y: 740 },
            data: { label: "Tag", tagName: "appointment_pending" },
          },
          {
            id: "a6",
            type: "action",
            nodeType: "assign_agent",
            position: { x: 250, y: 880 },
            data: { label: "Notify Receptionist" },
          },
        ],
        edges: [
          { id: "e1", source: "t1", target: "a1" },
          { id: "e2", source: "a1", target: "a2" },
          { id: "e3", source: "a2", target: "a3" },
          { id: "e4", source: "a3", target: "a4" },
          { id: "e5", source: "a4", target: "a5" },
          { id: "e6", source: "a5", target: "a6" },
        ],
      },
    ],
  },
  {
    key: "retail",
    name: "Retail / Clothing Shop",
    description: "Product availability, pricing, order tracking, store hours",
    icon: "🛍️",
    keyFlows: ["Welcome + Categories", "Product Enquiry", "Order Status"],
    estimatedDailyMessages: "50–100",
    flows: [
      {
        name: "Welcome & Shop",
        priority: 10,
        nodes: [
          {
            id: "t1",
            type: "trigger",
            nodeType: "first_message",
            position: { x: 250, y: 50 },
            data: { label: "First Message" },
          },
          {
            id: "a1",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 180 },
            data: {
              label: "Welcome",
              message:
                "Welcome to *{{businessName}}* 🛍️\n\nWhat are you looking for today?\n\n1️⃣ Browse Products\n2️⃣ Check Price\n3️⃣ Track My Order\n4️⃣ Store Hours\n5️⃣ Talk to us",
            },
          },
          {
            id: "a2",
            type: "action",
            nodeType: "tag_contact",
            position: { x: 250, y: 340 },
            data: { label: "Tag Lead", tagName: "lead" },
          },
          {
            id: "a3",
            type: "action",
            nodeType: "end_flow",
            position: { x: 250, y: 480 },
            data: { label: "End" },
          },
        ],
        edges: [
          { id: "e1", source: "t1", target: "a1" },
          { id: "e2", source: "a1", target: "a2" },
          { id: "e3", source: "a2", target: "a3" },
        ],
      },
      {
        name: "Product Enquiry",
        priority: 5,
        nodes: [
          {
            id: "t1",
            type: "trigger",
            nodeType: "keyword_match",
            position: { x: 250, y: 50 },
            data: {
              label: "Product Keywords",
              keywords: [
                "price",
                "available",
                "stock",
                "cost",
                "kya price",
                "kitna",
                "1",
                "2",
              ],
              matchType: "contains",
            },
          },
          {
            id: "a1",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 180 },
            data: {
              label: "Ask Product",
              questionText:
                'Sure! Which product are you looking for? 🔍\n\nPlease describe it (e.g. "black kurta size M")',
              variableName: "productInterest",
            },
          },
          {
            id: "a2",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 320 },
            data: {
              label: "Ask Name",
              questionText: "And your name please?",
              variableName: "customerName",
            },
          },
          {
            id: "a3",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 460 },
            data: {
              label: "Hand off",
              message:
                "Thanks {{customerName}}! 🙏\n\nYou're looking for: *{{productInterest}}*\n\nOne of our team members will check availability and get back to you within a few minutes!",
            },
          },
          {
            id: "a4",
            type: "action",
            nodeType: "tag_contact",
            position: { x: 250, y: 600 },
            data: { label: "Tag Interested", tagName: "interested" },
          },
          {
            id: "a5",
            type: "action",
            nodeType: "assign_agent",
            position: { x: 250, y: 740 },
            data: { label: "Notify Staff" },
          },
        ],
        edges: [
          { id: "e1", source: "t1", target: "a1" },
          { id: "e2", source: "a1", target: "a2" },
          { id: "e3", source: "a2", target: "a3" },
          { id: "e4", source: "a3", target: "a4" },
          { id: "e5", source: "a4", target: "a5" },
        ],
      },
    ],
  },
  {
    key: "real_estate",
    name: "Real Estate Agent",
    description:
      "Property info, lead qualification (budget, area), schedule viewing",
    icon: "🏠",
    keyFlows: [
      "Welcome + Property Types",
      "Lead Qualification",
      "Schedule Viewing",
    ],
    estimatedDailyMessages: "20–40",
    flows: [
      {
        name: "Lead Qualification",
        priority: 10,
        nodes: [
          {
            id: "t1",
            type: "trigger",
            nodeType: "first_message",
            position: { x: 250, y: 50 },
            data: { label: "First Message" },
          },
          {
            id: "a1",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 180 },
            data: {
              label: "Welcome",
              message:
                "Assalamoalaikum! 🏠 Welcome to *{{businessName}}*\n\nLooking to buy, sell, or rent? I can help you find the perfect property.\n\nReply:\n🔑 *Buy* — Looking to purchase\n🏡 *Rent* — Looking to rent\n💰 *Sell* — Want to sell your property",
            },
          },
          {
            id: "a2",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 340 },
            data: {
              label: "Intent",
              questionText: "Buy, Rent, or Sell?",
              variableName: "propertyIntent",
            },
          },
          {
            id: "a3",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 480 },
            data: {
              label: "Budget",
              questionText:
                'What\'s your budget range?\n(e.g. "50 lac to 1 crore")',
              variableName: "budgetRange",
            },
          },
          {
            id: "a4",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 620 },
            data: {
              label: "Area",
              questionText:
                "Preferred area/location?\n(e.g. DHA Lahore, Bahria Town)",
              variableName: "preferredArea",
            },
          },
          {
            id: "a5",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 760 },
            data: {
              label: "Name",
              questionText: "Your name please?",
              variableName: "customerName",
            },
          },
          {
            id: "a6",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 900 },
            data: {
              label: "Summary",
              message:
                "✅ Got it, {{customerName}}!\n\n📋 *Your Requirements:*\n🔑 Intent: {{propertyIntent}}\n💰 Budget: {{budgetRange}}\n📍 Area: {{preferredArea}}\n\nOur property consultant will call you within 2 hours with matching listings!",
            },
          },
          {
            id: "a7",
            type: "action",
            nodeType: "tag_contact",
            position: { x: 250, y: 1040 },
            data: { label: "Tag Hot Lead", tagName: "hot_lead" },
          },
          {
            id: "a8",
            type: "action",
            nodeType: "assign_agent",
            position: { x: 250, y: 1180 },
            data: { label: "Assign to Agent" },
          },
        ],
        edges: [
          { id: "e1", source: "t1", target: "a1" },
          { id: "e2", source: "a1", target: "a2" },
          { id: "e3", source: "a2", target: "a3" },
          { id: "e4", source: "a3", target: "a4" },
          { id: "e5", source: "a4", target: "a5" },
          { id: "e6", source: "a5", target: "a6" },
          { id: "e7", source: "a6", target: "a7" },
          { id: "e8", source: "a7", target: "a8" },
        ],
      },
    ],
  },
  {
    key: "general_faq",
    name: "General FAQ",
    description:
      "Welcome, business hours, contact info, human handover fallback for any business",
    icon: "💬",
    keyFlows: ["Welcome", "Business Hours", "Human Handover"],
    estimatedDailyMessages: "10–30",
    flows: [
      {
        name: "Welcome & FAQ",
        priority: 10,
        nodes: [
          {
            id: "t1",
            type: "trigger",
            nodeType: "first_message",
            position: { x: 250, y: 50 },
            data: { label: "First Message" },
          },
          {
            id: "a1",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 180 },
            data: {
              label: "Welcome",
              message:
                "Hello! 👋 Welcome to *{{businessName}}*!\n\nHow can we help you?\n\n1️⃣ Business Hours\n2️⃣ Contact Info\n3️⃣ Talk to a Human",
            },
          },
          {
            id: "a2",
            type: "action",
            nodeType: "ask_question",
            position: { x: 250, y: 340 },
            data: {
              label: "Get Choice",
              questionText: "Reply with 1, 2, or 3",
              variableName: "faqChoice",
            },
          },
          {
            id: "a3",
            type: "action",
            nodeType: "end_flow",
            position: { x: 250, y: 480 },
            data: { label: "End" },
          },
        ],
        edges: [
          { id: "e1", source: "t1", target: "a1" },
          { id: "e2", source: "a1", target: "a2" },
          { id: "e3", source: "a2", target: "a3" },
        ],
      },
      {
        name: "Human Handover Fallback",
        priority: 0,
        nodes: [
          {
            id: "t1",
            type: "trigger",
            nodeType: "any_message",
            position: { x: 250, y: 50 },
            data: { label: "Any Message (Fallback)" },
          },
          {
            id: "a1",
            type: "action",
            nodeType: "send_text",
            position: { x: 250, y: 180 },
            data: {
              label: "Fallback Message",
              message:
                "Thanks for your message! 🙏\n\nOur team will get back to you shortly during business hours.",
            },
          },
          {
            id: "a2",
            type: "action",
            nodeType: "assign_agent",
            position: { x: 250, y: 320 },
            data: { label: "Assign to Human" },
          },
        ],
        edges: [
          { id: "e1", source: "t1", target: "a1" },
          { id: "e2", source: "a1", target: "a2" },
        ],
      },
    ],
  },
];

module.exports = { FLOW_TEMPLATES };
