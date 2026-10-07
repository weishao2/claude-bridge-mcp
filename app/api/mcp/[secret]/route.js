import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error("Missing environment variable: " + name);
  return value;
}

function apiUrl(path) {
  const base = required("CLAUDE_BASE_URL").replace(/\/+$/, "");
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return base + path.slice(3);
  }
  return base + path;
}

async function callOpenAICompatible(prompt) {
  const response = await fetch(apiUrl("/v1/chat/completions"), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + required("CLAUDE_API_KEY"),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: required("CLAUDE_MODEL"),
      messages: [{ role: "user", content: prompt }],
      stream: false
    }),
    signal: AbortSignal.timeout(55000)
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error("OpenAI-compatible upstream HTTP " + response.status + ": " + detail);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content === "string" && content.trim()) return content;

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }

  throw new Error("Unsupported OpenAI-compatible response format");
}

async function callAnthropicCompatible(prompt) {
  const response = await fetch(apiUrl("/v1/messages"), {
    method: "POST",
    headers: {
      "x-api-key": required("CLAUDE_API_KEY"),
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: required("CLAUDE_MODEL"),
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }]
    }),
    signal: AbortSignal.timeout(55000)
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error("Anthropic-compatible upstream HTTP " + response.status + ": " + detail);
  }

  const data = await response.json();
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((part) => part?.type === "text" && typeof part?.text === "string")
        .map((part) => part.text)
        .join("\n")
    : "";

  if (!text) throw new Error("Unsupported Anthropic-compatible response format");
  return text;
}

async function askClaude(prompt) {
  const style = (process.env.CLAUDE_API_STYLE || "auto").toLowerCase();

  if (style === "openai") return callOpenAICompatible(prompt);
  if (style === "anthropic") return callAnthropicCompatible(prompt);

  try {
    return await callOpenAICompatible(prompt);
  } catch {
    return await callAnthropicCompatible(prompt);
  }
}

const basePath = "/api/mcp/" + (process.env.MCP_PATH_SECRET || "missing-secret");

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "ask_claude",
      "Send a text-only prompt to Claude and return Claude's plain-text answer.",
      { prompt: z.string().min(1).max(120000) },
      async ({ prompt }) => {
        try {
          const text = await askClaude(prompt);
          return { content: [{ type: "text", text }] };
        } catch (error) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: error instanceof Error ? error.message : "Unknown Claude bridge error"
            }]
          };
        }
      }
    );
  },
  {},
  { basePath }
);

async function authorized(ctx) {
  const { secret } = await ctx.params;
  const expected = process.env.MCP_PATH_SECRET;
  return Boolean(expected && secret === expected);
}

export async function GET(req, ctx) {
  if (!(await authorized(ctx))) return new Response("Not found", { status: 404 });
  return handler(req);
}

export async function POST(req, ctx) {
  if (!(await authorized(ctx))) return new Response("Not found", { status: 404 });
  return handler(req);
}

export async function DELETE(req, ctx) {
  if (!(await authorized(ctx))) return new Response("Not found", { status: 404 });
  return handler(req);
}
