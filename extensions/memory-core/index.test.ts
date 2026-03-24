import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { createMemoryExpandTool, createMemoryGetTool, createMemorySearchTool } from "../../src/agents/tools/memory-tool.js";
import memoryCorePlugin from "./index.js";

function makeConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

describe("memory-core plugin", () => {
  it("registers memory_search, memory_get, and memory_expand together", () => {
    const toolRegistrations: Array<{
      factory: (ctx: { config: OpenClawConfig; sessionKey: string }) => unknown;
      opts?: { names?: string[] };
    }> = [];

    memoryCorePlugin.register({
      runtime: {
        tools: {
          createMemorySearchTool,
          createMemoryGetTool,
          createMemoryExpandTool,
          registerMemoryCli() {},
        },
      },
      registerTool(factory, opts) {
        toolRegistrations.push({
          factory: factory as (ctx: { config: OpenClawConfig; sessionKey: string }) => unknown,
          opts: opts as { names?: string[] } | undefined,
        });
      },
      registerCli() {},
    } as never);

    expect(toolRegistrations).toHaveLength(1);
    expect(toolRegistrations[0]?.opts?.names).toEqual([
      "memory_search",
      "memory_get",
      "memory_expand",
    ]);

    const tools = toolRegistrations[0]?.factory({
      config: makeConfig(),
      sessionKey: "agent:main:main",
    }) as Array<{ name: string }> | null;

    expect(tools?.map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_get",
      "memory_expand",
    ]);
  });
});
