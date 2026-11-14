# Stillroom

A small, locally hosted AI chat app with a dark, warm interface. It uses local models through Ollama, recommends a model based on installed model sizes and system RAM, and lets you switch models in the chat. Prompts are sent only to Ollama on your machine; no external AI API or key is needed.

## Run on Windows

1. Install Node.js 20 or newer.
2. Install Ollama and make sure its local service is running. Pull at least one model, for example:

   ```powershell
   ollama pull qwen3:4b
   ```

3. In VS Code, open a PowerShell terminal in this folder and start the app:

   ```powershell
   npm start
   ```

   Startup builds the small C file-writing helper with `clang`. If the compiler or its C headers are unavailable, the app falls back to its built-in Node writer.

4. Open <http://127.0.0.1:3000>.

The app keeps conversation history in memory in the current browser tab only. Select **New conversation** to clear it.

## Create a file

Ask naturally for a file and include its name and extension, or use the explicit command form. For example:

```text
Create hello.asm: a small commented x86-64 NASM program that prints Hello.
```

The generated text file is saved in `write in this folder`. Supported formats include Assembly (`.asm`, `.s`), C/C++ (`.c`, `.cpp`, `.h`, `.hpp`), Markdown (`.md`), HTML (`.html`), JavaScript (`.js`), Python (`.py`), JSON (`.json`), and plain text (`.txt`). Files are never overwritten, and generated source is saved as text rather than compiled or executed. Generated files are ignored by Git so private output is not published accidentally.
