/**
 * stt.ts – Speech-to-Text via Groq Whisper API
 *
 * Groq limit: 25MB per request.
 * Ha a fájl nagyobb, automatikusan darabokra osztja és összeilleszti a szöveget.
 */

export interface STTResult {
  text: string;
}

const GROQ_MAX_BYTES = 24 * 1024 * 1024; // 24MB (kicsit a 25MB limit alatt, biztonság)

export async function transcribeAudio(
  audioBytes: ArrayBuffer,
  filename: string,
  language: string,
  groqApiKey: string,
): Promise<STTResult> {
  // Ha a fájl kisebb mint a limit → egyből elküldjük
  if (audioBytes.byteLength <= GROQ_MAX_BYTES) {
    return transcribeChunk(audioBytes, filename, language, groqApiKey);
  }

  // Nagy fájl → darabokra osztjuk és sorban átírjuk
  const parts: string[] = [];
  let offset = 0;
  let partIndex = 0;

  while (offset < audioBytes.byteLength) {
    const chunk = audioBytes.slice(offset, offset + GROQ_MAX_BYTES);
    const partName = filename.replace(/(\.\w+)?$/, `_part${partIndex}$1`);
    const result = await transcribeChunk(chunk, partName, language, groqApiKey);
    parts.push(result.text);
    offset += GROQ_MAX_BYTES;
    partIndex++;
  }

  return { text: parts.join(" ").trim() };
}

async function transcribeChunk(
  audioBytes: ArrayBuffer,
  filename: string,
  language: string,
  groqApiKey: string,
): Promise<STTResult> {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([audioBytes], { type: guessContentType(filename) }),
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

function guessContentType(filename: string): string {
  if (filename.endsWith(".webm")) return "audio/webm";
  if (filename.endsWith(".mp4") || filename.endsWith(".m4a")) return "audio/mp4";
  if (filename.endsWith(".wav")) return "audio/wav";
  if (filename.endsWith(".mp3")) return "audio/mpeg";
  return "audio/webm";
}
