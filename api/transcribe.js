module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST is supported" });

  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("请先在 Vercel 配置 OPENAI_API_KEY");
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const fileName = String(body.fileName || "audio.webm");
    const mimeType = String(body.mimeType || "application/octet-stream");
    const base64 = String(body.fileBase64 || "");
    if (!base64) throw new Error("没有收到音频或视频文件");

    const estimatedBytes = Math.ceil((base64.length * 3) / 4);
    if (estimatedBytes > 3.5 * 1024 * 1024) {
      throw new Error("文件太大了。请先剪成 1-3 分钟以内，最好小于 3.5MB。");
    }

    const audioBlob = new Blob([Buffer.from(base64, "base64")], { type: mimeType });
    const formData = new FormData();
    formData.append("file", audioBlob, fileName);
    formData.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
    formData.append("language", "th");
    formData.append("response_format", "json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: formData
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`语音转文字失败：${response.status}${text ? " " + text.slice(0, 160) : ""}`);
    }

    const data = await response.json();
    const text = String(data.text || "").trim();
    if (!text) throw new Error("没有识别到泰语内容。可以换一段更清楚的音频试试。");

    res.status(200).json({ text });
  } catch (error) {
    res.status(400).json({ error: error.message || "语音转文字失败" });
  }
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

