const API_BASE = "";
const CACHE_KEY = "gpt_clone_local_cache_v1";

const state = {
	models: [],
	chats: {},
	activeChatId: null,
	isSending: false,
	selectedModel: "gemini-3-flash-preview",
	activeView: "chat",
	imageHistory: [],
	isGeneratingImage: false
};

const el = {
	chatList: document.getElementById("chatList"),
	newChatBtn: document.getElementById("newChatBtn"),
	deleteChatBtn: document.getElementById("deleteChatBtn"),
	chatTitle: document.getElementById("chatTitle"),
	chatMeta: document.getElementById("chatMeta"),
	messages: document.getElementById("messages"),
	composerForm: document.getElementById("composerForm"),
	messageInput: document.getElementById("messageInput"),
	sendBtn: document.getElementById("sendBtn"),
	status: document.getElementById("status"),
	globalModel: document.getElementById("globalModel"),
	chatViewBtn: document.getElementById("chatViewBtn"),
	imageViewBtn: document.getElementById("imageViewBtn"),
	chatPanel: document.getElementById("chatPanel"),
	imagePanel: document.getElementById("imagePanel"),
	imageForm: document.getElementById("imageForm"),
	imagePromptInput: document.getElementById("imagePromptInput"),
	generateImageBtn: document.getElementById("generateImageBtn"),
	imageStatus: document.getElementById("imageStatus"),
	imagePreview: document.getElementById("imagePreview")
};

function setStatus(text) {
	el.status.textContent = text;
}

function saveLocalCache() {
	const payload = {
		activeChatId: state.activeChatId,
		selectedModel: state.selectedModel,
		activeView: state.activeView,
		imageHistory: state.imageHistory,
		chats: state.chats,
		cachedAt: new Date().toISOString()
	};
	localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
}

function loadLocalCache() {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		state.chats = parsed?.chats && typeof parsed.chats === "object" ? parsed.chats : {};
		state.activeChatId = parsed?.activeChatId || null;
		state.selectedModel = parsed?.selectedModel || state.selectedModel;
		state.activeView = parsed?.activeView || state.activeView;
		state.imageHistory = Array.isArray(parsed?.imageHistory) ? parsed.imageHistory : [];
	} catch {
		// Ignore malformed cache.
	}
}

function setImageStatus(text) {
	el.imageStatus.textContent = text;
}

function setView(view) {
	state.activeView = view === "image" ? "image" : "chat";
	const showImage = state.activeView === "image";

	el.chatPanel.classList.toggle("hidden", showImage);
	el.imagePanel.classList.toggle("hidden", !showImage);
	el.deleteChatBtn.classList.toggle("hidden", showImage || !state.activeChatId);

	el.chatViewBtn.className = [
		"px-3 py-1.5 rounded-lg transition text-sm font-medium",
		showImage ? "bg-slate-800 hover:bg-slate-700" : "bg-indigo-600 hover:bg-indigo-500"
	].join(" ");

	el.imageViewBtn.className = [
		"px-3 py-1.5 rounded-lg transition text-sm font-medium",
		showImage ? "bg-indigo-600 hover:bg-indigo-500" : "bg-slate-800 hover:bg-slate-700"
	].join(" ");

	renderImageHistory();
	saveLocalCache();
}

async function api(path, options = {}) {
	const response = await fetch(`${API_BASE}${path}`, {
		headers: { "Content-Type": "application/json", ...(options.headers || {}) },
		...options
	});

	const contentType = response.headers.get("content-type") || "";
	const payload = contentType.includes("application/json") ? await response.json() : null;

	if (!response.ok) {
		throw new Error(payload?.error || `Request failed (${response.status})`);
	}

	return payload;
}

function relativeTime(iso) {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
		Math.round((date.getTime() - Date.now()) / 60000),
		"minute"
	);
}

function escapeText(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function renderModels() {
	el.globalModel.innerHTML = "";
	for (const model of state.models.filter((m) => m.type === "text")) {
		const option = document.createElement("option");
		option.value = model.id;
		option.textContent = model.label;
		if (model.id === state.selectedModel) option.selected = true;
		el.globalModel.appendChild(option);
	}
}

function getChatListSorted() {
	return Object.values(state.chats).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function renderChatList() {
	const list = getChatListSorted();
	el.chatList.innerHTML = "";

	if (list.length === 0) {
		el.chatList.innerHTML = '<p class="text-sm text-slate-400">No chats yet.</p>';
		return;
	}

	for (const chat of list) {
		const isActive = chat.id === state.activeChatId;
		const button = document.createElement("button");
		button.className = [
			"w-full text-left rounded-xl border p-3 transition",
			isActive
				? "bg-indigo-500/20 border-indigo-500/40"
				: "bg-slate-800/70 border-slate-700 hover:border-slate-500"
		].join(" ");

		const last = chat.messages?.[chat.messages.length - 1]?.content || "No messages";
		button.innerHTML = `
			<p class="font-medium text-sm truncate">${escapeText(chat.title || "New Chat")}</p>
			<p class="text-xs text-slate-400 truncate mt-1">${escapeText(last)}</p>
			<p class="text-[11px] text-slate-500 mt-1">${escapeText(relativeTime(chat.updatedAt))}</p>
		`;

		button.addEventListener("click", () => {
			selectChat(chat.id, true);
		});

		el.chatList.appendChild(button);
	}
}

function renderMessages() {
	const chat = state.activeChatId ? state.chats[state.activeChatId] : null;
	el.messages.innerHTML = "";

	if (!chat) {
		el.chatTitle.textContent = "Select or create a chat";
		el.chatMeta.textContent = "Your old history appears on the left.";
		el.deleteChatBtn.classList.add("hidden");
		el.messages.innerHTML = `
			<div class="max-w-3xl mx-auto text-center py-16 text-slate-400">
				<p class="text-lg font-semibold text-slate-200">Start a conversation</p>
				<p class="mt-2 text-sm">Create a chat and send your first prompt.</p>
			</div>
		`;
		return;
	}

	el.chatTitle.textContent = chat.title || "Untitled chat";
	el.chatMeta.textContent = `Model: ${chat.model} • Updated ${relativeTime(chat.updatedAt)}`;
	el.deleteChatBtn.classList.remove("hidden");
	if (state.activeView === "image") {
		el.deleteChatBtn.classList.add("hidden");
	}

	if (!chat.messages || chat.messages.length === 0) {
		el.messages.innerHTML = '<p class="text-sm text-slate-400">No messages yet. Send your first message.</p>';
		return;
	}

	const wrapper = document.createElement("div");
	wrapper.className = "max-w-4xl mx-auto space-y-4";

	for (const message of chat.messages) {
		const isUser = message.role === "user";
		const card = document.createElement("article");
		card.className = [
			"rounded-2xl border p-4 whitespace-pre-wrap break-words",
			isUser
				? "bg-indigo-500/15 border-indigo-500/40 ml-8"
				: "bg-slate-900 border-slate-700 mr-8"
		].join(" ");

		card.innerHTML = `
			<p class="text-xs uppercase tracking-wide ${isUser ? "text-indigo-300" : "text-emerald-300"}">${isUser ? "You" : "Assistant"}</p>
			<p class="mt-2 text-sm leading-7">${escapeText(message.content)}</p>
		`;

		wrapper.appendChild(card);
	}

	el.messages.appendChild(wrapper);
	el.messages.scrollTop = el.messages.scrollHeight;
}

function setSending(isSending) {
	state.isSending = isSending;
	el.sendBtn.disabled = isSending;
	el.messageInput.disabled = isSending;
}

function setImageGenerating(isGenerating) {
	state.isGeneratingImage = isGenerating;
	el.generateImageBtn.disabled = isGenerating;
	el.imagePromptInput.disabled = isGenerating;
}

function renderImageHistory() {
	el.imagePreview.innerHTML = "";

	if (!state.imageHistory.length) {
		el.imagePreview.innerHTML = `
			<div class="rounded-2xl border border-slate-800 p-5 text-sm text-slate-400">
				No images generated yet.
			</div>
		`;
		return;
	}

	const list = document.createElement("div");
	list.className = "space-y-4";

	for (const item of state.imageHistory) {
		const card = document.createElement("article");
		card.className = "rounded-2xl border border-slate-700 bg-slate-900 p-4";
		card.innerHTML = `
			<p class="text-xs text-slate-400">${escapeText(relativeTime(item.createdAt) || "just now")}</p>
			<p class="text-sm mt-1 text-slate-200">${escapeText(item.creativeRequest || "")}</p>
			${item.imageUrl ? `<img src="${escapeText(item.imageUrl)}" alt="Generated image" class="mt-3 rounded-xl border border-slate-700 w-full max-h-[420px] object-contain bg-slate-950" />` : ""}
			${item.promptUsed ? `<details class="mt-3 text-xs text-slate-400"><summary class="cursor-pointer">Show expanded prompt</summary><p class="mt-2 whitespace-pre-wrap leading-6">${escapeText(item.promptUsed)}</p></details>` : ""}
		`;
		list.appendChild(card);
	}

	el.imagePreview.appendChild(list);
}

async function generateImage() {
	const creativeRequest = el.imagePromptInput.value.trim();
	if (!creativeRequest || state.isGeneratingImage) return;

	setImageGenerating(true);
	setImageStatus("Generating image...");

	try {
		const outputFileName = `image_${Date.now()}.png`;
		const result = await api("/api/images/generate", {
			method: "POST",
			body: JSON.stringify({ creativeRequest, outputFileName })
		});

		state.imageHistory.unshift({
			creativeRequest,
			promptUsed: result.promptUsed,
			imageUrl: result.imageUrl,
			model: result.model,
			createdAt: new Date().toISOString()
		});

		if (state.imageHistory.length > 20) {
			state.imageHistory = state.imageHistory.slice(0, 20);
		}

		el.imagePromptInput.value = "";
		renderImageHistory();
		saveLocalCache();
		setImageStatus("Done");
	} catch (error) {
		setImageStatus(error.message);
	} finally {
		setImageGenerating(false);
	}
}

async function loadModels() {
	const data = await api("/api/models");
	state.models = data.models || [];
	if (!state.models.some((m) => m.id === state.selectedModel && m.type === "text")) {
		state.selectedModel = state.models.find((m) => m.type === "text")?.id || "gemini-3-flash-preview";
	}
	renderModels();
}

async function loadChatsFromServer() {
	const data = await api("/api/chats");
	const serverChats = data.chats || [];
	for (const chat of serverChats) {
		const existing = state.chats[chat.id];
		state.chats[chat.id] = {
			...existing,
			...chat,
			messages: existing?.messages || chat.messages || []
		};
	}

	const serverIds = new Set(serverChats.map((c) => c.id));
	for (const localId of Object.keys(state.chats)) {
		if (!serverIds.has(localId)) {
			delete state.chats[localId];
		}
	}

	if (state.activeChatId && !state.chats[state.activeChatId]) {
		state.activeChatId = null;
	}

	renderChatList();
	saveLocalCache();
}

async function selectChat(chatId, fetchDetails = true) {
	state.activeChatId = chatId;
	renderChatList();
	renderMessages();
	saveLocalCache();

	if (!fetchDetails) return;

	try {
		const chat = await api(`/api/chats/${chatId}`);
		state.chats[chatId] = chat;
		state.selectedModel = chat.model || state.selectedModel;
		el.globalModel.value = state.selectedModel;
		renderChatList();
		renderMessages();
		saveLocalCache();
	} catch (error) {
		setStatus(error.message);
	}
}

async function createChat() {
	const chat = await api("/api/chats", {
		method: "POST",
		body: JSON.stringify({ model: state.selectedModel, title: "New Chat" })
	});

	state.chats[chat.id] = chat;
	state.activeChatId = chat.id;
	renderChatList();
	renderMessages();
	saveLocalCache();

	return chat;
}

async function deleteActiveChat() {
	const id = state.activeChatId;
	if (!id) return;

	await api(`/api/chats/${id}`, { method: "DELETE" });
	delete state.chats[id];

	const next = getChatListSorted()[0];
	state.activeChatId = next?.id || null;

	renderChatList();
	renderMessages();
	saveLocalCache();
}

async function sendMessage() {
	const content = el.messageInput.value.trim();
	if (!content || state.isSending) return;

	setSending(true);
	setStatus("Sending...");

	try {
		let chat = state.activeChatId ? state.chats[state.activeChatId] : null;
		if (!chat) {
			chat = await createChat();
		}

		const response = await api(`/api/chats/${chat.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ content, model: state.selectedModel })
		});

		const current = state.chats[chat.id] || chat;
		const messages = current.messages ? [...current.messages] : [];
		messages.push(response.user, response.assistant);

		state.chats[chat.id] = {
			...current,
			model: state.selectedModel,
			messages,
			updatedAt: response.assistant.createdAt
		};

		state.activeChatId = chat.id;
		el.messageInput.value = "";
		renderChatList();
		renderMessages();
		saveLocalCache();
		setStatus("Ready");
	} catch (error) {
		setStatus(error.message);
	} finally {
		setSending(false);
	}
}

function wireEvents() {
	el.newChatBtn.addEventListener("click", async () => {
		try {
			setStatus("Creating chat...");
			await createChat();
			setStatus("Ready");
		} catch (error) {
			setStatus(error.message);
		}
	});

	el.deleteChatBtn.addEventListener("click", async () => {
		try {
			setStatus("Deleting chat...");
			await deleteActiveChat();
			setStatus("Ready");
		} catch (error) {
			setStatus(error.message);
		}
	});

	el.composerForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		await sendMessage();
	});

	el.imageForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		await generateImage();
	});

	el.messageInput.addEventListener("keydown", async (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			await sendMessage();
		}
	});

	el.globalModel.addEventListener("change", async () => {
		state.selectedModel = el.globalModel.value;
		saveLocalCache();

		if (!state.activeChatId) return;

		try {
			const updated = await api(`/api/chats/${state.activeChatId}`, {
				method: "PATCH",
				body: JSON.stringify({ model: state.selectedModel })
			});
			state.chats[updated.id] = updated;
			renderChatList();
			renderMessages();
			saveLocalCache();
		} catch (error) {
			setStatus(error.message);
		}
	});

	el.chatViewBtn.addEventListener("click", () => {
		setView("chat");
	});

	el.imageViewBtn.addEventListener("click", () => {
		setView("image");
	});
}

async function init() {
	loadLocalCache();
	renderChatList();
	renderMessages();
	renderImageHistory();

	wireEvents();

	try {
		setStatus("Loading models...");
		await loadModels();

		setStatus("Loading chat history...");
		await loadChatsFromServer();

		if (state.activeChatId && state.chats[state.activeChatId]) {
			await selectChat(state.activeChatId, true);
		}

		setView(state.activeView);

		setStatus("Ready");
	} catch (error) {
		setStatus(error.message);
	}
}

init();
