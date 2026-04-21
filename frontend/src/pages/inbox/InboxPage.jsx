import { useEffect, useRef, useState } from "react";
import api from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { useInboxStore } from "@/store/inboxStore";
import { getSocket, initSocket } from "@/services/socket";
import toast from "react-hot-toast";
import {
  Send,
  Bot,
  User,
  UserCheck,
  CheckCheck,
  ChevronRight,
  Search,
  Filter,
} from "lucide-react";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
dayjs.extend(relativeTime);

export default function InboxPage() {
  const { activeWorkspace } = useAuthStore();
  const {
    conversations,
    activeConversationId,
    messages,
    setConversations,
    setActiveConversation,
    addOrUpdateConversation,
    setMessages,
    appendMessage,
  } = useInboxStore();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"); // all | bot_active | awaiting_human | human_active
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);

  const activeConv = conversations.find((c) => c._id === activeConversationId);
  const activeMessages = messages[activeConversationId] || [];

  useEffect(() => {
    loadConversations();
    const socket = initSocket();
    socket.on("message:new", ({ conversation, message }) => {
      addOrUpdateConversation(conversation);
      if (conversation._id === activeConversationId)
        appendMessage(conversation._id, message);
    });
    socket.on("conversation:updated", (conv) => addOrUpdateConversation(conv));
    return () => {
      socket.off("message:new");
      socket.off("conversation:updated");
    };
  }, [activeWorkspace]);

  useEffect(() => {
    if (activeConversationId) loadMessages(activeConversationId);
  }, [activeConversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMessages]);

  const loadConversations = async () => {
    try {
      const { data } = await api.get("/inbox/conversations");
      setConversations(data.conversations || []);
    } catch (err) {
      console.error(err);
    }
  };

  const loadMessages = async (convId) => {
    try {
      const { data } = await api.get(`/inbox/conversations/${convId}/messages`);
      setMessages(convId, data.messages || []);
    } catch (err) {
      console.error(err);
    }
  };

  const takeover = async () => {
    try {
      await api.post(`/inbox/conversations/${activeConversationId}/takeover`);
      toast.success("You took over this conversation");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed");
    }
  };

  const resolve = async () => {
    try {
      await api.post(`/inbox/conversations/${activeConversationId}/resolve`);
      toast.success("Conversation resolved");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed");
    }
  };

  const sendReply = async () => {
    if (!replyText.trim() || !activeConversationId) return;
    setSending(true);
    try {
      const { data } = await api.post(
        `/inbox/conversations/${activeConversationId}/messages`,
        { text: replyText },
      );
      appendMessage(activeConversationId, data.message);
      setReplyText("");
    } catch (err) {
      toast.error("Failed to send");
    } finally {
      setSending(false);
    }
  };

  const filtered = conversations.filter((c) => {
    const matchFilter = filter === "all" || c.status === filter;
    const matchSearch =
      !search ||
      c.contact?.name?.toLowerCase().includes(search.toLowerCase()) ||
      c.contact?.phone?.includes(search);
    return matchFilter && matchSearch;
  });

  return (
    <div className="flex h-full">
      {/* Conversations list */}
      <div className="w-72 flex-shrink-0 border-r border-gray-100 bg-white flex flex-col">
        <div className="p-3 border-b border-gray-100 space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              className="input pl-8 text-xs"
              placeholder="Search conversations…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {[
              "all",
              "bot_active",
              "awaiting_human",
              "human_active",
              "resolved",
            ].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex-shrink-0 px-2 py-1 rounded text-xs font-medium border transition ${filter === f ? "bg-brand-50 border-brand-300 text-brand-700" : "border-gray-200 text-gray-500 hover:bg-gray-50"}`}
              >
                {f === "all"
                  ? "All"
                  : f
                      .replace(/_/g, " ")
                      .replace(/\b\w/g, (c) => c.toUpperCase())}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map((conv) => (
            <button
              key={conv._id}
              onClick={() => setActiveConversation(conv._id)}
              className={`w-full text-left p-3 border-b border-gray-50 hover:bg-gray-50 transition ${activeConversationId === conv._id ? "bg-brand-50 border-l-2 border-l-brand-500" : ""}`}
            >
              <div className="flex items-start gap-2">
                <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-semibold text-gray-600">
                  {conv.contact?.name?.[0]?.toUpperCase() || "?"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-gray-800 truncate">
                      {conv.contact?.name || conv.contact?.phone || "Unknown"}
                    </p>
                    <span className="text-xs text-gray-400 flex-shrink-0 ml-1">
                      {dayjs(conv.updatedAt).fromNow(true)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 truncate mt-0.5">
                    {conv.lastMessage?.text || "…"}
                  </p>
                  <StatusBadge status={conv.status} />
                </div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-8">
              No conversations
            </p>
          )}
        </div>
      </div>

      {/* Chat panel */}
      {activeConv ? (
        <div className="flex-1 flex flex-col">
          {/* Chat header */}
          <div className="h-14 bg-white border-b border-gray-100 flex items-center justify-between px-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-xs font-semibold text-gray-600">
                {activeConv.contact?.name?.[0]?.toUpperCase() || "?"}
              </div>
              <div>
                <p className="font-semibold text-sm text-gray-800">
                  {activeConv.contact?.name || activeConv.contact?.phone}
                </p>
                <StatusBadge status={activeConv.status} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              {activeConv.status !== "human_active" && (
                <button
                  onClick={takeover}
                  className="btn-secondary text-xs gap-1"
                >
                  <UserCheck className="w-3 h-3" />
                  Take over
                </button>
              )}
              {activeConv.status !== "resolved" && (
                <button
                  onClick={resolve}
                  className="btn text-xs bg-gray-100 text-gray-600 hover:bg-gray-200 gap-1"
                >
                  <CheckCheck className="w-3 h-3" />
                  Resolve
                </button>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
            {activeMessages.map((msg) => (
              <MessageBubble key={msg._id} msg={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Reply box */}
          <div className="bg-white border-t border-gray-100 p-3 flex items-end gap-3">
            <textarea
              className="input resize-none flex-1 text-sm"
              rows={2}
              placeholder="Type a message…"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendReply();
                }
              }}
            />
            <button
              onClick={sendReply}
              disabled={sending || !replyText.trim()}
              className="btn-primary px-3 py-2"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-center">
          <div>
            <div className="text-4xl mb-3">💬</div>
            <p className="text-gray-500 text-sm">
              Select a conversation to view messages
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const MAP = {
    bot_active: ["badge-green", "Bot Active"],
    awaiting_human: ["badge-yellow", "Waiting"],
    human_active: ["badge-blue", "Agent Active"],
    resolved: ["badge-gray", "Resolved"],
  };
  const [cls, label] = MAP[status] || ["badge-gray", status];
  return <span className={`${cls} badge mt-0.5`}>{label}</span>;
}

function MessageBubble({ msg }) {
  const isOutbound = msg.direction === "outbound";
  const isNote = msg.isInternalNote;
  if (isNote)
    return (
      <div className="flex justify-center">
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 text-xs rounded-lg px-3 py-1.5 max-w-[70%] text-center">
          📝 {msg.text}
        </div>
      </div>
    );
  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[70%] rounded-2xl px-3.5 py-2.5 text-sm ${isOutbound ? "bg-brand-600 text-white rounded-br-sm" : "bg-white text-gray-800 border border-gray-100 rounded-bl-sm shadow-sm"}`}
      >
        {msg.type === "image" && msg.mediaUrl && (
          <img
            src={msg.mediaUrl}
            alt=""
            className="rounded-lg max-w-full mb-1"
          />
        )}
        <p className="leading-relaxed">{msg.text || msg.caption || ""}</p>
        <p
          className={`text-xs mt-1 ${isOutbound ? "text-brand-200" : "text-gray-400"}`}
        >
          {dayjs(msg.createdAt).format("h:mm A")}
        </p>
      </div>
    </div>
  );
}
