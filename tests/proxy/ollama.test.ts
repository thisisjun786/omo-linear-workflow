import { expect, test } from "bun:test";
import { z } from "zod";
import { discovery, extensionFixture, fixture } from "./fixtures";

function ollamaFixture(baseUrl = "https://ollama.com/v1") {
  const f = fixture([{ id: "deepseek-v4.1-flash", owned_by: "ollama-cloud" }]);
  f.routes["/v0/management/openai-compatibility"] = {
    "openai-compatibility": [
      {
        name: "ollama-cloud",
        "base-url": baseUrl,
        models: [
          {
            name: "deepseek-v4.1-flash",
            alias: "deepseek-v4.1-flash",
            "max-context-length": 1048576,
            "input-modalities": ["text", "image"],
            "output-modalities": ["text"],
            thinking: { levels: ["none", "low", "high", "max"] },
          },
        ],
      },
    ],
  };
  return f;
}

test("registered Ollama Cloud models get a bounded client output budget", async () => {
  // Given proxy-managed metadata with no server-advertised output limit.
  const f = ollamaFixture();
  // When discovery registers an exact Ollama Cloud endpoint.
  const models = await discovery(f.url).discover({ force: true });
  // Then context/modalities remain manual, while the client budget follows Senpi's Ollama default.
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({
    id: "deepseek-v4.1-flash",
    contextWindow: 1048576,
    maxTokens: 16384,
    input: ["text", "image"],
    thinkingLevelMap: { off: "none", low: "low", high: "high", max: "max" },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
  });
});

test("Ollama defaults never supply missing metadata for another endpoint", async () => {
  // Given the same provider label and model at a different service.
  const f = ollamaFixture("https://other.example/v1");
  // When discovery has neither exact native metadata nor an Ollama endpoint.
  const result = discovery(f.url).discover({ force: true });
  // Then no unrelated service inherits an invented output limit.
  await expect(result).rejects.toThrow("lacks chat context");
});

test.each(["off", "high"] as const)(
  "Ollama %s thinking is serialized through the real transport",
  async (reasoning) => {
    // Given an actual extension registry and HTTP request recorder.
    const f = ollamaFixture();
    const h = await extensionFixture(f.url);
    const model = h.registry.find("cliproxyapi", "deepseek-v4.1-flash");
    if (!model) throw new Error("Ollama model was not registered");
    // When a Senpi request reaches the OpenAI-compatible transport.
    await h.registry
      .streamSimple(
        model,
        {
          systemPrompt: "Follow the instruction.",
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
        },
        { ...(reasoning === "off" ? {} : { reasoning }), maxRetries: 0 },
      )
      .result();
    // Then explicit off is not lost and the request retains the proxy alias.
    const request = z
      .object({
        model: z.string(),
        reasoning_effort: z.string(),
        max_tokens: z.number(),
        messages: z.array(z.object({ role: z.string() })),
      })
      .parse(f.requests[0]?.body);
    expect(request.model).toBe("deepseek-v4.1-flash");
    expect(request.reasoning_effort).toBe(reasoning === "off" ? "none" : "high");
    expect(request.max_tokens).toBeLessThanOrEqual(16384);
    expect(request.messages.map((message) => message.role)).toEqual(["system", "user"]);
  },
);
