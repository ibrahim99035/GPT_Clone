import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ Error: GEMINI_API_KEY environment variable is not set.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
 * In-memory store (no auth, lightweight prototype).
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
    res.json(chat);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/chats/:chatId", (req, res, next) => {
  try {
    ensureChat(req.params.chatId);
    delete chats[req.params.chatId];
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

    res.status(201).json({ user: userMessage, assistant: assistantMessage, chatId: chat.id });
  } catch (error) {
    next(error);
  }
});

/**
 * Two-stage image generation route based on your provided workflow:
 * 1) Text model writes a strong photography prompt.
 * 2) Image model generates and saves PNG.
 */
app.post("/api/images/generate", async (req, res, next) => {
  try {
    const {
      creativeRequest = "Write a high-quality, professional photography prompt for a modern, minimalist sneaker. The setting should be an upscale, well-lit apartment lobby.",
      outputFileName = `generated_${Date.now()}.png`
    } = req.body || {};

    const textModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    const promptGeneration = await textModel.generateContent(creativeRequest);
    const complexPrompt = promptGeneration.response.text();

    const imageModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-image-preview" });
    const imageGeneration = await imageModel.generateContent({
      contents: [{ parts: [{ text: complexPrompt }] }],
      generationConfig: {
        aspectRatio: "1:1",
        sampleCount: 1
      }
    });

    const imagePart = imageGeneration.response?.candidates?.[0]?.content?.parts?.[0];
    if (!imagePart?.inlineData?.data) {
      return res.status(502).json({ error: "Image data was not returned by model" });
    }

    const safeName = path.basename(outputFileName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const outputDir = path.join(process.cwd(), "generated-images");
    fs.mkdirSync(outputDir, { recursive: true });

    const outputPath = path.join(outputDir, safeName);
    const buffer = Buffer.from(imagePart.inlineData.data, "base64");
    fs.writeFileSync(outputPath, buffer);

    res.status(201).json({
      promptUsed: complexPrompt,
      outputFile: outputPath,
      fileName: safeName
    });
  } catch (error) {
    if (error?.status === 429) {
      return res.status(429).json({ error: "Free Tier Rate Limit hit. Wait 60 seconds and try again." });
    }
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error?.status || 500;
  const message = error?.message || "Internal Server Error";
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
