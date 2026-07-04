const THAI_RE = /[\u0E00-\u0E7F]/;

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST is supported" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const url = String(body.url || "").trim();
    const pastedText = String(body.text || "").trim();
    const title = String(body.title || "").trim();
    let lines = [];
    let source = "manual";

    if (url) {
      const videoId = getYouTubeVideoId(url);
      if (!videoId) throw new Error("目前第一版只支持 YouTube 链接。");
      source = "youtube";
      lines = await getYouTubeCaptions(videoId);
    }

    if (!lines.length && pastedText) {
      lines = splitPastedText(pastedText);
      source = "pasted-text";
    }

    if (!lines.length) throw new Error("没有找到可读取的泰语字幕。可以上传音频/视频转文字，或粘贴泰语字幕。");

    const cards = await enrichThaiLines(lines, { title, source });
    res.status(200).json({ mode: guessMode(title, lines), source, count: cards.length, cards });
  } catch (error) {
    res.status(400).json({ error: error.message || "解析失败" });
  }
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getYouTubeVideoId(input) {
  try {
    const url = new URL(input);
    if (url.hostname.includes("youtu.be")) return url.pathname.replace("/", "");
    if (url.hostname.includes("youtube.com")) {
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2];
      return url.searchParams.get("v");
    }
  } catch (_) {
    const match = input.match(/[?&]v=([A-Za-z0-9_-]{6,})|youtu\.be\/([A-Za-z0-9_-]{6,})/);
    return match && (match[1] || match[2]);
  }
  return null;
}

async function getYouTubeCaptions(videoId) {
  const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}&hl=th&gl=TH`);
  const tracks = extractCaptionTracks(html);
  if (!tracks.length) return [];

  const track = tracks.find(item => String(item.languageCode || "").toLowerCase().startsWith("th")) ||
    tracks.find(item => /thai|ไทย/i.test(JSON.stringify(item.name || {}))) ||
    tracks[0];

  const captionUrl = decodeYouTubeUrl(track.baseUrl) + "&fmt=json3";
  const captionJson = await fetchJson(captionUrl);
  return parseJson3Captions(captionJson).filter(line => THAI_RE.test(line.text)).slice(0, 40);
}

function extractCaptionTracks(html) {
  const match = html.match(/"captionTracks":(\[.*?\])\s*,\s*"audioTracks"/);
  if (!match) return [];
  try { return JSON.parse(match[1]); } catch (_) { return []; }
}

function decodeYouTubeUrl(url) {
  return String(url || "").replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 ThaiImmersionPlayer/1.0" } });
  if (!response.ok) throw new Error(`读取链接失败：${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 ThaiImmersionPlayer/1.0" } });
  if (!response.ok) throw new Error(`读取字幕失败：${response.status}`);
  return response.json();
}

function parseJson3Captions(data) {
  const lines = [];
  for (const event of data.events || []) {
    const text = (event.segs || []).map(seg => seg.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (text) lines.push({ text, startMs: event.tStartMs || 0, durationMs: event.dDurationMs || 0 });
  }
  return mergeShortLines(lines);
}

function mergeShortLines(lines) {
  const merged = [];
  let buffer = "";
  let startMs = 0;
  for (const line of lines) {
    if (!buffer) startMs = line.startMs;
    buffer = `${buffer} ${line.text}`.trim();
    if (buffer.length >= 18 || /[?？.!。]$/.test(buffer)) {
      merged.push({ text: buffer, startMs });
      buffer = "";
    }
  }
  if (buffer) merged.push({ text: buffer, startMs });
  return merged;
}

function splitPastedText(text) {
  return text.split(/\n+/)
    .map(line => line.trim())
    .filter(line => line && THAI_RE.test(line))
    .slice(0, 40)
    .map((text, index) => ({ text, startMs: index * 3000 }));
}

async function enrichThaiLines(lines, context) {
  const rawCards = lines.map((line, index) => ({
    id: `auto-${index + 1}`,
    thai: line.text,
    zh: "",
    roman: "",
    scene: "从导入内容自动生成。",
    words: [],
    examples: [],
    syllables: line.text.split(/\s+/).join(" / "),
    startMs: line.startMs || 0
  }));

  if (!process.env.DEEPSEEK_API_KEY) {
    return rawCards.map(card => ({
      ...card,
      zh: "待翻译：请在后端配置 DEEPSEEK_API_KEY",
      scene: "已读取字幕；配置 DeepSeek 后可自动翻译和拆词。"
    }));
  }

  try {
    const enriched = await callDeepSeek(rawCards, context);
    if (Array.isArray(enriched) && enriched.length) {
      return enriched.map((item, index) => ({
        ...rawCards[index],
        ...item,
        id: rawCards[index]?.id || item.id || `auto-${index + 1}`
      }));
    }
  } catch (error) {
    const message = error.message || "AI 拆解失败";
    console.error("DeepSeek enrich failed:", message);
    return rawCards.map(card => ({
      ...card,
      zh: `AI 拆解失败：${message}`,
      scene: message
    }));
  }
  return rawCards;
}

async function callDeepSeek(cards, context) {
  const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  const messages = [
    { role: "system", content: "你是泰语老师。把泰语字幕整理成中文学习卡片。只返回 JSON 数组，不要 Markdown。" },
    { role: "user", content: JSON.stringify({
      title: context.title,
      source: context.source,
      required_shape: {
        thai: "泰语原句",
        zh: "自然中文翻译",
        roman: "适合中文学习者的罗马音",
        scene: "这句话的日常用法",
        words: [["泰语词或短语", "中文解释"]],
        examples: ["泰语例句 中文解释"],
        syllables: "适合跟读的音节拆分"
      },
      lines: cards.map(card => card.thai)
    }) }
  ];

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DeepSeek 请求失败：${response.status}${text ? " " + text.slice(0, 160) : ""}`);
  }

  const data = await response.json();
  const output = data.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(extractJson(output));
  return Array.isArray(parsed) ? parsed : parsed.cards;
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  const startArray = trimmed.indexOf("[");
  const endArray = trimmed.lastIndexOf("]");
  if (startArray >= 0 && endArray > startArray) return trimmed.slice(startArray, endArray + 1);

  const startObject = trimmed.indexOf("{");
  const endObject = trimmed.lastIndexOf("}");
  if (startObject >= 0 && endObject > startObject) return trimmed.slice(startObject, endObject + 1);

  return trimmed;
}

function guessMode(title, lines) {
  const joined = `${title} ${lines.map(line => line.text).join(" ")}`;
  return /เพลง|song|lyrics|mv|music/i.test(joined) ? "song" : "learn";
}
