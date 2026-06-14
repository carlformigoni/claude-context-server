import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export interface MemoryFile {
  fileName: string;
  filePath: string;
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference" | "unknown";
  body: string;
}

export interface Project {
  folderName: string;
  folderPath: string;
  projectPath: string;
  projectName: string;
  memoryFiles: MemoryFile[];
  memoryIndex: string;
}

export interface ProjectDetails {
  resolvedPath: string | null;
  claudeMd: string | null;
  dotClaudeMd: string | null;
  techStack: string[];
  recentCommits: string | null;
}

export interface SearchResult {
  project: string;
  projectName: string;
  file: string;
  type: string;
  name: string;
  excerpt: string;
}

// Claude Code encodes project paths as folder names by replacing path separators
// and spaces with `-`. The encoding differs by OS:
//   Mac/Linux:  /Users/carl/Projects/My App  →  -Users-carl-Projects-My-App
//   Windows:    C:\Users\carl\Projects\My App →  C--Users-carl-Projects-My-App
// Decoding is always best-effort because / and space are indistinguishable.
function decodeProjectPath(folderName: string): string {
  // Windows-encoded: drive letter followed by --
  if (/^[A-Za-z]--/.test(folderName)) {
    return folderName
      .replace(/^([A-Za-z])--/, "$1:\\")
      .replace(/-/g, "\\");
  }
  // Unix-encoded: leading -
  if (folderName.startsWith("-")) {
    return "/" + folderName.slice(1).replace(/-/g, "/");
  }
  return folderName;
}

// Encode the user's home directory to match Claude Code's folder name format.
// This lets us strip the home prefix to get a clean project display name.
function encodeHomeDirPrefix(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    // C:\Users\carl  →  C--Users-carl-
    return home.replace(/\\/g, "-").replace(/:/g, "-") + "-";
  }
  // /Users/carl  →  -Users-carl-
  return home.replace(/\//g, "-") + "-";
}

// Extract a short human-readable project name from the encoded folder name.
// Strips the home directory and common intermediate directories.
function getProjectName(folderName: string): string {
  const homePrefix = encodeHomeDirPrefix();

  // Common intermediate directories to strip after the home prefix.
  // Ordered so longer/more-specific prefixes are tried first.
  const subPrefixes = [
    // macOS cloud storage
    "Library-CloudStorage-Dropbox-",
    "Library-CloudStorage-OneDrive-",
    "Library-CloudStorage-Box-",
    "Library-CloudStorage-",
    "Library-Mobile-Documents-com~apple~CloudDocs-",  // iCloud Drive
    "Library-",
    // Windows cloud storage and common dirs
    "OneDrive-Documents-",
    "OneDrive-Desktop-",
    "OneDrive-",
    "Documents-",
    "Desktop-",
    // Common project directories (all platforms)
    "Projects-",
    "projects-",
    "Repos-",
    "repos-",
    "Code-",
    "code-",
    "Dev-",
    "dev-",
    "src-",
    "Workspace-",
    "workspace-",
    "Development-",
  ];

  let name = folderName;

  if (name.startsWith(homePrefix)) {
    name = name.slice(homePrefix.length);
    for (const sub of subPrefixes) {
      if (name.startsWith(sub)) {
        name = name.slice(sub.length);
        break;
      }
    }
  }

  // ` - ` (space-hyphen-space) encodes as `---`; restore it before decoding other dashes
  name = name.replace(/---/g, " - ");
  // Remaining dashes are either path separators or spaces — decode to spaces
  name = name.replace(/-/g, " ");

  return name.trim();
}

// Walk the filesystem to resolve an encoded folder name back to the real project path.
// Claude Code encodes both path separators and spaces as `-`, making naive decode
// ambiguous. This function tries combinations greedily (longest match first) to find
// the real directory that exists on disk.
function resolveProjectPath(folderName: string): string | null {
  // Try naive decode first — works when no path component contains a space
  const naivePath = decodeProjectPath(folderName);
  try {
    if (fs.existsSync(naivePath)) return naivePath;
  } catch { /* ignore */ }

  const homePrefix = encodeHomeDirPrefix();
  if (!folderName.startsWith(homePrefix)) return null;

  // ` - ` was encoded as `---`; use a sentinel before splitting on single dashes
  const DASH_SENTINEL = "\x01";
  const processed = folderName.slice(homePrefix.length).replace(/---/g, DASH_SENTINEL);

  // Split on single dashes; each token is a word fragment or the ` - ` sentinel
  const rawTokens = processed.split("-");

  // Restore sentinel to ` - ` and drop empty tokens from consecutive dashes
  const tokens = rawTokens
    .map((t) => t.replace(new RegExp(DASH_SENTINEL, "g"), " - "))
    .filter(Boolean);

  // Greedy left-to-right resolution: try joining 1–5 consecutive tokens as one directory name
  let current = os.homedir();
  let i = 0;

  while (i < tokens.length) {
    let matched = false;
    for (let len = Math.min(5, tokens.length - i); len >= 1; len--) {
      const name = tokens.slice(i, i + len).join(" ");
      try {
        const candidate = path.join(current, name);
        if (fs.existsSync(candidate)) {
          current = candidate;
          i += len;
          matched = true;
          break;
        }
      } catch { /* skip inaccessible paths */ }
    }
    if (!matched) return null;
  }

  try {
    return fs.existsSync(current) ? current : null;
  } catch {
    return null;
  }
}

// Scan a project directory for known manifest files and return detected languages/frameworks.
function detectTechStack(projectPath: string): string[] {
  const detected: string[] = [];

  // Node.js / JavaScript / TypeScript
  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    detected.push("Node.js");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.typescript || deps["ts-node"] || deps.tsx) detected.push("TypeScript");
      // Frameworks — check more specific ones first
      if (deps["@remix-run/react"] || deps["@remix-run/node"]) detected.push("Remix");
      else if (deps.next) detected.push("Next.js");
      else if (deps.nuxt) detected.push("Nuxt");
      else if (deps.astro) detected.push("Astro");
      else if (deps.react) detected.push("React");
      else if (deps.svelte || deps["@sveltejs/kit"]) detected.push("Svelte");
      else if (deps.vue) detected.push("Vue");
      // Server frameworks
      if (deps["@nestjs/core"]) detected.push("NestJS");
      else if (deps.fastify) detected.push("Fastify");
      else if (deps.express) detected.push("Express");
      // Other notable deps
      if (deps.electron) detected.push("Electron");
      if (deps.tailwindcss) detected.push("Tailwind CSS");
    } catch { /* file exists but not parseable; Node.js is still detected */ }
  }

  // PHP
  const composerPath = path.join(projectPath, "composer.json");
  if (fs.existsSync(composerPath)) {
    detected.push("PHP");
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, "utf-8")) as {
        require?: Record<string, string>;
        "require-dev"?: Record<string, string>;
      };
      const req = { ...composer.require, ...composer["require-dev"] };
      if (req["laravel/framework"]) detected.push("Laravel");
      else if (req["symfony/framework-bundle"] || req["symfony/symfony"]) detected.push("Symfony");
      else if (req["slim/slim"]) detected.push("Slim");
      else if (req["cakephp/cakephp"]) detected.push("CakePHP");
      else if (req["codeigniter4/framework"]) detected.push("CodeIgniter");
    } catch { /* skip framework detection */ }
  }

  // Python
  const reqPath = path.join(projectPath, "requirements.txt");
  const pyprojectPath = path.join(projectPath, "pyproject.toml");
  if (fs.existsSync(reqPath) || fs.existsSync(pyprojectPath)) {
    detected.push("Python");
    try {
      const content = [
        fs.existsSync(reqPath) ? fs.readFileSync(reqPath, "utf-8") : "",
        fs.existsSync(pyprojectPath) ? fs.readFileSync(pyprojectPath, "utf-8") : "",
      ].join("\n").toLowerCase();
      if (content.includes("django")) detected.push("Django");
      else if (content.includes("fastapi")) detected.push("FastAPI");
      else if (content.includes("flask")) detected.push("Flask");
    } catch { /* skip */ }
  }

  // Ruby
  const gemfilePath = path.join(projectPath, "Gemfile");
  if (fs.existsSync(gemfilePath)) {
    detected.push("Ruby");
    try {
      const content = fs.readFileSync(gemfilePath, "utf-8").toLowerCase();
      if (content.includes("rails")) detected.push("Rails");
      else if (content.includes("sinatra")) detected.push("Sinatra");
    } catch { /* skip */ }
  }

  // Rust
  const cargoPath = path.join(projectPath, "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    detected.push("Rust");
    try {
      const content = fs.readFileSync(cargoPath, "utf-8").toLowerCase();
      if (content.includes("actix-web")) detected.push("Actix");
      else if (content.includes("axum")) detected.push("Axum");
      else if (content.includes("rocket")) detected.push("Rocket");
    } catch { /* skip */ }
  }

  // Go
  const goModPath = path.join(projectPath, "go.mod");
  if (fs.existsSync(goModPath)) {
    detected.push("Go");
    try {
      const content = fs.readFileSync(goModPath, "utf-8").toLowerCase();
      if (content.includes("gin-gonic/gin")) detected.push("Gin");
      else if (content.includes("go-chi/chi")) detected.push("Chi");
    } catch { /* skip */ }
  }

  // Java (Maven)
  const pomPath = path.join(projectPath, "pom.xml");
  if (fs.existsSync(pomPath)) {
    detected.push("Java");
    try {
      const content = fs.readFileSync(pomPath, "utf-8").toLowerCase();
      if (content.includes("spring-boot")) detected.push("Spring Boot");
    } catch { /* skip */ }
  }

  // Java (Gradle)
  const gradlePath = path.join(projectPath, "build.gradle");
  const gradleKtsPath = path.join(projectPath, "build.gradle.kts");
  if (fs.existsSync(gradlePath) || fs.existsSync(gradleKtsPath)) {
    if (!detected.includes("Java")) detected.push("Java");
    try {
      const f = fs.existsSync(gradlePath) ? gradlePath : gradleKtsPath;
      const content = fs.readFileSync(f, "utf-8").toLowerCase();
      if (content.includes("spring-boot") && !detected.includes("Spring Boot")) {
        detected.push("Spring Boot");
      }
    } catch { /* skip */ }
  }

  return detected;
}

// Minimal YAML frontmatter parser — handles both formats Claude Code uses:
//   type: value            (flat, older format)
//   metadata:\n  type: value  (nested, newer format)
function parseFrontmatter(content: string): {
  data: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };

  // Use \r?\n to handle both Unix (LF) and Windows (CRLF) line endings
  const yamlLines = match[1].split(/\r?\n/);
  const body = match[2];
  const data: Record<string, string> = {};
  let inMetadata = false;

  for (const line of yamlLines) {
    if (line.trim() === "metadata:" || line.trim() === "metadata: ") {
      inMetadata = true;
      continue;
    }

    if (inMetadata) {
      if (line.startsWith("  ") || line.startsWith("\t")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > -1) {
          const key = line.slice(0, colonIdx).trim();
          const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
          data[`metadata.${key}`] = val;
        }
        continue;
      } else {
        inMetadata = false;
      }
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx > -1) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
      data[key] = val;
    }
  }

  return { data, body };
}

function readMemoryFile(filePath: string): MemoryFile {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, body } = parseFrontmatter(raw);

  const type =
    (data["metadata.type"] as MemoryFile["type"]) ||
    (data["type"] as MemoryFile["type"]) ||
    "unknown";

  return {
    fileName: path.basename(filePath),
    filePath,
    name: data["name"] || path.basename(filePath, ".md"),
    description: data["description"] || "",
    type,
    body: body.trim(),
  };
}

export function getProjects(): Project[] {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const entries = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  const projects: Project[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const memoryDir = path.join(CLAUDE_PROJECTS_DIR, entry.name, "memory");

    const allFiles = fs.existsSync(memoryDir)
      ? fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md"))
      : [];

    let memoryIndex = "";
    const memoryFiles: MemoryFile[] = [];

    for (const file of allFiles) {
      const filePath = path.join(memoryDir, file);
      if (file === "MEMORY.md") {
        memoryIndex = fs.readFileSync(filePath, "utf-8");
        continue;
      }
      try {
        memoryFiles.push(readMemoryFile(filePath));
      } catch {
        // skip malformed files
      }
    }

    projects.push({
      folderName: entry.name,
      folderPath: path.join(CLAUDE_PROJECTS_DIR, entry.name),
      projectPath: decodeProjectPath(entry.name),
      projectName: getProjectName(entry.name),
      memoryFiles,
      memoryIndex,
    });
  }

  return projects.sort((a, b) => a.projectName.localeCompare(b.projectName));
}

export function findProject(query: string): Project | undefined {
  const projects = getProjects();
  const q = query.toLowerCase().trim();

  return (
    projects.find((p) => p.projectName.toLowerCase() === q) ||
    projects.find((p) => p.projectName.toLowerCase().includes(q)) ||
    projects.find((p) =>
      p.folderName.toLowerCase().includes(q.replace(/\s+/g, "-"))
    )
  );
}

export function formatProjectMemory(project: Project): string {
  const lines: string[] = [
    `# Project: ${project.projectName}`,
    `**Path:** ${project.projectPath}`,
    "",
  ];

  if (project.memoryIndex) {
    lines.push("## Memory Index", "", project.memoryIndex, "");
  }

  for (const mem of project.memoryFiles) {
    lines.push(
      `## [${mem.type.toUpperCase()}] ${mem.name}`,
      mem.description ? `_${mem.description}_` : "",
      "",
      mem.body,
      ""
    );
  }

  return lines.join("\n").trim();
}

export function searchAllMemory(query: string): SearchResult[] {
  const projects = getProjects();
  const results: SearchResult[] = [];
  const q = query.toLowerCase();

  for (const project of projects) {
    if (project.memoryIndex.toLowerCase().includes(q)) {
      const lines = project.memoryIndex.split(/\r?\n/);
      const matching = lines
        .filter((l) => l.toLowerCase().includes(q))
        .slice(0, 3)
        .join("\n");
      if (matching) {
        results.push({
          project: project.folderName,
          projectName: project.projectName,
          file: "MEMORY.md",
          type: "index",
          name: "Memory Index",
          excerpt: matching,
        });
      }
    }

    for (const mem of project.memoryFiles) {
      const searchable = `${mem.name} ${mem.description} ${mem.body}`.toLowerCase();
      if (searchable.includes(q)) {
        const lines = mem.body.split(/\r?\n/);
        const matchingLine =
          lines.find((l) => l.toLowerCase().includes(q)) || lines[0] || "";
        results.push({
          project: project.folderName,
          projectName: project.projectName,
          file: mem.fileName,
          type: mem.type,
          name: mem.name,
          excerpt: matchingLine.trim().slice(0, 200),
        });
      }
    }
  }

  return results;
}

export function getAllContext(): string {
  const projects = getProjects();
  const sections: string[] = [
    `# Claude Code – Full Context Export`,
    `_Generated: ${new Date().toISOString()}_`,
    `_Projects: ${projects.length}_`,
    "",
  ];

  const userMemories = projects.flatMap((p) =>
    p.memoryFiles
      .filter((m) => m.type === "user")
      .map((m) => ({ ...m, projectName: p.projectName }))
  );

  if (userMemories.length > 0) {
    sections.push("## User Profile", "");
    for (const mem of userMemories) {
      sections.push(
        `### ${mem.name} _(from: ${mem.projectName})_`,
        mem.description ? `_${mem.description}_` : "",
        "",
        mem.body,
        ""
      );
    }
  }

  sections.push("---", "", "## Projects", "");

  for (const project of projects) {
    sections.push(formatProjectMemory(project), "", "---", "");
  }

  return sections.join("\n");
}

// Fetch extra on-disk details for a project: CLAUDE.md content, tech stack, and git history.
// Only called from get_project — may take a moment if the project lives on cloud storage.
export function getProjectDetails(project: Project): ProjectDetails {
  const resolvedPath = resolveProjectPath(project.folderName);

  if (!resolvedPath) {
    return { resolvedPath: null, claudeMd: null, dotClaudeMd: null, techStack: [], recentCommits: null };
  }

  const MAX_BYTES = 50 * 1024; // 50 KB cap per file

  function readMd(p: string): string | null {
    if (!fs.existsSync(p)) return null;
    try {
      const raw = fs.readFileSync(p, "utf-8");
      if (Buffer.byteLength(raw, "utf-8") <= MAX_BYTES) return raw;
      return raw.slice(0, MAX_BYTES) + "\n\n_(truncated at 50 KB)_";
    } catch {
      return null;
    }
  }

  const claudeMd = readMd(path.join(resolvedPath, "CLAUDE.md"));
  const dotClaudeMd = readMd(path.join(resolvedPath, ".claude", "CLAUDE.md"));
  const techStack = detectTechStack(resolvedPath);

  let recentCommits: string | null = null;
  try {
    const out = execSync(`git -C "${resolvedPath}" log --oneline -10`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (out) recentCommits = out;
  } catch { /* not a git repo or git not installed */ }

  return { resolvedPath, claudeMd, dotClaudeMd, techStack, recentCommits };
}

// Write a new memory file to a project's memory directory and update its MEMORY.md index.
// Returns the path of the created file.
export function saveMemory(params: {
  projectName: string;
  name: string;
  type: "user" | "feedback" | "project" | "reference";
  description: string;
  body: string;
}): string {
  const { projectName, name, type, description, body } = params;

  const project = findProject(projectName);
  if (!project) throw new Error(`Project not found: "${projectName}"`);

  const memoryDir = path.join(project.folderPath, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });

  const slug = (name || "memory")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "memory";

  // Find a unique filename
  let filename = `${type}-${slug}.md`;
  if (fs.existsSync(path.join(memoryDir, filename))) {
    let n = 2;
    while (n <= 99 && fs.existsSync(path.join(memoryDir, `${type}-${slug}-${n}.md`))) n++;
    filename = `${type}-${slug}-${n}.md`;
  }

  const filePath = path.join(memoryDir, filename);

  const content = [
    "---",
    `name: ${slug}`,
    `description: ${description}`,
    "metadata: ",
    `  type: ${type}`,
    "---",
    "",
    body.trimEnd(),
    "",
  ].join("\n");

  fs.writeFileSync(filePath, content, "utf-8");

  // Update MEMORY.md index
  const indexPath = path.join(memoryDir, "MEMORY.md");
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  const entry = `- [${label}: ${slug}](${filename}) — ${description}`;

  if (fs.existsSync(indexPath)) {
    const existing = fs.readFileSync(indexPath, "utf-8");
    fs.writeFileSync(indexPath, existing.trimEnd() + "\n" + entry + "\n", "utf-8");
  } else {
    fs.writeFileSync(indexPath, `# Memory Index\n\n${entry}\n`, "utf-8");
  }

  return filePath;
}

// Aggregate all `feedback` type memory entries across all projects into one document.
export function getAllFeedback(): string {
  const projects = getProjects();
  const entries = projects.flatMap((p) =>
    p.memoryFiles
      .filter((m) => m.type === "feedback")
      .map((m) => ({ ...m, projectName: p.projectName }))
  );

  if (entries.length === 0) {
    return "No 'feedback' type memory entries found across any project.";
  }

  const projectCount = new Set(entries.map((e) => e.projectName)).size;
  const lines = [
    `# Feedback & Lessons`,
    `_Aggregated from ${entries.length} entr${entries.length === 1 ? "y" : "ies"} across ${projectCount} project${projectCount === 1 ? "" : "s"}_`,
    "",
  ];

  for (const entry of entries) {
    lines.push(
      `## ${entry.name}`,
      `_Source: ${entry.projectName}_`,
      entry.description ? `> ${entry.description}` : "",
      "",
      entry.body,
      ""
    );
  }

  return lines.filter((l) => l !== undefined).join("\n");
}
