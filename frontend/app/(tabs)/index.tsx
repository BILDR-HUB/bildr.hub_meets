/**
 * Dashboard – List of all meetings with status badges.
 * Tap a meeting to see the transcript and summary.
 * Long-press to delete.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { deleteMeeting, listMeetings, type Meeting } from "@/lib/api";
import ConfirmModal from "@/components/ConfirmModal";
import { colors, spacing, radius } from "@/lib/theme";

const STATUS_CONFIG: Record<
  string,
  { color: string; icon: keyof typeof Ionicons.glyphMap; label: string }
> = {
  pending: { color: colors.textMuted, icon: "time-outline", label: "Pending" },
  recording: { color: colors.recording, icon: "radio-outline", label: "Recording" },
  processing: { color: colors.processing, icon: "sync-outline", label: "Processing" },
  completed: { color: colors.success, icon: "checkmark-circle-outline", label: "Done" },
  failed: { color: colors.error, icon: "alert-circle-outline", label: "Failed" },
};

const SOURCE_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  bot: "videocam-outline",
  upload: "cloud-upload-outline",
  voice_note: "mic-outline",
};

export default function DashboardScreen() {
  const router = useRouter();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Meeting | null>(null);

  const fetchMeetings = useCallback(async () => {
    try {
      const data = await listMeetings();
      setMeetings(data);
    } catch (err) {
      console.error("Failed to fetch meetings:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchMeetings();
    const interval = setInterval(fetchMeetings, 10_000);
    return () => clearInterval(interval);
  }, [fetchMeetings]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchMeetings();
  };

  const handleDelete = (meeting: Meeting) => {
    setDeleteTarget(meeting);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    try {
      await deleteMeeting(id);
      setMeetings((prev) => prev.filter((m) => m.id !== id));
    } catch {
      // silent – user sees item still in list
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ConfirmModal
        visible={!!deleteTarget}
        title="Meeting törlése"
        message={`Biztosan törlöd: "${deleteTarget?.title}"?`}
        confirmLabel="Törlés"
        cancelLabel="Mégse"
        destructive
        icon="trash-outline"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {meetings.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="document-text-outline" size={64} color={colors.textMuted} />
          <Text style={styles.emptyText}>Még nincsenek meetingek</Text>
          <Text style={styles.emptySubtext}>
            Rögzíts hangjegyzetet vagy indíts Meet botot
          </Text>
        </View>
      ) : (
        <FlatList
          data={meetings}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          contentContainerStyle={{ padding: spacing.md }}
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
          renderItem={({ item }) => {
            const status = STATUS_CONFIG[item.status] || STATUS_CONFIG.pending;
            const sourceIcon = SOURCE_ICONS[item.source] || "document-outline";

            return (
              <Pressable
                style={styles.card}
                onPress={() => router.push(`/meeting/${item.id}`)}
                onLongPress={() => handleDelete(item)}
              >
                <View style={styles.cardHeader}>
                  <Ionicons
                    name={sourceIcon}
                    size={20}
                    color={colors.textMuted}
                  />
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Pressable
                    onPress={() => handleDelete(item)}
                    hitSlop={8}
                    style={styles.deleteBtn}
                  >
                    <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
                  </Pressable>
                </View>

                {/* Company name if linked */}
                {item.company_name && (
                  <View style={styles.companyRow}>
                    <Ionicons name="business-outline" size={13} color={colors.primary} />
                    <Text style={styles.companyText}>{item.company_name}</Text>
                  </View>
                )}

                <View style={styles.cardFooter}>
                  <Text style={styles.cardDate}>
                    {new Date(item.created_at).toLocaleDateString("hu-HU", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Text>
                  <View style={[styles.badge, { backgroundColor: status.color + "20" }]}>
                    <Ionicons name={status.icon} size={14} color={status.color} />
                    <Text style={[styles.badgeText, { color: status.color }]}>
                      {status.label}
                    </Text>
                  </View>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  emptyText: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600",
    marginTop: spacing.md,
  },
  emptySubtext: { color: colors.textSecondary, fontSize: 14 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cardTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "600" },
  deleteBtn: {
    padding: 4,
    borderRadius: radius.sm,
  },
  companyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 28,
  },
  companyText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "500",
  },
  cardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardDate: { color: colors.textSecondary, fontSize: 12 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.md,
  },
  badgeText: { fontSize: 12, fontWeight: "500" },
});
