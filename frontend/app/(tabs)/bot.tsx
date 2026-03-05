/**
 * Meet Bot – Paste a Google Meet URL to send the bot.
 */

import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { startBot } from "@/lib/api";
import { colors, spacing, radius } from "@/lib/theme";

export default function BotScreen() {
  const router = useRouter();
  const [meetUrl, setMeetUrl] = useState("");
  const [title, setTitle] = useState("");
  const [botName, setBotName] = useState("Meeting Bot");
  const [loading, setLoading] = useState(false);

  const isValidUrl = meetUrl.startsWith("https://meet.google.com/");

  const handleStartBot = async () => {
    if (!isValidUrl) {
      Alert.alert("Érvénytelen URL", "Adj meg egy érvényes Google Meet linket.");
      return;
    }

    setLoading(true);
    try {
      const meeting = await startBot(
        meetUrl,
        botName,
        title || "Bot Meeting"
      );

      Alert.alert("Bot elindítva!", "A bot csatlakozik a meetinghez.", [
        {
          text: "Követés",
          onPress: () => router.push(`/meeting/${meeting.id}`),
        },
        { text: "OK" },
      ]);

      setMeetUrl("");
      setTitle("");
    } catch (err) {
      console.error("Bot start failed:", err);
      Alert.alert("Hiba", String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.iconWrap}>
        <Ionicons name="videocam" size={48} color={colors.accent} />
      </View>

      <Text style={styles.heading}>GOOGLE MEET BOT</Text>
      <Text style={styles.subtext}>
        Illeszd be a Meet linket, és a bot automatikusan csatlakozik, rögzít
        és leiratot készít.
      </Text>

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="https://meet.google.com/abc-defg-hij"
          placeholderTextColor={colors.textMuted}
          value={meetUrl}
          onChangeText={setMeetUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <TextInput
          style={styles.input}
          placeholder="Meeting címe (opcionális)"
          placeholderTextColor={colors.textMuted}
          value={title}
          onChangeText={setTitle}
        />

        <TextInput
          style={styles.input}
          placeholder="Bot megjelenítési neve"
          placeholderTextColor={colors.textMuted}
          value={botName}
          onChangeText={setBotName}
        />

        <Pressable
          style={[
            styles.button,
            !isValidUrl && styles.buttonDisabled,
          ]}
          onPress={handleStartBot}
          disabled={!isValidUrl || loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <>
              <Ionicons name="send-outline" size={20} color={colors.text} />
              <Text style={styles.buttonText}>BOT INDÍTÁSA</Text>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.primary + "20",
    justifyContent: "center",
    alignItems: "center",
  },
  heading: {
    color: colors.accent,
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 1,
  },
  subtext: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
    maxWidth: 300,
    lineHeight: 22,
  },
  form: {
    width: "100%",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 16,
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  button: {
    flexDirection: "row",
    backgroundColor: colors.primary,
    padding: spacing.md,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
});
