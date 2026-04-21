import { create } from "zustand";

export const useInboxStore = create((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: {}, // { [conversationId]: Message[] }
  loading: false,

  setConversations: (conversations) => set({ conversations }),
  setActiveConversation: (id) => set({ activeConversationId: id }),

  addOrUpdateConversation: (conv) => {
    set((s) => {
      const idx = s.conversations.findIndex((c) => c._id === conv._id);
      if (idx >= 0) {
        const updated = [...s.conversations];
        updated[idx] = { ...updated[idx], ...conv };
        return { conversations: updated };
      }
      return { conversations: [conv, ...s.conversations] };
    });
  },

  setMessages: (conversationId, messages) => {
    set((s) => ({ messages: { ...s.messages, [conversationId]: messages } }));
  },

  appendMessage: (conversationId, message) => {
    set((s) => {
      const current = s.messages[conversationId] || [];
      // Avoid duplicates
      if (current.find((m) => m._id === message._id)) return s;
      return {
        messages: { ...s.messages, [conversationId]: [...current, message] },
      };
    });
  },
}));
