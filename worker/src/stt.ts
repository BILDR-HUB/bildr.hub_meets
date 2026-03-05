/**
 * stt.ts – Speech-to-Text via Groq Whisper API
 */

export interface STTResult {
  text: string;
}

export async function transcribeAudio(
  audioBytes: ArrayBuffer,
  filename: string,
  language: string,
  groqApiKey: string,
): Promise<STTResult> {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([audioBytes], { type: "audio/webm" }),
    filename,
  );
  formData.append("model", "whisper-large-v3");
  formData.append("language", language);
  formData.append("response_format", "json");

  const response = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${groqApiKey}` },
      body: formData,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Groq STT failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { text: string };
  return { text: data.text ?? "" };
}
