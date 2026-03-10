/**
 * Meeting Detail – Shows transcript, executive summary, and action items.
 * Polls for status if the meeting is still processing.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { deleteMeeting, getMeeting, getMeetingStatus, updateMeetingTitle, type Meeting, type Transcript } from "@/lib/api";
import CompanySelector from "@/components/CompanySelector";
import ConfirmModal from "@/components/ConfirmModal";
import { colors, spacing, radius } from "@/lib/theme";

const PRIORITY_COLORS: Record<string, string> = {
  high: colors.error,
  medium: colors.warning,
  low: colors.success,
};

export default function MeetingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [crmSynced, setCrmSynced] = useState(false);

  const copyToClipboard = async (text: string, field: string) => {
    try {
      if (Platform.OS === "web" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Fallback: text is selectable so user can copy manually
    }
  };

  const fetchData = useCallback(async () => {
    if (!id) return;
    try {
      const data = await getMeeting(id);
      setMeeting(data.meeting);
      setTranscript(data.transcript);
    } catch (err) {
      console.error("Failed to fetch meeting:", err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Poll while processing
  useEffect(() => {
    if (!id || !meeting) return;
    if (meeting.status === "completed" || meeting.status === "failed") return;

    const interval = setInterval(async () => {
      try {
        const status = await getMeetingStatus(id);
        if (status.status === "completed" || status.status === "failed") {
          clearInterval(interval);
          fetchData();
        }
      } catch {
        // ignore
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [id, meeting?.status, fetchData]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!meeting) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Meeting nem található</Text>
      </View>
    );
  }

  const isProcessing =
    meeting.status === "pending" ||
    meeting.status === "recording" ||
    meeting.status === "processing";

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      {/* Back button */}
      <Pressable style={styles.backButton} onPress={() => router.back()}>
        <Ionicons name="arrow-back-outline" size={16} color={colors.textSecondary} />
        <Text style={styles.backButtonText}>Meetingek</Text>
      </Pressable>

      {/* Header – editable title */}
      {editingTitle ? (
        <TextInput
          style={styles.titleInput}
          value={titleDraft}
          onChangeText={setTitleDraft}
          autoFocus
          selectTextOnFocus
          onBlur={async () => {
            const trimmed = titleDraft.trim();
            if (trimmed && trimmed !== meeting.title) {
              try {
                await updateMeetingTitle(meeting.id, trimmed);
                setMeeting((prev) => (prev ? { ...prev, title: trimmed } : prev));
              } catch {
                // revert silently
              }
            }
            setEditingTitle(false);
          }}
          onSubmitEditing={async () => {
            const trimmed = titleDraft.trim();
            if (trimmed && trimmed !== meeting.title) {
              try {
                await updateMeetingTitle(meeting.id, trimmed);
                setMeeting((prev) => (prev ? { ...prev, title: trimmed } : prev));
              } catch {
                // revert silently
              }
            }
            setEditingTitle(false);
          }}
        />
      ) : (
        <Pressable
          style={styles.titleRow}
          onPress={() => {
            setTitleDraft(meeting.title);
            setEditingTitle(true);
          }}
        >
          <Text style={styles.title}>{meeting.title}</Text>
          <Ionicons name="pencil-outline" size={16} color={colors.textMuted} />
        </Pressable>
      )}
      <Text style={styles.meta}>
        {new Date(meeting.created_at).toLocaleString("hu-HU")} ·{" "}
        {meeting.source.replace("_", " ")}
      </Text>

      {/* CRM szinkron szekció – csak kész meetingeknél */}
      {meeting.status === "completed" && (
        <View style={styles.crmSection}>
          {/* CRM státusz fejléc */}
          <View style={[
            styles.crmHeader,
            crmSynced && styles.crmHeaderSuccess,
            !meeting.company_id && !crmSynced && styles.crmHeaderPending,
          ]}>
            <Ionicons
              name={crmSynced || meeting.company_id ? "checkmark-circle" : "cloud-upload-outline"}
              size={16}
              color={crmSynced || meeting.company_id ? colors.success : colors.warning}
            />
            <Text style={[
              styles.crmHeaderText,
              (crmSynced || meeting.company_id) && styles.crmHeaderTextSuccess,
            ]}>
              {crmSynced
                ? "CRM-be feltöltve!"
                : meeting.company_id
                  ? "CRM szinkronizálva"
                  : "Rendelj hozzá céget → CRM-be töltés"}
            </Text>
          </View>
          <CompanySelector
            meetingId={meeting.id}
            companyId={meeting.company_id}
            companyName={meeting.company_name}
            onLinked={(companyId, companyName, noteCreated) => {
              setMeeting((prev) =>
                prev ? { ...prev, company_id: companyId, company_name: companyName } : prev
              );
              if (noteCreated) setCrmSynced(true);
            }}
          />
        </View>
      )}

      {/* Processing indicator */}
      {isProcessing && (
        <View style={styles.processingCard}>
          <ActivityIndicator color={colors.processing} />
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={styles.processingText}>
              {meeting.status === "recording"
                ? "Felvétel folyamatban..."
                : "Feldolgozás – átírás és összefoglalás..."}
            </Text>
            {meeting.status === "recording" && (
              <Pressable
                onPress={async () => {
                  try {
                    const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:8000";
                    const form = new FormData();
                    form.append("meeting_id", meeting.id);
                    const res = await fetch(`${API_URL}/api/audio-finalize`, { method: "POST", body: form });
                    if (res.ok) {
                      setMeeting((prev) => prev ? { ...prev, status: "processing" } : prev);
                    }
                  } catch {}
                }}
              >
                <Text style={styles.retryText}>Feldolgozás indítása manuálisan →</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      {/* Executive Summary – sections or plain text */}
      {transcript?.executive_summary && (() => {
        let sections: Array<{ title: string; points: string[] }> | null = null;
        try {
          const parsed = JSON.parse(transcript.executive_summary!);
          if (Array.isArray(parsed) && parsed.length > 0) sections = parsed;
        } catch { /* plain text */ }

        return (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="document-text-outline" size={20} color={colors.accent} />
              <Text style={styles.sectionTitle}>Összefoglaló</Text>
            </View>
            {sections ? (
              sections.map((sec, i) => (
                <View key={i} style={styles.summarySection}>
                  <Text style={styles.summarySectionTitle}>{sec.title}</Text>
                  {sec.points.map((point, j) => (
                    <View key={j} style={styles.summaryPoint}>
                      <Text style={styles.summaryBullet}>•</Text>
                      <Text style={styles.summaryPointText}>{point}</Text>
                    </View>
                  ))}
                </View>
              ))
            ) : (
              <Text style={styles.summaryText}>{transcript.executive_summary}</Text>
            )}
          </View>
        );
      })()}

      {/* Action Items */}
      {transcript?.action_items && transcript.action_items.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="checkbox-outline" size={20} color={colors.accent} />
            <Text style={styles.sectionTitle}>
              Feladatok ({transcript.action_items.length})
            </Text>
          </View>
          {transcript.action_items.map((item, i) => (
            <View key={i} style={styles.actionItem}>
              <View style={styles.actionHeader}>
                <View
                  style={[
                    styles.priorityDot,
                    {
                      backgroundColor:
                        PRIORITY_COLORS[item.priority] || colors.textSecondary,
                    },
                  ]}
                />
                <Text style={styles.actionTask}>{item.task}</Text>
              </View>
              <View style={styles.actionMeta}>
                {item.assignee && (
                  <View style={styles.metaChip}>
                    <Ionicons
                      name="person-outline"
                      size={12}
                      color={colors.textSecondary}
                    />
                    <Text style={styles.metaText}>{item.assignee}</Text>
                  </View>
                )}
                {item.deadline && (
                  <View style={styles.metaChip}>
                    <Ionicons
                      name="calendar-outline"
                      size={12}
                      color={colors.textSecondary}
                    />
                    <Text style={styles.metaText}>{item.deadline}</Text>
                  </View>
                )}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Follow-up Email */}
      {transcript?.followup_email && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="mail-outline" size={20} color={colors.accent} />
            <Text style={styles.sectionTitle}>Follow-up email</Text>
          </View>

          {/* Subject */}
          <View style={styles.emailField}>
            <Text style={styles.emailLabel}>TÁRGY</Text>
            <View style={styles.emailValueRow}>
              <Text style={styles.emailSubject} selectable>
                {transcript.followup_email.subject}
              </Text>
              <Pressable
                onPress={() =>
                  copyToClipboard(transcript.followup_email!.subject, "subject")
                }
                style={styles.copyChip}
              >
                <Ionicons
                  name={copiedField === "subject" ? "checkmark" : "copy-outline"}
                  size={14}
                  color={copiedField === "subject" ? colors.success : colors.textSecondary}
                />
              </Pressable>
            </View>
          </View>

          {/* Body */}
          <View style={styles.emailBody}>
            <Text style={styles.emailBodyText} selectable>
              {transcript.followup_email.body}
            </Text>
          </View>

          {/* Copy full email button */}
          <Pressable
            style={[
              styles.copyButton,
              copiedField === "email" && styles.copyButtonSuccess,
            ]}
            onPress={() => {
              const full = `Tárgy: ${transcript.followup_email!.subject}\n\n${transcript.followup_email!.body}`;
              copyToClipboard(full, "email");
            }}
          >
            <Ionicons
              name={copiedField === "email" ? "checkmark-circle" : "copy-outline"}
              size={18}
              color={copiedField === "email" ? colors.success : colors.text}
            />
            <Text
              style={[
                styles.copyButtonText,
                copiedField === "email" && { color: colors.success },
              ]}
            >
              {copiedField === "email" ? "Vágólapra másolva!" : "Teljes email másolása"}
            </Text>
          </Pressable>
        </View>
      )}

      {/* Diarized Transcript (speaker-identified, for bot meetings) */}
      {transcript?.diarized_text && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="people-outline" size={20} color={colors.accent} />
            <Text style={styles.sectionTitle}>Beszélgetés (beszélők szerint)</Text>
          </View>
          {transcript.diarized_text.split("\n").map((line, i) => {
            const speakerMatch = line.match(/^\*\*(.+?):\*\*\s*(.*)/);
            if (speakerMatch) {
              return (
                <View key={i} style={styles.diarizedLine}>
                  <Text style={styles.speakerName}>{speakerMatch[1]}:</Text>
                  <Text style={styles.speakerText}>{speakerMatch[2]}</Text>
                </View>
              );
            }
            if (line.trim()) {
              return (
                <Text key={i} style={styles.transcriptText}>{line}</Text>
              );
            }
            return <View key={i} style={{ height: 8 }} />;
          })}
        </View>
      )}

      {/* Raw Transcript */}
      {transcript?.raw_text && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Ionicons name="chatbubbles-outline" size={20} color={colors.accent} />
            <Text style={styles.sectionTitle}>Teljes átirat</Text>
          </View>
          <Text style={styles.transcriptText}>{transcript.raw_text}</Text>
        </View>
      )}

      {/* Delete button */}
      <Pressable
        style={styles.deleteButton}
        onPress={() => setShowDeleteConfirm(true)}
      >
        <Ionicons name="trash-outline" size={18} color={colors.error} />
        <Text style={styles.deleteButtonText}>Meeting törlése</Text>
      </Pressable>

      <ConfirmModal
        visible={showDeleteConfirm}
        title="Meeting törlése"
        message={`Biztosan törlöd: "${meeting.title}"?`}
        confirmLabel="Törlés"
        cancelLabel="Mégse"
        destructive
        icon="trash-outline"
        onConfirm={async () => {
          setShowDeleteConfirm(false);
          try {
            await deleteMeeting(meeting.id);
            router.back();
          } catch {
            // silent
          }
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      {/* Failed state */}
      {meeting.status === "failed" && (
        <View style={styles.failedCard}>
          <Ionicons name="alert-circle" size={24} color={colors.error} />
          <Text style={styles.failedText}>
            A feldolgozás sikertelen. Kérjük, próbáld meg újra feltölteni a hangfájlt.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  backButton: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    alignSelf: "flex-start" as const,
    paddingVertical: 4,
    marginBottom: spacing.xs,
  },
  backButtonText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 60 },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.background,
  },
  errorText: { color: colors.error, fontSize: 16 },
  titleRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing.sm,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" as const },
  titleInput: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "700" as const,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  meta: { color: colors.textSecondary, fontSize: 13 },

  // CRM section
  crmSection: {
    gap: spacing.sm,
  },
  crmHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: colors.warning + "15",
    borderWidth: 1,
    borderColor: colors.warning + "40",
  },
  crmHeaderPending: {
    backgroundColor: colors.warning + "15",
    borderColor: colors.warning + "40",
  },
  crmHeaderSuccess: {
    backgroundColor: colors.success + "15",
    borderColor: colors.success + "40",
  },
  crmHeaderText: {
    color: colors.warning,
    fontSize: 13,
    fontWeight: "600" as const,
    flex: 1,
  },
  crmHeaderTextSuccess: {
    color: colors.success,
  },

  // Processing
  processingCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.processing + "15",
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.processing + "40",
  },
  processingText: { color: colors.processing, fontSize: 14 },
  retryText: { color: colors.accent, fontSize: 13, textDecorationLine: "underline" },

  // Sections
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  summaryText: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 24,
  },
  summarySection: {
    gap: 6,
    marginTop: spacing.xs,
  },
  summarySectionTitle: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "700" as const,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  summaryPoint: {
    flexDirection: "row" as const,
    gap: 8,
    paddingLeft: 4,
  },
  summaryBullet: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  summaryPointText: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
    flex: 1,
  },

  // Action items
  actionItem: {
    backgroundColor: colors.accentLight + "50",
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  actionHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  priorityDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  actionTask: { color: colors.text, fontSize: 14, flex: 1 },
  actionMeta: { flexDirection: "row", gap: spacing.sm, paddingLeft: 20 },
  metaChip: { flexDirection: "row", alignItems: "center", gap: 3 },
  metaText: { color: colors.textSecondary, fontSize: 12 },

  // Follow-up email
  emailField: {
    gap: 4,
  },
  emailLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "700" as const,
    letterSpacing: 1,
  },
  emailValueRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing.sm,
  },
  emailSubject: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600" as const,
    flex: 1,
  },
  copyChip: {
    padding: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.accentLight + "60",
  },
  emailBody: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emailBodyText: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 22,
  },
  copyButton: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.xl,
    backgroundColor: colors.primary,
  },
  copyButtonSuccess: {
    backgroundColor: colors.success + "20",
    borderWidth: 1,
    borderColor: colors.success + "40",
  },
  copyButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600" as const,
  },

  // Diarized transcript
  diarizedLine: {
    flexDirection: "row" as const,
    gap: spacing.xs,
    paddingVertical: 2,
  },
  speakerName: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600" as const,
    minWidth: 80,
  },
  speakerText: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
    flex: 1,
  },

  // Transcript
  transcriptText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },

  // Failed
  failedCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.error + "15",
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.error + "40",
  },
  failedText: { color: colors.error, fontSize: 14, flex: 1 },

  // Delete
  deleteButton: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.error + "40",
    backgroundColor: colors.error + "10",
  },
  deleteButtonText: {
    color: colors.error,
    fontSize: 14,
    fontWeight: "500" as const,
  },
});
