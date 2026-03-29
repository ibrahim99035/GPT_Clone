import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { InferenceClient } from "@huggingface/inference";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(process.cwd(), "public");
const DATA_DIR = path.join(process.cwd(), "data");
const CHATS_DB_FILE = path.join(DATA_DIR, "chats.json");
const GENERATED_IMAGES_DIR = path.join(process.cwd(), "generated-images");
const IMAGE_TEXT_MODEL = process.env.GEMINI_IMAGE_PROMPT_MODEL || "gemini-3-flash-preview";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image-preview";
const HF_IMAGE_PROVIDER = process.env.HF_IMAGE_PROVIDER || "auto";
const HF_IMAGE_MODEL = process.env.HF_IMAGE_MODEL || "Qwen/Qwen-Image";

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/generated-images", express.static(GENERATED_IMAGES_DIR));

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ Error: GEMINI_API_KEY environment variable is not set.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const hfClient = process.env.HF_TOKEN ? new InferenceClient(process.env.HF_TOKEN) : null;

/**
 * Models exposed for a frontend dropdown.
 * Keep labels UI-friendly while preserving model IDs.
 */
const AVAILABLE_MODELS = [
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash (Fast)",
    type: "text"
  },
  {
    id: "gemini-3-pro-preview",
    label: "Gemini 3 Pro (Best quality)",
    type: "text"
  },
  {
    id: "gemini-3.1-flash-image-preview",
    label: "Gemini 3.1 Flash Image",
    type: "image"
  }
];

/**
 * Lightweight JSON-file database.
 * chats = {
 *   [chatId]: {
 *      id,
 *      title,
 *      model,
 *      createdAt,
 *      updatedAt,
 *      messages: [{ id, role, content, createdAt, model }]
 *   }
 * }
 */
const chats = {};

const nowISO = () => new Date().toISOString();

function loadChatsFromDisk() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CHATS_DB_FILE)) {
      fs.writeFileSync(CHATS_DB_FILE, JSON.stringify({ chats: {} }, null, 2), "utf8");
      return;
    }

    const raw = fs.readFileSync(CHATS_DB_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    const savedChats = parsed?.chats;

    if (savedChats && typeof savedChats === "object") {
      Object.assign(chats, savedChats);
    }
  } catch (error) {
    console.error("❌ Failed to load chat database:", error?.message || error);
  }
}

function saveChatsToDisk() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CHATS_DB_FILE, JSON.stringify({ chats }, null, 2), "utf8");
}

loadChatsFromDisk();

function ensureChat(chatId) {
  const chat = chats[chatId];
  if (!chat) {
    const error = new Error("Chat not found");
    error.status = 404;
    throw error;
  }
  return chat;
}

function mapHistoryForGemini(messages) {
  // Gemini chat history expects user/model roles.
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "gpt-clone-server", time: nowISO() });
});

app.get("/api/models", (_req, res) => {
  res.json({ models: AVAILABLE_MODELS });
});

app.get("/api/chats", (_req, res) => {
  const list = Object.values(chats)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(({ messages, ...rest }) => ({
      ...rest,
      messageCount: messages.length,
      lastMessage: messages[messages.length - 1] || null
    }));

  res.json({ chats: list });
});

app.post("/api/chats", (req, res) => {
  const { title, model = "gemini-3-flash-preview" } = req.body || {};

  const exists = AVAILABLE_MODELS.some((m) => m.id === model && m.type === "text");
  if (!exists) {
    return res.status(400).json({ error: "Invalid chat model selected" });
  }

  const id = randomUUID();
  const ts = nowISO();

  const chat = {
    id,
    title: typeof title === "string" && title.trim() ? title.trim() : "New Chat",
    model,
    createdAt: ts,
    updatedAt: ts,
    messages: []
  };

  chats[id] = chat;
  saveChatsToDisk();
  return res.status(201).json(chat);
});

app.get("/api/chats/:chatId", (req, res, next) => {
  try {
    const chat = ensureChat(req.params.chatId);
    res.json(chat);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/chats/:chatId", (req, res, next) => {
  try {
    const chat = ensureChat(req.params.chatId);
    const { title, model } = req.body || {};

    if (typeof title === "string" && title.trim()) {
      chat.title = title.trim();
    }

    if (model) {
      const validModel = AVAILABLE_MODELS.some((m) => m.id === model && m.type === "text");
      if (!validModel) {
        return res.status(400).json({ error: "Invalid chat model selected" });
      }
      chat.model = model;
    }

    chat.updatedAt = nowISO();
    saveChatsToDisk();
    res.json(chat);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/chats/:chatId", (req, res, next) => {
  try {
    ensureChat(req.params.chatId);
    delete chats[req.params.chatId];
    saveChatsToDisk();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/chats/:chatId/messages", async (req, res, next) => {
  try {
    const chat = ensureChat(req.params.chatId);
    const { content, model } = req.body || {};

    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "content is required" });
    }

    const selectedModel = model || chat.model;
    const validModel = AVAILABLE_MODELS.some((m) => m.id === selectedModel && m.type === "text");
    if (!validModel) {
      return res.status(400).json({ error: "Invalid text model selected" });
    }

    const userMessage = {
      id: randomUUID(),
      role: "user",
      content: content.trim(),
      model: selectedModel,
      createdAt: nowISO()
    };
    chat.messages.push(userMessage);

    const modelClient = genAI.getGenerativeModel({ model: selectedModel });
    const history = mapHistoryForGemini(chat.messages.slice(0, -1));
    const chatSession = modelClient.startChat({ history });

    const response = await chatSession.sendMessage(userMessage.content);
    const assistantText = response.response.text();

    const assistantMessage = {
      id: randomUUID(),
      role: "assistant",
      content: assistantText,
      model: selectedModel,
      createdAt: nowISO()
    };

    chat.messages.push(assistantMessage);
    chat.model = selectedModel;
    chat.updatedAt = nowISO();
    saveChatsToDisk();

    res.status(201).json({ user: userMessage, assistant: assistantMessage, chatId: chat.id });
  } catch (error) {
    next(error);
  }
});

/**
 * Main image route uses Hugging Face Inference Providers.
 * Optional fallback prompt expansion uses Gemini text model if enabled.
 */
app.post("/api/images/generate", async (req, res, next) => {
  try {
    const {
      creativeRequest = "A product photo of a modern minimalist sneaker in an upscale apartment lobby, cinematic light, high detail",
      outputFileName = `generated_${Date.now()}.png`,
      provider = HF_IMAGE_PROVIDER,
      model = HF_IMAGE_MODEL,
      numInferenceSteps = 5,
      useGeminiPromptRewrite = false
    } = req.body || {};

    if (typeof creativeRequest !== "string" || !creativeRequest.trim()) {
      return res.status(400).json({ error: "creativeRequest is required" });
    }

    if (!hfClient) {
      return res.status(503).json({
        error: "HF_TOKEN is missing. Add HF_TOKEN in .env to use Hugging Face image generation."
      });
    }

    let promptUsed = creativeRequest.trim();

    if (useGeminiPromptRewrite) {
      const textModel = genAI.getGenerativeModel({ model: IMAGE_TEXT_MODEL });
      const promptGeneration = await textModel.generateContent(promptUsed);
      promptUsed = promptGeneration.response.text();
    }

    const attemptedProviders = [];
    const fallbackProviders = [provider, "auto", "hf-inference"].filter(
      (value, index, arr) => typeof value === "string" && value.trim() && arr.indexOf(value) === index
    );

    let generatedImage = null;
    let selectedProvider = provider;
    let lastProviderError = null;

    for (const providerCandidate of fallbackProviders) {
      attemptedProviders.push(providerCandidate);
      try {
        generatedImage = await hfClient.textToImage({
          provider: providerCandidate,
          model,
          inputs: promptUsed,
          parameters: {
            num_inference_steps: Number(numInferenceSteps) || 5
          }
        });
        selectedProvider = providerCandidate;
        break;
      } catch (providerError) {
        lastProviderError = providerError;
      }
    }

    if (!generatedImage && lastProviderError) {
      throw lastProviderError;
    }

    if (!generatedImage) {
      return res.status(502).json({ error: "Image data was not returned by Hugging Face provider" });
    }

    const safeName = path.basename(outputFileName).replace(/[^a-zA-Z0-9._-]/g, "_");
    fs.mkdirSync(GENERATED_IMAGES_DIR, { recursive: true });

    const outputPath = path.join(GENERATED_IMAGES_DIR, safeName);
    const imageArrayBuffer = await generatedImage.arrayBuffer();
    const buffer = Buffer.from(imageArrayBuffer);
    fs.writeFileSync(outputPath, buffer);

    const imageUrl = `/generated-images/${encodeURIComponent(safeName)}`;

    res.status(201).json({
      promptUsed,
      outputFile: outputPath,
      fileName: safeName,
      imageUrl,
      model,
      provider: selectedProvider,
      attemptedProviders
    });
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      return res.status(401).json({ error: "Invalid or unauthorized HF_TOKEN for Inference Providers." });
    }
    if (error?.status === 429) {
      return res.status(429).json({ error: "Hugging Face rate limit hit. Wait and try again." });
    }
    if (error?.status === 400 || error?.status === 404) {
      return res.status(400).json({
        error: "Invalid Hugging Face image provider/model or unsupported parameters."
      });
    }
    if (String(error?.message || "").toLowerCase().includes("pre-paid credits are required")) {
      return res.status(402).json({
        error:
          "Selected provider requires paid credits. Set HF_IMAGE_PROVIDER=auto (or hf-inference) in .env and retry."
      });
    }
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error?.status || 500;
  const message = error?.message || "Internal Server Error";
  res.status(status).json({ error: message });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
