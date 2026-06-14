#!/usr/bin/env node

// Handle `export` subcommand before starting the MCP server
if (process.argv[2] === "export") {
  const { default: fs } = await import("fs");
  const { default: path } = await import("path");
  const { default: os } = await import("os");
  const { getAllContext, getProjects } = await import("./memory-reader.js");

  const outputPath = path.join(os.homedir(), "claude-context-export.md");
  const projects = getProjects();
  console.log(`Reading memory from ${projects.length} project${projects.length === 1 ? "" : "s"}...`);
  const content = getAllContext();
  fs.writeFileSync(outputPath, content, "utf-8");
  const sizeKb = Math.round(Buffer.byteLength(content, "utf-8") / 1024);
  console.log(`✓ Exported to ${outputPath} (${sizeKb} KB)`);
  console.log(`  Upload this file to a Claude.ai Project for full context.`);
  process.exit(0);
}

// Handle `watch` subcommand — polls memory files and re-exports on change
if (process.argv[2] === "watch") {
  const { default: fs } = await import("fs");
  const { default: path } = await import("path");
  const { default: os } = await import("os");
  const { getAllContext, getProjects } = await import("./memory-reader.js");

  const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
  const OUTPUT_PATH = path.join(os.homedir(), "claude-context-export.md");
  const POLL_MS = 5000;
  const DEBOUNCE_MS = 2000;

  function snapshot(): Map<string, number> {
    const map = new Map<string, number>();
    if (!fs.existsSync(PROJECTS_DIR)) return map;
    for (const proj of fs.readdirSync(PROJECTS_DIR)) {
      const memDir = path.join(PROJECTS_DIR, proj, "memory");
      if (!fs.existsSync(memDir)) continue;
      for (const file of fs.readdirSync(memDir)) {
        if (!file.endsWith(".md")) continue;
        const fp = path.join(memDir, file);
        try { map.set(fp, fs.statSync(fp).mtimeMs); } catch { /* skip */ }
      }
    }
    return map;
  }

  function doExport() {
    const projects = getProjects();
    const content = getAllContext();
    fs.writeFileSync(OUTPUT_PATH, content, "utf-8");
    const kb = Math.round(Buffer.byteLength(content, "utf-8") / 1024);
    console.log(`[${new Date().toISOString()}] Exported ${projects.length} project${projects.length === 1 ? "" : "s"} (${kb} KB) → ${OUTPUT_PATH}`);
  }

  let last = snapshot();
  let debounce: ReturnType<typeof setTimeout> | null = null;

  console.log(`Watching for memory changes (polling every ${POLL_MS / 1000}s)…`);
  doExport();

  setInterval(() => {
    const current = snapshot();
    let changed = false;
    for (const [fp, mtime] of current) {
      if (last.get(fp) !== mtime) { changed = true; break; }
    }
    if (!changed) {
      for (const fp of last.keys()) {
        if (!current.has(fp)) { changed = true; break; }
      }
    }
    last = current;
    if (changed) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(doExport, DEBOUNCE_MS);
    }
  }, POLL_MS);
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getProjects,
  findProject,
  formatProjectMemory,
  searchAllMemory,
  getAllContext,
  getProjectDetails,
  saveMemory,
  getAllFeedback,
} from "./memory-reader.js";

const server = new Server(
  { name: "claude-context-server", version: "1.1.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_projects",
      description:
        "List all Claude Code projects that have saved memory files, with their decoded paths and summary.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_project",
      description:
        "Get the full memory content for a specific project, including CLAUDE.md instructions, detected tech stack, and recent git history. Supports fuzzy name matching.",
      inputSchema: {
        type: "object",
        properties: {
          project_name: {
            type: "string",
            description: "Project name or partial name to look up (fuzzy matched)",
          },
        },
        required: ["project_name"],
      },
    },
    {
      name: "get_user_profile",
      description:
        "Aggregate all 'user' type memory entries across every project into a single profile.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_all_feedback",
      description:
        "Aggregate all 'feedback' type memory entries across every project — coding conventions, corrections, and lessons learned.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "search",
      description:
        "Full-text search across all memory files. Returns matching excerpts with project context.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query to find across all project memories",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_all_context",
      description:
        "Dump everything — all projects and all memory entries — into one structured markdown document. Use this for a full context upload to Claude.ai.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "save_memory",
      description:
        "Write a new memory file to a project's memory directory and update its MEMORY.md index. Use this to save important information, lessons, or conventions for a project.",
      inputSchema: {
        type: "object",
        properties: {
          project_name: {
            type: "string",
            description: "Project name or partial name to look up (fuzzy matched)",
          },
          name: {
            type: "string",
            description: "Short slug for this memory, used as the filename base (e.g. 'api-conventions' or 'deploy-checklist')",
          },
          type: {
            type: "string",
            enum: ["user", "feedback", "project", "reference"],
            description: "Memory type: user (about the developer), feedback (corrections and lessons), project (project-specific decisions), reference (reusable patterns and conventions)",
          },
          description: {
            type: "string",
            description: "One-line summary shown in the memory index",
          },
          body: {
            type: "string",
            description: "The full content of the memory entry (markdown supported)",
          },
        },
        required: ["project_name", "name", "type", "description", "body"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_projects": {
        const projects = getProjects();
        if (projects.length === 0) {
          return { content: [{ type: "text", text: "No projects with memory files found." }] };
        }

        const lines = [
          `Found **${projects.length}** projects with memory:\n`,
          ...projects.map((p) => {
            const fileCount = p.memoryFiles.length;
            const typeCounts = p.memoryFiles.reduce<Record<string, number>>((acc, m) => {
              acc[m.type] = (acc[m.type] || 0) + 1;
              return acc;
            }, {});
            const typeSummary = Object.entries(typeCounts)
              .map(([t, n]) => `${n} ${t}`)
              .join(", ");
            const indexLine = p.memoryIndex
              ? p.memoryIndex.split(/\r?\n/).find((l) => l.startsWith("-"))?.slice(0, 80) || ""
              : "";
            return [
              `### ${p.projectName}`,
              `- **Path:** \`${p.projectPath}\``,
              `- **Memory files:** ${fileCount}${typeSummary ? ` (${typeSummary})` : ""}`,
              indexLine ? `- **First entry:** ${indexLine}` : "",
            ]
              .filter(Boolean)
              .join("\n");
          }),
        ];

        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }

      case "get_project": {
        const projectName = (args as Record<string, string>).project_name;
        if (!projectName) {
          return { content: [{ type: "text", text: "Error: project_name is required." }] };
        }

        const project = findProject(projectName);
        if (!project) {
          const projects = getProjects();
          const names = projects.map((p) => `- ${p.projectName}`).join("\n");
          return {
            content: [
              {
                type: "text",
                text: `No project found matching "${projectName}".\n\nAvailable projects:\n${names}`,
              },
            ],
          };
        }

        const sections: string[] = [formatProjectMemory(project)];
        const details = getProjectDetails(project);

        if (details.resolvedPath) {
          sections.push(`\n**Resolved path on disk:** \`${details.resolvedPath}\``);
        }

        if (details.techStack.length > 0) {
          sections.push(`\n**Tech stack:** ${details.techStack.join(", ")}`);
        }

        if (details.recentCommits) {
          sections.push(`\n## Recent Git History\n\`\`\`\n${details.recentCommits}\n\`\`\``);
        }

        if (details.claudeMd) {
          sections.push(`\n## CLAUDE.md\n${details.claudeMd}`);
        }

        if (details.dotClaudeMd) {
          sections.push(`\n## .claude/CLAUDE.md\n${details.dotClaudeMd}`);
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      }

      case "get_user_profile": {
        const projects = getProjects();
        const userEntries = projects.flatMap((p) =>
          p.memoryFiles
            .filter((m) => m.type === "user")
            .map((m) => ({ ...m, projectName: p.projectName }))
        );

        if (userEntries.length === 0) {
          return {
            content: [
              { type: "text", text: "No 'user' type memory entries found across any project." },
            ],
          };
        }

        const lines = [
          `# User Profile`,
          `_Aggregated from ${userEntries.length} entries across ${new Set(userEntries.map((e) => e.projectName)).size} projects_`,
          "",
        ];

        for (const entry of userEntries) {
          lines.push(
            `## ${entry.name}`,
            `_Source: ${entry.projectName}_`,
            entry.description ? `> ${entry.description}` : "",
            "",
            entry.body,
            ""
          );
        }

        return { content: [{ type: "text", text: lines.filter((l) => l !== undefined).join("\n") }] };
      }

      case "get_all_feedback": {
        return { content: [{ type: "text", text: getAllFeedback() }] };
      }

      case "search": {
        const query = (args as Record<string, string>).query;
        if (!query) {
          return { content: [{ type: "text", text: "Error: query is required." }] };
        }

        const results = searchAllMemory(query);
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results found for "${query}".` }],
          };
        }

        const lines = [
          `# Search results for "${query}"`,
          `_${results.length} match${results.length === 1 ? "" : "es"} across ${new Set(results.map((r) => r.projectName)).size} project${results.length === 1 ? "" : "s"}_`,
          "",
        ];

        for (const result of results) {
          lines.push(
            `### [${result.type.toUpperCase()}] ${result.name}`,
            `**Project:** ${result.projectName} | **File:** ${result.file}`,
            `> ${result.excerpt}`,
            ""
          );
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "get_all_context": {
        const context = getAllContext();
        return { content: [{ type: "text", text: context }] };
      }

      case "save_memory": {
        const a = args as Record<string, string>;
        for (const key of ["project_name", "name", "type", "description", "body"]) {
          if (!a[key]) return { content: [{ type: "text", text: `Error: ${key} is required.` }] };
        }
        const validTypes = ["user", "feedback", "project", "reference"];
        if (!validTypes.includes(a.type)) {
          return { content: [{ type: "text", text: `Error: type must be one of: ${validTypes.join(", ")}` }] };
        }
        const savedPath = saveMemory({
          projectName: a.project_name,
          name: a.name,
          type: a.type as "user" | "feedback" | "project" | "reference",
          description: a.description,
          body: a.body,
        });
        return { content: [{ type: "text", text: `Memory saved to ${savedPath}` }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }] };
  }
});

if (process.argv[2] !== "watch") {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
