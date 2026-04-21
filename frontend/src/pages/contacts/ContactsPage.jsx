import { useEffect, useState } from "react";
import api from "@/services/api";
import toast from "react-hot-toast";
import {
  Plus,
  Search,
  Download,
  Upload,
  Trash2,
  Tag,
  Phone,
  User,
  X,
} from "lucide-react";
import dayjs from "dayjs";

export default function ContactsPage() {
  const [contacts, setContacts] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // contact detail
  const [showAddModal, setShowAddModal] = useState(false);

  useEffect(() => {
    loadContacts();
  }, [page, search, tagFilter]);

  const loadContacts = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 20 });
      if (search) params.set("search", search);
      if (tagFilter) params.set("tag", tagFilter);
      const { data } = await api.get(`/contacts?${params}`);
      setContacts(data.contacts || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const exportCSV = async () => {
    try {
      const { data } = await api.get("/contacts/export", {
        responseType: "blob",
      });
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = "contacts.csv";
      a.click();
    } catch (err) {
      toast.error("Export failed");
    }
  };

  const deleteContact = async (id) => {
    if (!window.confirm("Delete this contact?")) return;
    try {
      await api.delete(`/contacts/${id}`);
      setContacts((c) => c.filter((x) => x._id !== id));
      if (selected?._id === id) setSelected(null);
      toast.success("Contact deleted");
    } catch (err) {
      toast.error("Delete failed");
    }
  };

  return (
    <div className="flex h-full">
      {/* Contact list */}
      <div className="flex-1 flex flex-col p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Contacts</h1>
            <p className="text-sm text-gray-500">{total} total contacts</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportCSV} className="btn-secondary text-sm gap-1">
              <Download className="w-3.5 h-3.5" />
              Export
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              className="btn-primary text-sm gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Contact
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              className="input pl-8 text-sm"
              placeholder="Search name or phone…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <input
            className="input text-sm w-32"
            placeholder="Filter by tag"
            value={tagFilter}
            onChange={(e) => {
              setTagFilter(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {/* Table */}
        <div className="card overflow-hidden flex-1">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Name
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Phone
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Tags
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Added
                  </th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Status
                  </th>
                  <th className="px-4 py-3 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {loading ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center py-8 text-gray-400 text-sm"
                    >
                      Loading…
                    </td>
                  </tr>
                ) : contacts.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center py-8 text-gray-400 text-sm"
                    >
                      No contacts found
                    </td>
                  </tr>
                ) : (
                  contacts.map((c) => (
                    <tr
                      key={c._id}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => setSelected(c)}
                    >
                      <td className="px-4 py-3 font-medium text-gray-800">
                        {c.name || "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">
                        {c.phone}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {c.tags?.slice(0, 3).map((t) => (
                            <span key={t} className="badge-blue badge">
                              {t}
                            </span>
                          ))}
                          {c.tags?.length > 3 && (
                            <span className="badge-gray badge">
                              +{c.tags.length - 3}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {dayjs(c.createdAt).format("D MMM YYYY")}
                      </td>
                      <td className="px-4 py-3">
                        {c.optedIn ? (
                          <span className="badge-green badge">Opted In</span>
                        ) : (
                          <span className="badge-gray badge">Opted Out</span>
                        )}
                      </td>
                      <td
                        className="px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => deleteContact(c._id)}
                          className="p-1 rounded text-gray-300 hover:text-red-500 hover:bg-red-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {/* Pagination */}
          {total > 20 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
              <p className="text-xs text-gray-500">
                Showing {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} of{" "}
                {total}
              </p>
              <div className="flex gap-2">
                <button
                  className="btn-secondary text-xs"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <button
                  className="btn-secondary text-xs"
                  disabled={page * 20 >= total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Contact detail panel */}
      {selected && (
        <ContactDetailPanel
          contact={selected}
          onClose={() => setSelected(null)}
          onUpdate={(updated) => {
            setContacts((c) =>
              c.map((x) => (x._id === updated._id ? updated : x)),
            );
            setSelected(updated);
          }}
        />
      )}

      {/* Add Contact Modal */}
      {showAddModal && (
        <AddContactModal
          onClose={() => setShowAddModal(false)}
          onAdded={(c) => {
            setContacts((cs) => [c, ...cs]);
            setShowAddModal(false);
          }}
        />
      )}
    </div>
  );
}

function ContactDetailPanel({ contact, onClose, onUpdate }) {
  const [form, setForm] = useState({
    name: contact.name || "",
    email: contact.email || "",
    tags: contact.tags?.join(", ") || "",
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put(`/contacts/${contact._id}`, {
        ...form,
        tags: form.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onUpdate(data.contact);
      toast.success("Saved");
    } catch (err) {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-80 flex-shrink-0 bg-white border-l border-gray-100 flex flex-col">
      <div className="h-14 flex items-center justify-between px-4 border-b border-gray-100">
        <h2 className="font-semibold text-gray-800">Contact Details</h2>
        <button
          onClick={onClose}
          className="p-1.5 rounded text-gray-400 hover:bg-gray-100"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="text-center pb-3 border-b border-gray-100">
          <div className="w-14 h-14 bg-brand-100 rounded-full flex items-center justify-center mx-auto mb-2 text-xl font-bold text-brand-700">
            {contact.name?.[0]?.toUpperCase() || "?"}
          </div>
          <p className="font-semibold text-gray-800">
            {contact.name || "Unknown"}
          </p>
          <p className="text-sm text-gray-400 font-mono">{contact.phone}</p>
        </div>
        <div>
          <label className="label">Name</label>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div>
          <label className="label">Email</label>
          <input
            className="input"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div>
          <label className="label">Tags (comma-separated)</label>
          <input
            className="input"
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
            placeholder="VIP, Lahore, New"
          />
        </div>
        <div>
          <p className="label">Opted In</p>
          <span
            className={
              contact.optedIn ? "badge-green badge" : "badge-red badge"
            }
          >
            {contact.optedIn ? "Yes" : "No"}
          </span>
        </div>
        <button onClick={save} disabled={saving} className="btn-primary w-full">
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function AddContactModal({ onClose, onAdded }) {
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    tags: "",
  });
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.phone) {
      toast.error("Phone required");
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post("/contacts", {
        ...form,
        tags: form.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onAdded(data.contact);
      toast.success("Contact added");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-gray-800">Add Contact</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:bg-gray-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label">Phone number *</label>
            <input
              className="input"
              placeholder="923001234567"
              required
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Name</label>
            <input
              className="input"
              placeholder="Ahmed Ali"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              placeholder="ahmed@example.com"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Tags (comma-separated)</label>
            <input
              className="input"
              placeholder="VIP, Lahore"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
            />
          </div>
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary flex-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary flex-1"
              disabled={loading}
            >
              {loading ? "Adding…" : "Add Contact"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
