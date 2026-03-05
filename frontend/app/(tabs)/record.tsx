/**
 * Voice Note Recorder – Record audio offline and upload to the backend.
 * Uses expo-av for recording.
 */

import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Audio } from "expo-av";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { uploadAudio } from "@/lib/api";
import { colors, spacing, radius } from "@/lib/theme";

type RecordingState = "idle" | "recording" | "stopped" | "uploading" | "file_selected";

export default function RecordScreen() {
  const router = useRouter();
  const recordingRef = useRef<Audio.Recording | null>(null);
  const [state, setState] = useState<RecordingState>("idle");
  const [duration, setDuration] = useState(0);
  const [title, setTitle] = useState("");
  const [recordingUri, setRecordingUri] = useState<string | null>(null);

  // Web-specific: native MediaRecorder for reliable blob access
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioBlobRef = useRef<Blob | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isWeb = Platform.OS === "web";

  // ── File picker (web) ──────────────────────────────────────────────
  const handleFilePick = useCallback(() => {
    if (!isWeb) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.mp3,.wav,.m4a,.ogg,.webm,.mp4,.flac";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        setSelectedFile(file);
        setState("file_selected");
      }
    };
    input.click();
  }, [isWeb]);

  const handleFileUpload = async () => {
    if (!selectedFile) return;
    setState("uploading");
    try {
      const result = await uploadAudio("", selectedFile.name, {
        title: title || selectedFile.name.replace(/\.[^.]+$/, ""),
        source: "upload",
        language: "hu",
        blob: selectedFile,
      });
      Alert.alert("Feltöltve!", "A feldolgozás elindult.", [
        { text: "Megtekintés", onPress: () => router.push(`/meeting/${result.meeting_id}`) },
        { text: "OK" },
      ]);
      setState("idle");
      setDuration(0);
      setTitle("");
      setSelectedFile(null);
    } catch (err) {
      console.error("Upload failed:", err);
      Alert.alert("Hiba", String(err));
      setState("file_selected");
    }
  };

  const startRecording = async () => {
    try {
      if (isWeb) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream, {
          mimeType: "audio/webm;codecs=opus",
        });
        chunksRef.current = [];
        audioBlobRef.current = null;

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };

        mediaRecorder.onstop = () => {
          audioBlobRef.current = new Blob(chunksRef.current, { type: "audio/webm" });
          stream.getTracks().forEach((t) => t.stop());
        };

        mediaRecorderRef.current = mediaRecorder;
        mediaRecorder.start(1000);
        setState("recording");

        const start = Date.now();
        timerRef.current = setInterval(() => {
          setDuration(Math.floor((Date.now() - start) / 1000));
        }, 500);
      } else {
        const permission = await Audio.requestPermissionsAsync();
        if (!permission.granted) {
          Alert.alert("Permission needed", "Microphone access is required.");
          return;
        }

        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });

        const { recording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY
        );

        recordingRef.current = recording;
        setState("recording");

        recording.setOnRecordingStatusUpdate((status) => {
          if (status.isRecording) {
            setDuration(Math.floor((status.durationMillis || 0) / 1000));
          }
        });
      }
    } catch (err) {
      console.error("Failed to start recording:", err);
      Alert.alert("Error", "Failed to start recording.");
    }
  };

  const stopRecording = async () => {
    if (isWeb) {
      if (!mediaRecorderRef.current) return;
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      await new Promise((r) => setTimeout(r, 200));
      setState("stopped");
    } else {
      if (!recordingRef.current) return;
      try {
        await recordingRef.current.stopAndUnloadAsync();
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
        const uri = recordingRef.current.getURI();
        setRecordingUri(uri);
        recordingRef.current = null;
        setState("stopped");
      } catch (err) {
        console.error("Failed to stop recording:", err);
      }
    }
  };

  const handleUpload = async () => {
    if (isWeb && !audioBlobRef.current) return;
    if (!isWeb && !recordingUri) return;

    setState("uploading");
    try {
      const result = await uploadAudio(
        recordingUri || "",
        `voice_note_${Date.now()}.webm`,
        {
          title: title || `Voice Note ${new Date().toLocaleString("hu-HU")}`,
          source: "voice_note",
          language: "hu",
          blob: isWeb ? audioBlobRef.current! : undefined,
        }
      );

      Alert.alert("Feltöltve!", "A feldolgozás elindult.", [
        {
          text: "Megtekintés",
          onPress: () => router.push(`/meeting/${result.meeting_id}`),
        },
        { text: "OK" },
      ]);

      setState("idle");
      setDuration(0);
      setTitle("");
      setRecordingUri(null);
      audioBlobRef.current = null;
    } catch (err) {
      console.error("Upload failed:", err);
      Alert.alert("Hiba", String(err));
      setState("stopped");
    }
  };

  const handleDiscard = () => {
    setState("idle");
    setDuration(0);
    setRecordingUri(null);
    audioBlobRef.current = null;
    setSelectedFile(null);
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60)
      .toString()
      .padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder="Meeting címe (opcionális)"
        placeholderTextColor={colors.textMuted}
        value={title}
        onChangeText={setTitle}
        editable={state !== "uploading"}
      />

      {/* File drop zone – only visible in idle state on web */}
      {isWeb && (state === "idle" || state === "file_selected") && (
        <Pressable
          style={[styles.dropZone, dragOver && styles.dropZoneActive]}
          onPress={handleFilePick}
          // @ts-ignore – web-only drag events
          onDragOver={(e: DragEvent) => {
            e.preventDefault();
            setDragOver(true);
          }}
          // @ts-ignore
          onDragLeave={() => setDragOver(false)}
          // @ts-ignore
          onDrop={(e: DragEvent) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer?.files?.[0];
            if (file && file.type.startsWith("audio/")) {
              setSelectedFile(file);
              setState("file_selected");
            }
          }}
        >
          <Ionicons
            name={selectedFile ? "document-outline" : "cloud-upload-outline"}
            size={36}
            color={dragOver ? colors.accent : colors.textMuted}
          />
          {selectedFile ? (
            <View style={styles.fileInfo}>
              <Text style={styles.fileName} numberOfLines={1}>
                {selectedFile.name}
              </Text>
              <Text style={styles.fileSize}>
                {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
              </Text>
            </View>
          ) : (
            <Text style={styles.dropText}>
              Húzd ide a hangfájlt, vagy kattints a tallózáshoz
            </Text>
          )}
        </Pressable>
      )}

      {/* File selected actions */}
      {state === "file_selected" && selectedFile && (
        <View style={styles.actionRow}>
          <Pressable style={styles.discardBtn} onPress={handleDiscard}>
            <Ionicons name="trash-outline" size={28} color={colors.error} />
            <Text style={[styles.actionLabel, { color: colors.error }]}>
              Elvetés
            </Text>
          </Pressable>

          <Pressable style={styles.uploadBtn} onPress={handleFileUpload}>
            <Ionicons
              name="cloud-upload-outline"
              size={28}
              color={colors.text}
            />
            <Text style={styles.actionLabel}>Feldolgozás</Text>
          </Pressable>
        </View>
      )}

      {/* Divider between file upload and recorder */}
      {isWeb && state === "idle" && (
        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>vagy rögzíts élőben</Text>
          <View style={styles.dividerLine} />
        </View>
      )}

      {/* Timer – shown when recording or stopped */}
      {(state === "idle" || state === "recording" || state === "stopped") && (
        <Text style={styles.timer}>{formatTime(duration)}</Text>
      )}

      <View style={styles.controls}>
        {state === "idle" && (
          <Pressable style={styles.recordBtn} onPress={startRecording}>
            <Ionicons name="mic" size={48} color={colors.text} />
            <Text style={styles.btnLabel}>Felvétel indítása</Text>
          </Pressable>
        )}

        {state === "recording" && (
          <Pressable
            style={[styles.recordBtn, styles.recordingBtn]}
            onPress={stopRecording}
          >
            <Ionicons name="stop" size={48} color={colors.text} />
            <Text style={styles.btnLabel}>Leállítás</Text>
          </Pressable>
        )}

        {state === "stopped" && (
          <View style={styles.actionRow}>
            <Pressable style={styles.discardBtn} onPress={handleDiscard}>
              <Ionicons name="trash-outline" size={28} color={colors.error} />
              <Text style={[styles.actionLabel, { color: colors.error }]}>
                Elvetés
              </Text>
            </Pressable>

            <Pressable style={styles.uploadBtn} onPress={handleUpload}>
              <Ionicons
                name="cloud-upload-outline"
                size={28}
                color={colors.text}
              />
              <Text style={styles.actionLabel}>Feltöltés</Text>
            </Pressable>
          </View>
        )}

        {state === "uploading" && (
          <View style={styles.uploadingState}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.btnLabel}>Feltöltés és feldolgozás...</Text>
          </View>
        )}
      </View>

      {/* Chrome extension download – csak weben */}
      {isWeb && (
        <Pressable
          style={styles.extensionBtn}
          onPress={() => {
            window.open("/bildr-meeting-extension.zip", "_blank");
          }}
        >
          <Ionicons name="puzzle-outline" size={18} color={colors.accent} />
          <View>
            <Text style={styles.extensionBtnTitle}>Chrome bővítmény letöltése</Text>
            <Text style={styles.extensionBtnSub}>
              Google Meet automatikus rögzítéshez
            </Text>
          </View>
          <Ionicons name="download-outline" size={18} color={colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
    gap: spacing.xl,
  },
  input: {
    width: "100%",
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 16,
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  timer: {
    color: colors.accent,
    fontSize: 64,
    fontWeight: "200",
    fontVariant: ["tabular-nums"],
  },
  controls: { alignItems: "center" },
  recordBtn: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.surface,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: colors.primary,
  },
  recordingBtn: {
    borderColor: colors.recording,
    backgroundColor: colors.recording + "30",
  },
  btnLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: spacing.xs,
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.lg,
  },
  discardBtn: {
    alignItems: "center",
    gap: spacing.xs,
    padding: spacing.md,
  },
  uploadBtn: {
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xl,
  },
  actionLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "500",
  },
  uploadingState: {
    alignItems: "center",
    gap: spacing.md,
  },

  // File upload zone
  dropZone: {
    width: "100%",
    borderWidth: 2,
    borderColor: colors.border,
    borderStyle: "dashed",
    borderRadius: radius.xl,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
  },
  dropZoneActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentLight,
  },
  dropText: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: "center",
  },
  fileInfo: {
    alignItems: "center",
    gap: 2,
  },
  fileName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  fileSize: {
    color: colors.textSecondary,
    fontSize: 12,
  },

  // Extension download
  extensionBtn: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing.sm,
    width: "100%" as const,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary + "60",
  },
  extensionBtnTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600" as const,
  },
  extensionBtnSub: {
    color: colors.textSecondary,
    fontSize: 12,
  },

  // Divider
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    width: "100%",
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerText: {
    color: colors.textMuted,
    fontSize: 12,
  },
});
