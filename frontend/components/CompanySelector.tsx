/**
 * CompanySelector – Search, select, or create a Twenty CRM company for a meeting.
 *
 * 3 states:
 *  1. No company linked → search input
 *  2. Searching → debounced dropdown with results + "New company" button
 *  3. Company selected → name chip with change option
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  createCompany,
  linkMeetingToCompany,
  searchCompanies,
  type CrmCompany,
} from "@/lib/api";
import { colors, spacing, radius } from "@/lib/theme";

interface Props {
  meetingId: string;
  companyId: string | null;
  companyName: string | null;
  onLinked: (companyId: string, companyName: string, crmNoteCreated: boolean) => void;
}

export default function CompanySelector({
  meetingId,
  companyId,
  companyName,
  onLinked,
}: Props) {
  const [mode, setMode] = useState<"display" | "search" | "create">(
    companyId ? "display" : "search"
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CrmCompany[]>([]);
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // New company form
  const [newName, setNewName] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");

  // Sync external prop changes
  useEffect(() => {
    if (companyId) setMode("display");
  }, [companyId]);

  const doSearch = useCallback(async (term: string) => {
    if (term.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const companies = await searchCompanies(term);
      setResults(companies);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleQueryChange = (text: string) => {
    setQuery(text);
    setError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(text), 300);
  };

  const handleSelect = async (company: CrmCompany) => {
    setLinking(true);
    setError(null);
    try {
      const result = await linkMeetingToCompany(meetingId, company.id, company.name);
      onLinked(company.id, company.name, result.crm_note_created);
      setMode("display");
      setQuery("");
      setResults([]);
    } catch {
      setError("Hiba a cég hozzákapcsoláskor");
    } finally {
      setLinking(false);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setLinking(true);
    setError(null);

    // Split contact name into first/last
    const nameParts = contactName.trim().split(/\s+/);
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    try {
      const { company } = await createCompany({
        name: newName.trim(),
        domain: newDomain.trim() || undefined,
        contact_first_name: firstName || undefined,
        contact_last_name: lastName || undefined,
        contact_email: contactEmail.trim() || undefined,
        contact_phone: contactPhone.trim() || undefined,
      });

      const result = await linkMeetingToCompany(meetingId, company.id, company.name);
      onLinked(company.id, company.name, result.crm_note_created);
      setMode("display");
      // Reset form
      setNewName("");
      setNewDomain("");
      setContactName("");
      setContactPhone("");
      setContactEmail("");
    } catch {
      setError("Hiba az új cég létrehozásakor");
    } finally {
      setLinking(false);
    }
  };

  // ── Display mode: company chip ──────────────────────────────────────
  if (mode === "display" && companyId) {
    return (
      <View style={styles.container}>
        <View style={styles.chipRow}>
          <Ionicons name="business-outline" size={16} color={colors.primary} />
          <View style={styles.chip}>
            <Text style={styles.chipText}>{companyName}</Text>
          </View>
          <Pressable onPress={() => setMode("search")}>
            <Text style={styles.changeLink}>Módosítás</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Create mode: new company form ───────────────────────────────────
  if (mode === "create") {
    return (
      <View style={styles.container}>
        <View style={styles.formHeader}>
          <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
          <Text style={styles.formTitle}>Új cég létrehozása</Text>
        </View>

        <TextInput
          style={styles.input}
          placeholder="Cég neve *"
          placeholderTextColor={colors.textSecondary}
          value={newName}
          onChangeText={setNewName}
        />
        <TextInput
          style={styles.input}
          placeholder="Domain (pl. example.com)"
          placeholderTextColor={colors.textSecondary}
          value={newDomain}
          onChangeText={setNewDomain}
          autoCapitalize="none"
          keyboardType="url"
        />
        <TextInput
          style={styles.input}
          placeholder="Kapcsolattartó neve"
          placeholderTextColor={colors.textSecondary}
          value={contactName}
          onChangeText={setContactName}
        />
        <TextInput
          style={styles.input}
          placeholder="Kapcsolattartó telefonszáma"
          placeholderTextColor={colors.textSecondary}
          value={contactPhone}
          onChangeText={setContactPhone}
          keyboardType="phone-pad"
        />
        <TextInput
          style={styles.input}
          placeholder="Kapcsolattartó email"
          placeholderTextColor={colors.textSecondary}
          value={contactEmail}
          onChangeText={setContactEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />

        {error && <Text style={styles.errorText}>{error}</Text>}

        <View style={styles.formActions}>
          <Pressable
            style={styles.cancelBtn}
            onPress={() => {
              setMode("search");
              setError(null);
            }}
          >
            <Text style={styles.cancelBtnText}>Mégse</Text>
          </Pressable>
          <Pressable
            style={[styles.createBtn, !newName.trim() && styles.disabledBtn]}
            onPress={handleCreate}
            disabled={linking || !newName.trim()}
          >
            {linking ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Text style={styles.createBtnText}>Létrehozás</Text>
            )}
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Search mode ─────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <Ionicons name="business-outline" size={16} color={colors.textSecondary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Cég hozzákapcsolása..."
          placeholderTextColor={colors.textSecondary}
          value={query}
          onChangeText={handleQueryChange}
          autoFocus={!!companyId}
        />
        {searching && <ActivityIndicator size="small" color={colors.primary} />}
        {companyId && (
          <Pressable onPress={() => setMode("display")}>
            <Ionicons name="close" size={18} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>

      {error && <Text style={styles.errorText}>{error}</Text>}

      {/* Search results dropdown */}
      {query.length >= 2 && !searching && (
        <View style={styles.dropdown}>
          {results.map((company) => (
            <Pressable
              key={company.id}
              style={styles.resultItem}
              onPress={() => handleSelect(company)}
              disabled={linking}
            >
              <Text style={styles.resultName}>{company.name}</Text>
              {company.domain ? (
                <Text style={styles.resultDomain}>{company.domain}</Text>
              ) : null}
            </Pressable>
          ))}
          {results.length === 0 && (
            <Text style={styles.noResults}>Nincs találat</Text>
          )}

          <Pressable
            style={styles.newCompanyBtn}
            onPress={() => {
              setNewName(query);
              setMode("create");
            }}
          >
            <Ionicons name="add" size={16} color={colors.primary} />
            <Text style={styles.newCompanyText}>Új cég létrehozása</Text>
          </Pressable>
        </View>
      )}

      {linking && (
        <View style={styles.linkingOverlay}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.linkingText}>Hozzákapcsolás...</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },

  // Display mode
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  chip: {
    backgroundColor: colors.primary + "25",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
  },
  chipText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
  changeLink: {
    color: colors.textSecondary,
    fontSize: 13,
    textDecorationLine: "underline",
  },

  // Search mode
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.background,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    paddingVertical: spacing.sm,
  },

  // Dropdown
  dropdown: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  resultItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border + "50",
  },
  resultName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "500",
  },
  resultDomain: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  noResults: {
    color: colors.textSecondary,
    fontSize: 13,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  newCompanyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  newCompanyText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },

  // Create form
  formHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  formTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  input: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  cancelBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  cancelBtnText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  createBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.xl,
  },
  createBtnText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  disabledBtn: {
    opacity: 0.5,
  },

  // Linking overlay
  linkingOverlay: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    justifyContent: "center",
    paddingVertical: spacing.xs,
  },
  linkingText: {
    color: colors.textSecondary,
    fontSize: 13,
  },

  // Error
  errorText: {
    color: colors.error,
    fontSize: 13,
  },
});
