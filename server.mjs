import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const ollamaUrl = "http://127.0.0.1:11434/api/chat";
const ollamaTagsUrl = "http://127.0.0.1:11434/api/tags";
const preferredModel = process.env.OLLAMA_MODEL || "";
const indexPath = fileURLToPath(new URL("./index.html", import.meta.url));
const nativeWriterPath = fileURLToPath(new URL(
  process.platform === "win32" ? "./.build/file_writer.exe" : "./.build/file_writer",
  import.meta.url
));
const outputDirectory = resolve(fileURLToPath(new URL("./write in this folder/", import.meta.url)));
const maxBodyBytes = 96 * 1024;
const maxMessages = 20;
const maxMessageLength = 4000;
const maxFileBytes = 256 * 1024;
const allowedExtensions = new Set([
  ".asm", ".bat", ".c", ".cpp", ".cs", ".css", ".csv", ".go", ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json", ".md", ".ps1", ".py", ".rs", ".s", ".sh", ".sql", ".svg", ".toml", ".ts", ".txt", ".xml", ".yaml", ".yml"
]);
let modelCache = null;
let modelCacheTime = 0;

function cleanModelText(content) {
  return content
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

function parseWriteCommand(content) {
  const commandMatch = content.match(/^\/?write(?:\s+in\s+the\s+file)?\s+([^\s:]+)\s*::\s*([\s\S]+)$/i);
  if (commandMatch) return { filename: commandMatch[1], prompt: commandMatch[2].trim() };
  if (/^\/?write\b/i.test(content)) {
    return { error: "Name the file and describe it, for example: write a hello.asm file that prints Hello." };
  }

  const extensions = [...allowedExtensions].map(extension => extension.slice(1)).join("|");
  const filename = `([A-Za-z0-9][A-Za-z0-9._-]*\\.(?:${extensions}))`;
  const namedFile = content.match(new RegExp(
    `^(?:please\\s+)?(?:can you\\s+)?(?:write|create|make|save)(?:\\s+me)?\\s+(?:(?:a\\s+)?file\\s+(?:named\\s+|called\\s+)?|named\\s+|called\\s+)?${filename}\\s*(?:::|:|\\s+(?:with|containing|about|for|that\\s+(?:contains|prints|says|does))\\s+)\\s*([\\s\\S]+)$`,
    "i"
  ));
  if (namedFile) return { filename: namedFile[1], prompt: namedFile[2].trim() };

  const descriptionFirst = content.match(new RegExp(
    `^(?:please\\s+)?(?:write|create|make|save)\\s+([\\s\\S]+?)\\s+(?:as|to|in)\\s+(?:(?:a|the)\\s+)?(?:file\\s+)?${filename}[.!]?$`,
    "i"
  ));
  if (descriptionFirst) return { filename: descriptionFirst[2], prompt: descriptionFirst[1].trim() };
  return null;
}

async function getModels() {
  if (modelCache && Date.now() - modelCacheTime < 30_000) return modelCache;

  const response = await fetch(ollamaTagsUrl, { signal: AbortSignal.timeout(5_000) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(result?.models)) {
    throw new Error("Couldn't read the installed models from Ollama.");
  }

  modelCache = result.models
    .filter(item => typeof item.name === "string")
    .map(item => ({
      name: item.name,
      size: Number.isFinite(item.size) ? item.size : 0,
      parameterSize: item.details?.parameter_size || ""
    }));
  modelCacheTime = Date.now();
  return modelCache;
}

function recommendModel(models) {
  if (preferredModel && models.some(model => model.name === preferredModel)) return preferredModel;
  if (models.length === 0) return null;

  const memoryBudget = os.totalmem() * 0.4;
  const fittingModels = models.filter(model => model.size > 0 && model.size <= memoryBudget);
  const candidates = fittingModels.length ? fittingModels : [...models].sort((a, b) => a.size - b.size).slice(0, 1);
  const generalModels = candidates.filter(model => !/coder|codeqwen/i.test(model.name));
  const pool = generalModels.length ? generalModels : candidates;
  return [...pool].sort((a, b) => b.size - a.size)[0]?.name || models[0].name;
}

async function chooseModel(requestedModel) {
  const models = await getModels();
  const selectedModel = typeof requestedModel === "string" && requestedModel !== "auto"
    ? requestedModel
    : recommendModel(models);
  if (!selectedModel) throw new Error("Ollama has no models installed. Pull a model, then reload this page.");
  if (!models.some(model => model.name === selectedModel)) {
    throw new Error("That model is no longer installed. Choose another model.");
  }
  return { selectedModel, models };
}

function writeWithNativeHelper(filename, content) {
  return new Promise((resolve, reject) => {
    const process = spawn(nativeWriterPath, [outputDirectory, filename], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"]
    });
    let errorOutput = "";

    process.stderr.setEncoding("utf8");
    process.stderr.on("data", chunk => { errorOutput += chunk; });
    process.on("error", error => {
      if (error.code === "ENOENT") resolve(false);
      else reject(error);
    });
    process.on("close", code => {
      if (code === 0) resolve(true);
      else if (code === 4) {
        const error = new Error(`${filename} already exists. Choose another name; existing files are never overwritten.`);
        error.code = "EEXIST";
        reject(error);
      } else {
        reject(new Error(errorOutput.trim() || `The native file writer exited with code ${code}.`));
      }
    });
    process.stdin.on("error", () => {});
    process.stdin.end(content, "utf8");
  });
}

async function handleWriteFile(response, messages, command, selectedModel) {
  if (command.error) {
    sendJson(response, 400, { error: command.error });
    return;
  }

  const { filename, prompt } = command;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(filename) || !allowedExtensions.has(extname(filename).toLowerCase())) {
    sendJson(response, 400, {
      error: "Choose a simple filename with a supported text extension, such as notes.md, page.html, or program.asm."
    });
    return;
  }

  const targetPath = resolve(outputDirectory, filename);
  if (!targetPath.startsWith(`${outputDirectory}${sep}`)) {
    sendJson(response, 400, { error: "Files can only be created in the designated folder." });
    return;
  }

  try {
    const upstream = await fetch(ollamaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selectedModel,
        stream: false,
        think: false,
        format: {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
          additionalProperties: false
        },
        messages: [
          {
            role: "system",
            content: `Create concise, complete contents for a new ${extname(filename).slice(1)} text file. Return a JSON object with one string property named "content". Put only the file contents in that property. Do not include reasoning, explanations, or Markdown fences.`
          },
          ...messages.slice(0, -1).map(({ role, content }) => ({ role, content: content.trim() })),
          { role: "user", content: prompt }
        ],
        options: { num_predict: 600 }
      }),
      signal: AbortSignal.timeout(180_000)
    });

    const result = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      sendJson(response, 502, {
        error: typeof result?.error === "string"
          ? `Qwen couldn't create the file: ${result.error}`
          : `Qwen couldn't create the file (${upstream.status}).`
      });
      return;
    }

    let content = "";
    try {
      const generated = JSON.parse(cleanModelText(result?.message?.content || ""));
      if (typeof generated.content === "string") content = generated.content;
    } catch {
      sendJson(response, 502, { error: "Qwen didn't return valid file contents, so nothing was written. Please try again with a simpler request." });
      return;
    }
    if (!content.trim()) {
      sendJson(response, 502, { error: "Qwen returned an empty file. Please try a more specific request." });
      return;
    }
    if (Buffer.byteLength(content, "utf8") > maxFileBytes) {
      sendJson(response, 413, { error: "The generated file is too large. Ask for a shorter file." });
      return;
    }

    await mkdir(outputDirectory, { recursive: true });
    const writtenNatively = await writeWithNativeHelper(filename, content);
    if (!writtenNatively) {
      await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
    }
    sendJson(response, 200, { reply: `Created ${filename} in "write in this folder".` });
  } catch (error) {
    if (error.code === "EEXIST") {
      sendJson(response, 409, { error: `${filename} already exists. Choose another name; existing files are never overwritten.` });
      return;
    }
    console.error("Could not create local file:", error.message);
    sendJson(response, 502, {
      error: error.name === "TimeoutError"
        ? "Qwen took too long to create the file. Please try again."
        : "Couldn't reach local Ollama or create the file. Make sure Ollama is running and try again."
    });
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Send a valid JSON request.");
    error.statusCode = 400;
    throw error;
  }
}

function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxMessages) {
    return "Send between 1 and 20 messages.";
  }
  if (value.some(message =>
    !message ||
    !["user", "assistant"].includes(message.role) ||
    typeof message.content !== "string" ||
    !message.content.trim() ||
    message.content.length > maxMessageLength
  )) {
    return "Each message must have a user or assistant role and contain 1–4,000 characters.";
  }
  if (value[value.length - 1].role !== "user") {
    return "The last message must be from you.";
  }
  return null;
}

async function handleChat(request, response) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  const validationError = validateMessages(body.messages);
  if (validationError) {
    sendJson(response, 400, { error: validationError });
    return;
  }

  let modelSelection;
  try {
    modelSelection = await chooseModel(body.model);
  } catch (error) {
    sendJson(response, 503, { error: error.message });
    return;
  }

  const writeCommand = parseWriteCommand(body.messages[body.messages.length - 1].content.trim());
  if (writeCommand) {
    await handleWriteFile(response, body.messages, writeCommand, modelSelection.selectedModel);
    return;
  }

  try {
    const upstream = await fetch(ollamaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelSelection.selectedModel,
        stream: false,
        think: false,
        messages: [
          {
            role: "system",
            content: "You are Stillroom, a thoughtful and capable AI assistant. Be clear, kind, and useful. Match the user's tone, explain things plainly, and be honest when you are uncertain."
          },
          ...body.messages.map(({ role, content }) => ({ role, content: content.trim() }))
        ],
        options: { num_predict: 600 }
      }),
      signal: AbortSignal.timeout(180_000)
    });

    const result = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const ollamaMessage = result?.error;
      console.error(`Ollama request failed (${upstream.status}).`);
      sendJson(response, upstream.status === 404 ? 503 : 502, {
        error: typeof ollamaMessage === "string"
          ? `Ollama couldn't complete the request: ${ollamaMessage}`
          : `Ollama couldn't complete the request (${upstream.status}).`
      });
      return;
    }

    const reply = typeof result?.message?.content === "string"
      ? cleanModelText(result.message.content)
      : null;
    if (typeof reply !== "string" || !reply.trim()) {
      console.error("Ollama returned an unexpected or empty response.");
      sendJson(response, 502, { error: "Qwen returned an empty reply. Please try again." });
      return;
    }
    sendJson(response, 200, { reply, model: modelSelection.selectedModel });
  } catch (error) {
    console.error("Could not reach local Ollama:", error.message);
    sendJson(response, 502, {
      error: error.name === "TimeoutError"
        ? "Qwen took too long to respond. Please try again."
        : "Couldn't reach Ollama at 127.0.0.1:11434. Make sure Ollama is running, then try again."
    });
  }
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host || host}`).pathname;
  if (request.method === "GET" && pathname === "/") {
    try {
      const html = await readFile(indexPath);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(html);
    } catch (error) {
      console.error("Could not read index.html:", error.message);
      sendJson(response, 500, { error: "The chat page could not be loaded." });
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/models") {
    try {
      const models = await getModels();
      sendJson(response, 200, {
        models,
        recommended: recommendModel(models),
        memoryGb: Number((os.totalmem() / (1024 ** 3)).toFixed(1))
      });
    } catch (error) {
      sendJson(response, 503, { error: `${error.message} Make sure Ollama is running.` });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/chat") {
    await handleChat(request, response);
    return;
  }

  sendJson(response, 404, { error: "Not found." });
});

server.on("error", error => {
  console.error("Server error:", error.message);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Stillroom is running at http://${host}:${port}`);
  console.log("Model selection uses installed Ollama models and available system RAM.");
});
