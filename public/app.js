(() => {
  const messagesEl = document.getElementById("messages");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const statusBar = document.getElementById("status-bar");
  const suggestionButtons = document.querySelectorAll(".suggestion-btn");
  const toggle = document.getElementById("drawer-toggle");
  const guidePanel = document.getElementById("guide-drawer");
  const overlay = document.getElementById("drawer-overlay");

  const conversation = [];
  let busy = false;

  const escapeHtml = (value = "") =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const sanitizeUrl = (url = "") => {
    const trimmed = String(url).trim();
    if (/^(https?:|mailto:)/i.test(trimmed)) {
      return escapeHtml(trimmed);
    }
    return "#";
  };

  const formatInline = (text, depth = 0) => {
    if (depth > 4) return escapeHtml(text);
    if (typeof text !== "string" || !text.length) return "";

    const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^\*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    let lastIndex = 0;
    const tokens = [];
    let match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        tokens.push({ type: "text", value: text.slice(lastIndex, match.index) });
      }

      const token = match[0];
      if ((token.startsWith("**") && token.endsWith("**")) || (token.startsWith("__") && token.endsWith("__"))) {
        tokens.push({ type: "strong", value: token.slice(2, -2) });
      } else if ((token.startsWith("*") && token.endsWith("*")) || (token.startsWith("_") && token.endsWith("_"))) {
        tokens.push({ type: "em", value: token.slice(1, -1) });
      } else if (token.startsWith("`") && token.endsWith("`")) {
        tokens.push({ type: "code", value: token.slice(1, -1) });
      } else {
        const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          tokens.push({ type: "link", label: linkMatch[1], href: linkMatch[2] });
        } else {
          tokens.push({ type: "text", value: token });
        }
      }

      lastIndex = pattern.lastIndex;
    }

    if (lastIndex < text.length) {
      tokens.push({ type: "text", value: text.slice(lastIndex) });
    }

    return tokens
      .map((token) => {
        switch (token.type) {
          case "strong":
            return `<strong>${formatInline(token.value, depth + 1)}</strong>`;
          case "em":
            return `<em>${formatInline(token.value, depth + 1)}</em>`;
          case "code":
            return `<code>${escapeHtml(token.value)}</code>`;
          case "link": {
            const href = sanitizeUrl(token.href);
            const label = formatInline(token.label, depth + 1) || escapeHtml(token.label);
            return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
          }
          default:
            return escapeHtml(token.value);
        }
      })
      .join("");
  };

  const markdownToHtml = (source = "") => {
    if (typeof source !== "string") return "";
    const normalized = source.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const html = [];
    let paragraph = [];
    let listType = null;
    let inBlockquote = false;
    let fence = null;
    const codeLines = [];

    const closeParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${formatInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    };

    const closeList = () => {
      if (!listType) return;
      html.push(listType === "ul" ? "</ul>" : "</ol>");
      listType = null;
    };

    const closeBlockquote = () => {
      if (!inBlockquote) return;
      html.push("</blockquote>");
      inBlockquote = false;
    };

    const closeCodeBlock = () => {
      if (!fence) return;
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      fence = null;
      codeLines.length = 0;
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, "");

      if (fence) {
        if (line.startsWith(fence)) {
          closeCodeBlock();
        } else {
          codeLines.push(rawLine);
        }
        continue;
      }

      if (/^```/.test(line)) {
        closeParagraph();
        closeList();
        closeBlockquote();
        fence = line.trim();
        codeLines.length = 0;
        continue;
      }

      if (!line.trim()) {
        closeParagraph();
        closeList();
        closeBlockquote();
        continue;
      }

      if (line.startsWith(">")) {
        closeParagraph();
        closeList();
        if (!inBlockquote) {
          html.push("<blockquote>");
          inBlockquote = true;
        }
        const inner = line.replace(/^>\s?/, "");
        html.push(`<p>${formatInline(inner)}</p>`);
        continue;
      }

      if (inBlockquote) {
        closeBlockquote();
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeParagraph();
        closeList();
        const level = heading[1].length;
        html.push(`<h${level}>${formatInline(heading[2].trim())}</h${level}>`);
        continue;
      }

      if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
        closeParagraph();
        closeList();
        html.push("<hr>");
        continue;
      }

      const unordered = line.match(/^[-*+]\s+(.*)$/);
      if (unordered) {
        closeParagraph();
        if (listType !== "ul") {
          closeList();
          html.push("<ul>");
          listType = "ul";
        }
        html.push(`<li>${formatInline(unordered[1])}</li>`);
        continue;
      }

      const ordered = line.match(/^(\d+)\.\s+(.*)$/);
      if (ordered) {
        closeParagraph();
        if (listType !== "ol") {
          closeList();
          html.push("<ol>");
          listType = "ol";
        }
        html.push(`<li>${formatInline(ordered[2])}</li>`);
        continue;
      }

      paragraph.push(line);
    }

    closeCodeBlock();
    closeParagraph();
    closeList();
    closeBlockquote();

    const combined = html.join("");
    if (!combined) {
      return `<p>${escapeHtml(source)}</p>`;
    }
    return combined;
  };

  const limitMarkdown = (text, maxChars) => {
    if (typeof text !== "string" || text.length === 0 || maxChars <= 0) {
      return { text: "", truncated: Boolean(text && text.length > 0) };
    }

    if (text.length <= maxChars) {
      return { text, truncated: false };
    }

    return { text: text.slice(0, maxChars).trimEnd(), truncated: true };
  };

  const formatReply = (raw, { truncated = false } = {}) => {
    const safe = typeof raw === "string" ? raw : "";
    const body = markdownToHtml(safe);
    const note = truncated ? '<p class="reply-truncated">※ 長文のため一部のみ表示しています。</p>' : "";
    return `<div class="reply-markdown">${body}${note}</div>`;
  };

  const renderStatus = (text, variant = "default") => {
    statusBar.textContent = "";
    statusBar.classList.remove("error", "success");
    if (variant === "error") statusBar.classList.add("error");
    if (variant === "success") statusBar.classList.add("success");
    if (!text) return;

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    if (variant === "error") {
      path.setAttribute("d", "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z");
    } else if (variant === "success") {
      path.setAttribute("d", "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 14-4-4 1.41-1.41L11 13.17l4.59-4.58L17 10l-6 6Z");
    } else {
      path.setAttribute("d", "M11 7h2v5h-2zm0 6h2v2h-2zm1-11C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8Z");
    }

    icon.appendChild(path);
    statusBar.appendChild(icon);
    statusBar.appendChild(document.createTextNode(text));
  };

  const addMessage = (content, role, { isHtml = false } = {}) => {
    const bubble = document.createElement("div");
    bubble.classList.add("bubble", role);
    bubble.innerHTML = isHtml ? content : escapeHtml(content).replace(/\n/g, "<br>");
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  };

  const setBusy = (state) => {
    busy = state;
    input.disabled = state;
    form.querySelector('button[type="submit"]').disabled = state;
  };

  const closeDrawer = () => {
    guidePanel.classList.remove("open");
    overlay.classList.remove("visible");
  };

  const openDrawer = () => {
    guidePanel.classList.add("open");
    overlay.classList.add("visible");
  };

  const renderThinkingIndicator = () => `
    <div class="thinking-indicator">
      <span class="thinking-dot"></span>
      <span class="thinking-dot"></span>
      <span class="thinking-dot"></span>
    </div>
  `;

  const removeFormalPreface = (text) =>
    text.replace(/^承知いたしました。[^\n]*\n?/u, "").trimStart();

  const sendMessage = async (rawText) => {
    const trimmed = rawText.trim();
    if (!trimmed || busy) return;

    addMessage(trimmed, "user");
    conversation.push({ role: "user", text: trimmed });
    setBusy(true);

    const thinking = addMessage(renderThinkingIndicator(), "bot", { isHtml: true });
    thinking.classList.add("thinking");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history: conversation })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `サーバーエラー (${response.status})`);
      }

      const data = await response.json();
      const fallbackMessage = "回答を取得できませんでした。時間をおいて再試行してください。";
      const rawReply = removeFormalPreface((data.reply || fallbackMessage).trim());
      const { text: limitedReply, truncated } = limitMarkdown(rawReply, 6000);
      const displayHtml = formatReply(limitedReply, { truncated });
      const statusMessage = data.notice || "Gemini モデルから回答しました。";

      thinking.classList.remove("thinking");
      thinking.innerHTML = displayHtml;
      conversation.push({ role: "model", text: rawReply });
      renderStatus(statusMessage, "success");
    } catch (error) {
      const fallbackHtml = formatReply("エラーが発生しました。後ほど再度お試しください。");
      thinking.classList.remove("thinking");
      thinking.innerHTML = fallbackHtml;
      renderStatus(error.message || "予期せぬエラーが発生しました。", "error");
    } finally {
      setBusy(false);
      input.focus();
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value;
    input.value = "";
    sendMessage(value);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.dispatchEvent(new Event("submit"));
    }
  });

  suggestionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.message;
      input.focus();
      if (guidePanel.classList.contains("open")) closeDrawer();
    });
  });

  toggle.addEventListener("click", () => {
    if (guidePanel.classList.contains("open")) {
      closeDrawer();
    } else {
      openDrawer();
    }
  });

  overlay.addEventListener("click", closeDrawer);

  const welcome = [
    "海外で重大事故が発生した際の初動対応を中心に、証拠保全と社内体制構築をサポートします。",
    "知りたいトピックを入力するか、右の質問例から選んでください。"
  ].join("\n\n");

  addMessage(formatReply(welcome), "bot", { isHtml: true });
  conversation.push({ role: "model", text: welcome });
})();

