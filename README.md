# claude-context-server

An MCP server that exposes everything Claude Code knows about your projects — memories, instructions, custom skills, tech stack, and git history — as queryable tools. Lets any Claude instance, in any project or via Claude.ai, access your full context across every project you've ever worked on.

## The problem it solves

Claude Code is powerful but siloed. Everything it learns — saved memories, project instructions, custom skills you've built — is locked to the project it was created in. Claude in a new project starts with no knowledge of what was decided, fixed, or built before. Claude.ai on web or phone can't see any of it.

This server bridges that gap. It reads across all your projects and exposes:

- **Memories** — decisions, lessons, and conventions Claude Code has saved over time
- **CLAUDE.md instructions** — your project-specific rules and context
- **Custom skills** — slash commands you've built, available to replicate in new projects
- **Tech stack** — detected automatically from manifest files
- **Git history** — recent commits so Claude knows what's been worked on

All of it queryable from any Claude instance, any project, any device.

## Installation

### Claude Code (CLI / VS Code)

```bash
claude mcp add --scope user claude-context-server -- npx -y claude-context-server
```

That's it. The server is now available in every project automatically. Verify with:

```bash
claude mcp list
```

### Claude Desktop app (Mac/Windows)

Add to your Claude Desktop config file:

- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "claude-context-server": {
      "command": "npx",
      "args": ["-y", "claude-context-server"]
    }
  }
}
```

Restart the Claude Desktop app.

## Tools

| Tool | Description |
|------|-------------|
| `list_projects` | All projects with memory files, decoded paths, and entry counts |
| `get_project(project_name)` | Full memory dump for a named project — plus CLAUDE.md, custom skills, tech stack, and recent git history |
| `get_user_profile` | All `type: user` memory entries aggregated into one profile |
| `get_all_feedback` | All `type: feedback` entries aggregated — lessons and conventions across every project |
| `search(query)` | Full-text search across all memory files with project context |
| `get_all_context` | Everything in one markdown document — use this for Claude.ai uploads |
| `save_memory(...)` | Write a new memory file to any project's memory directory from any Claude instance |

## Export for Claude.ai

Claude.ai can't run local MCP servers, but you can give it a snapshot:

```bash
npx claude-context-server export
```

This writes `~/claude-context-export.md`. Upload it to a [Claude.ai Project](https://claude.ai) as a knowledge file — every chat in that project will have your full context.

### Auto-export on change

If you're going to use Claude.ai regularly, run `watch` instead of `export`:

```bash
npx claude-context-server watch
```

This does the initial export immediately when it starts, then polls your memory directory every 5 seconds and automatically regenerates the file whenever anything changes. As long as `watch` is running, `~/claude-context-export.md` is always up to date — you never need to run `export` manually again.

Keep it running in a terminal tab while you work. When Claude Code saves a new memory during a session, the export file is refreshed within seconds.

**Why 5 seconds?** Claude Code can write memories multiple times during an active session. A slow poll interval means you could finish a whole work session and still be looking at a stale export next time you open Claude.ai. The 5 second interval feels aggressive but the cost is negligible — it's only checking file modification timestamps on your local SSD, not reading file contents. The actual work of regenerating the export only happens when something has genuinely changed.

The only reason to use the manual `export` command is if you want a one-off snapshot without keeping a process running.

---

## Use cases

### Carrying fixes forward to a new project

Three months ago you built a Laravel app that worked perfectly in local development but hit a string of compatibility issues when deploying to a cPanel shared host — wrong PHP extensions, queue workers that needed a workaround, `.htaccess` rules that conflicted with the framework. You fixed each one, and Claude Code saved the solutions as memory.

Now you're starting a fresh Laravel app, also targeting cPanel. Instead of discovering the same issues again mid-deployment, you ask:

> "What cPanel deployment issues did we run into on the last Laravel project?"

Claude queries this server, pulls the fixes from that project's memory, and applies them from the start — the right PHP config, the queue workaround, the `.htaccess` rules — before you've written a single route.

---

### Applying rules from one project to another

You're a web designer and taught Claude several rules on a marketing website: no em dashes in copy, blog images must be landscape at 1200px, blog posts finish with a CTA linking to the contact form. Those lessons live in that project's memory.

When you start building a similar website, Claude in that new project has no idea those rules exist. With this server, it can query:

> "What feedback and preferences do you have for blog post structure?"

And apply every hard-won rule from day one, without you having to re-teach them.

---

### Context on your phone

You're away from your desk and want to think through an architecture decision for your CRM. You open Claude on your phone — which has no access to your local files. But you ran `npx claude-context-server export` this morning and uploaded the result to a Claude.ai Project.

Claude on your phone already knows the CRM's tech stack (Laravel 11, Blade + Tailwind + Alpine, cPanel deployment), the lead capture SDK architecture, the deployment cron setup, and every other decision made in previous sessions. You can have a real, grounded architecture conversation without being at your computer.

---

### Shared conventions across a client's projects

You're a design agency. You've just finished the Big Boss Gyms website and documented the brand in a `DESIGN.md` file — brand red `#D32027`, the Outfit/Manrope font stack, button styles, spacing scale, and logo usage rules. You ask Claude Code to save it as a reference memory so it travels with the project.

Six months later, the client wants an invoicing tool. You open a new project folder and type:

> "Build an invoicing tool for Big Boss Gyms"

Claude queries this server, finds the design memory from the website project, and builds the invoicing tool in the right red, with the right fonts, following the same copy rules — without you pasting a style guide or briefing it on the brand. The invoicing tool looks like it belongs to the same family as the website from the first line of code.

---

### Reusing custom skills across projects

You build small business websites and created a `/add-service` skill in your first project — it knows your service page structure, the sections you always include, the tone, the CTA placement. It took a few iterations to get right.

When you start the next small business website, ask Claude:

> "What custom skills does my Big Boss Gyms Website project have?"

Claude queries this server, returns the full `/add-service` skill definition, and can recreate it in the new project with one follow-up:

> "Add that skill to this project."

Every website you build from that point inherits the skill automatically — no copying files, no re-explaining the structure.

---

### Updating other projects without switching context

You're deep in Project A when you solve something that applies to Projects B and C as well — a tricky API integration, a deployment fix, a pattern worth reusing. Normally you'd have to finish what you're doing, open each other project, and save the memory there. With this server, you don't leave where you are:

> "Save this authentication approach as a reference memory in the CRM project and the invoicing project."

Claude writes the memory directly to both projects. Next time you open either one, it's already there.

---

### Teaching Claude reusable patterns

Memory isn't just for feedback — you can deliberately save patterns and conventions so they're available everywhere. Tell Claude Code to remember a structural rule:

> "Remember: for all my Laravel APIs, every endpoint returns the same response envelope — `{ data: ..., meta: { success: bool, message: string } }`. Controllers extend `BaseApiController` which has `successResponse()` and `errorResponse()` helpers. Never return raw model data directly."

Claude writes this as a `reference` memory entry. Every new Laravel project you start, this server surfaces that convention automatically. Claude structures every controller the same way without you specifying it — and when it sees code that breaks the pattern, it flags it.

**What works well in memory:** architectural conventions, response formats, naming rules, copy style guides, small representative snippets, deployment checklists, client preferences.

**What doesn't belong in memory:** full component implementations (keep those as actual shared files), things that change with every release, anything you'd want version-controlled.

---

## How it works

Claude Code auto-saves memory files to `~/.claude/projects/*/memory/` as you work. Each file has frontmatter with a `type` (`user`, `feedback`, `project`, `reference`) and a markdown body. This server reads them fresh on every tool call — no database, no sync, always up to date.

`get_project` goes further: it resolves the real project directory on disk and reads your `CLAUDE.md` instructions, detects the tech stack from manifest files (`package.json`, `composer.json`, `requirements.txt`, etc.), and fetches the last 10 git commits.

As long as Claude Code has opened a project — creating a `.claude` folder for it — this server will pull everything it can from it. Tech stack, git history, and CLAUDE.md are available from day one, before a single memory has been saved.

`save_memory` lets any Claude instance write a memory file back to any project — so Claude Desktop or Claude.ai (after an export upload) can create memories that Claude Code will see the next time you open that project.

## Your memory is only as good as what you save

Conversation history is intentionally not read. Chat transcripts are large, noisy, and often contain things discussed in passing that were never meant to be permanently surfaced. Memories exist to distill what actually matters out of those conversations.

The better habit is to ask Claude to save something as a memory during the session rather than trying to recover it from transcripts later. If a decision was made, a pattern agreed on, or a lesson learned — tell Claude to remember it before you close the chat.

## Memory file format

```yaml
---
name: short-slug
description: one-line summary
metadata:
  type: user | feedback | project | reference
---
Body content here.
```

## Contributing / building from source

```bash
git clone https://github.com/carlformigoni/claude-context-server.git
cd claude-context-server
npm install
npm run build
```

Run locally instead of via npx:

```bash
claude mcp add --scope user claude-context-server -- node /path/to/claude-context-server/dist/index.js
```
