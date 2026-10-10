import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { piAgentDir } from "./pi-models.ts";
import { join, relative, sep } from "node:path";

import type { SlashCommand } from "../shared/protocol.ts";

const BUILTINS: Record<string, readonly string[]> = {
  claude: ["clear", "compact", "config", "cost", "effort", "goal", "help", "init", "memory", "model", "permissions", "review", "status", "doctor", "login", "logout", "pr-comments", "release-notes", "terminal-setup", "vim"],
  omp: ["help", "clear", "compact", "model", "new", "sessions", "exit"],
  codex: ["clear", "compact", "diff", "help", "model", "new", "quit", "review", "status"],
  // pi 0.87.1, as its own palette lists them, less /tree — the way omp's list curates its own
  // commands. The chat reads pi's tree browser as nothing at all: no card, and the pane still looks
  // idle while the terminal waits for arrow keys. Offering the one command that opens it from the
  // chat would walk a reader into a state only the terminal lens can leave. Navigating stays in the
  // terminal; the chat's place is the abandoned-turns marker, which says where a /tree left off
  // Hermes Agent, from its own command registry (hermes_cli/commands.py), less what its TUI only
  // opens as a full-screen picker (/sessions, /agents, /skills, /plugins, /palette), what acts on
  // the PC's own clipboard, editor or microphone (/copy, /paste, /prompt, /voice), and what is no
  // job for a phone (/update, /skin and the other display toggles)
  hermes: ["new", "clear", "retry", "undo", "title", "compress", "rollback", "stop", "bg", "btw", "queue", "steer", "goal", "subgoal", "refine", "review", "plan", "status", "context", "diff", "model", "reasoning", "fast", "yolo", "approvals", "busy", "personality", "usage", "insights", "tools", "toolsets", "memory", "cron", "kanban", "reload", "reload-mcp", "reload-skills", "help", "version", "quit", "history", "worktree", "loop", "moa", "learn", "init", "focus", "verbose"],
  pi: ["settings", "model", "thinking", "scoped-models", "login", "logout", "llama", "new", "resume", "name", "session", "fork", "clone", "compact", "import", "copy", "export", "share", "bug", "trust", "reload", "hotkeys", "changelog", "quit"],
};

/** pi states what each command opens or does, in its own words, read off its palette. */
const PI_DESCRIPTIONS: Record<string, string> = {
  settings: "Open settings menu", model: "<provider/model> — Select model", thinking: "<level> — Set thinking level",
  "scoped-models": "Enable/disable models for Ctrl+P cycling", login: "<provider> — Configure provider authentication",
  logout: "Remove provider authentication", llama: "[t] Manage llama.cpp router models", new: "Start a new session",
  resume: "Resume a different session", name: "Set session display name", session: "Show session info and stats",
  fork: "Create a new fork from a previous user message",
  clone: "Duplicate the current session at the current position", compact: "Manually compact the session context",
  import: "Import and resume a session from a JSONL file", copy: "Copy last agent message to clipboard",
  export: "Export session (HTML default, or specify path: .html/.jsonl)", share: "Share session as a secret GitHub gist",
  bug: "<description> — Report a bug to the Pi developers", trust: "Save project trust decision for future sessions",
  reload: "Reload keybindings, extensions, skills, prompts, themes, and context files", hotkeys: "Show all keyboard shortcuts",
  changelog: "Show changelog entries", quit: "Quit pi",
};

/** Hermes's own descriptions, with its argument hint in front, as pi's are. */
const HERMES_DESCRIPTIONS: Record<string, string> = {
  new: "[name] — Start a new session (fresh session ID + history)", clear: "Clear screen and start a new session",
  retry: "Retry the last message (resend to agent)", undo: "[N] — Back up N user turns and re-prompt (default 1)",
  title: "[name] — Set a title for the current session",
  compress: "[here [N] | focus topic | --preview] — Compress conversation context",
  rollback: "[number] [--all] — List or restore filesystem checkpoints", stop: "Kill all running background processes",
  bg: "<prompt> — Run a prompt in a separate background session",
  btw: "<question> — Ask a side question about the current conversation without interrupting it",
  queue: "[<prompt>|list|edit N <prompt>|rm N|move A B|clear] — Queue a prompt for the next turn",
  steer: "<prompt> — Inject a message after the next tool call without interrupting",
  goal: "[text | show | pause | resume | clear | status] — Set a standing goal Hermes works on across turns until achieved",
  subgoal: "[text | remove N | clear] — Add or manage extra criteria on the active goal",
  refine: "[focus instructions] — Review this conversation now and save lessons to memory/skills",
  review: "[review instructions] — Spawn an independent subagent to review the work just discussed",
  plan: "[task] — Write a markdown implementation plan to .hermes/plans/ without executing anything",
  status: "Show session, model, token, and context info", context: "[all] — Show detailed context window usage",
  diff: "[staged|all|session] [--stat] [path...] — Show git changes in the working directory",
  // bare, Hermes opens its model picker, which only the terminal can drive
  model: "<model> [--provider name] [--reasoning level] [--global] — Switch model (name one: bare /model opens a picker)",
  reasoning: "[level|show|hide|full|clamp] [--global] — Manage reasoning effort and display",
  fast: "[normal|fast|auto|cold|status] [--global] — Fast mode", yolo: "Toggle YOLO mode (skip all dangerous command approvals)",
  approvals: "[manual|smart|off] — Show or set the persistent dangerous-command approval mode",
  busy: "[queue|steer|interrupt|status] — Control how messages behave while Hermes is working",
  personality: "[name] — Set a predefined personality", usage: "Show token usage and rate limits",
  insights: "[days] — Show usage insights and analytics", tools: "[list|disable|enable] [name...] — Manage tools",
  toolsets: "List available toolsets", memory: "[pending|approve|reject|approval] [id|on|off] — Review pending memory writes",
  cron: "[subcommand] — Manage scheduled tasks", kanban: "[subcommand] — Multi-profile collaboration board",
  reload: "Reload .env variables into the running session", "reload-mcp": "Reload MCP servers from config",
  "reload-skills": "Re-scan ~/.hermes/skills/ for newly installed or removed skills",
  help: "[skills|<filter>] — Show available commands", version: "Show Hermes Agent version",
  quit: "[--delete] — Exit the CLI (use --delete to also remove session history)", history: "Show conversation history",
  worktree: "[new [name]|list|prune] — Show, list, create, or prune isolated git worktrees",
  loop: "[interval] <prompt> [--times N] [--until <condition>] — Re-run a prompt on a recurring interval",
  moa: "<prompt> — Run one prompt through the default Mixture of Agents preset", learn: "<what to learn from> — Learn a reusable skill",
  init: "[notes] — Generate or update AGENTS.md project instructions from a repo scan",
  focus: "[on|off|status] — Show only your prompt and the final response", verbose: "Cycle tool progress display: off -> new -> all -> verbose",
};

const DESCRIPTIONS: Record<string, string> = {
  clear: "Clear the conversation", compact: "Compact conversation context", config: "Open configuration",
  cost: "Show token usage and cost", help: "Show available commands", init: "Initialize project instructions",
  memory: "Edit agent memory", model: "Choose a model", permissions: "Manage tool permissions", review: "Review changes",
  status: "Show session status", doctor: "Check the installation", login: "Sign in", logout: "Sign out",
  "pr-comments": "Fetch pull request comments", "release-notes": "Show release notes", "terminal-setup": "Configure terminal integration",
  vim: "Toggle Vim mode", new: "Start a new session", sessions: "List sessions", exit: "Exit the agent",
  diff: "Show the current diff", quit: "Exit the agent",
  goal: "[condition|clear] — Keep working until a condition is met",
  effort: "Set effort level for model usage",
};

function description(markdown: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (frontmatter) {
    const found = frontmatter[1]?.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim();
    if (found) return found.replace(/^(["'])(.*)\1$/, "$2").slice(0, 120);
  }
  const body = frontmatter ? markdown.slice(frontmatter[0].length) : markdown;
  return (body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "").slice(0, 120);
}

/** `name:` from a SKILL.md's frontmatter, else its directory's name. */
function skillName(markdown: string, directory: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  const named = frontmatter?.[1]?.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return named && /^[\p{L}\p{N}_:-]+$/u.test(named) ? named : directory;
}

/** Skills under a root: one directory each, with a SKILL.md; `prefix` names a plugin's. */
function skills(root: string, source: SlashCommand["source"], options: { prefix?: string; trigger?: "$" } = {}): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const directory = join(root, entry.name);
    let markdown: string;
    try {
      if (!statSync(directory).isDirectory()) continue;
      markdown = readFileSync(join(directory, "SKILL.md"), "utf8");
    } catch { continue; }
    const name = skillName(markdown, entry.name);
    result.push({ name: options.prefix ? `${options.prefix}:${name}` : name, description: description(markdown), source, ...(options.trigger ? { trigger: options.trigger } : {}) });
  }
  return result;
}

/**
 * The skills and commands of the Claude plugins turned on in settings.json, as Claude
 * offers them: `/<plugin>:<name>`.
 */
function pluginCommands(home: string): SlashCommand[] {
  const read = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  const enabled = (read(join(home, ".claude", "settings.json")) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins ?? {};
  const installed = (read(join(home, ".claude", "plugins", "installed_plugins.json")) as { plugins?: Record<string, Array<{ installPath?: unknown }>> } | null)?.plugins ?? {};
  const result: SlashCommand[] = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const installPath = installed[id]?.[0]?.installPath;
    if (typeof installPath !== "string") continue;
    const plugin = id.split("@")[0]!;
    result.push(...skills(join(installPath, "skills"), "plugin", { prefix: plugin }));
    result.push(...customCommands(join(installPath, "commands"), "plugin").map((command) => ({ ...command, name: `${plugin}:${command.name}` })));
  }
  return result;
}

function customCommands(root: string, source: SlashCommand["source"]): SlashCommand[] {  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  // Guard only the current ancestry: sibling links can expose different command namespaces.
  const ancestors = new Set<string>();
  const visit = (directory: string): void => {
    let canonical: string;
    try { canonical = realpathSync(directory); } catch { return; }
    if (ancestors.has(canonical)) return;
    ancestors.add(canonical);
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        try {
          const target = statSync(path);
          if (target.isDirectory()) visit(path);
          else if (target.isFile() && entry.name.endsWith(".md")) {
            const relativeName = relative(root, path).slice(0, -3).split(sep).join(":");
            result.push({ name: relativeName, description: description(readFileSync(path, "utf8")), source });
          }
        } catch { continue; }
      }
    } finally { ancestors.delete(canonical); }
  };
  visit(root);
  return result;
}

/**
 * Templates are commands. A conventional prompt directory holds direct `.md` children only —
 * pi reads no deeper there, so recursing would offer commands pi never loads.
 *
 * A link is asked of what it points at, not of itself: pi stats the entry, so a `.md` reached
 * through a symlink is a template it loads, and a directory is not one however the link is named.
 */
function piTemplates(root: string, source: SlashCommand["source"]): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let markdown: string;
    try {
      // the target is what gets read, so the target is what gets asked: a broken link throws here
      // and is skipped, as pi skips it, and a link to a folder fails isFile however it is named.
      // One path for links and plain files alike — the stat costs less than the read that follows
      // and keeps the two from being judged by different rules
      const target = join(root, entry.name);
      if (!statSync(target).isFile()) continue;
      markdown = readFileSync(target, "utf8");
    } catch {
      continue;
    }
    result.push({ name: entry.name.slice(0, -3), description: description(markdown), source });
  }
  return result;
}

export function paneCommands(agent: string | null | undefined, cwd: string | null | undefined, home = process.env.HOME ?? ""): SlashCommand[] {
  if (!agent || !(agent in BUILTINS)) return [];
  const commands: SlashCommand[] = (BUILTINS[agent] ?? []).map((name) => ({ name, description: (agent === "pi" ? PI_DESCRIPTIONS[name] : agent === "hermes" ? HERMES_DESCRIPTIONS[name] : undefined) ?? DESCRIPTIONS[name] ?? `Run /${name}`, source: "builtin" }));
  if (agent === "claude") {
    commands.push(...customCommands(join(home, ".claude", "commands"), "user"));
    if (cwd) commands.push(...customCommands(join(cwd, ".claude", "commands"), "project"));
    commands.push(...skills(join(home, ".claude", "skills"), "skill"));
    if (cwd) commands.push(...skills(join(cwd, ".claude", "skills"), "skill"));
    commands.push(...pluginCommands(home));
  }
  if (agent === "pi") {
    // Only what pi loads from the person's own folders, which it loads whether or not the
    // folder's project is trusted: the agent directory and ~/.agents. A project's own skills
    // and prompts are left out on purpose — pi gates them behind a trust decision and a
    // project root of its own choosing, and offering a command the agent will not run is worse
    // than offering one fewer command. Neither are pi's packages and extension commands, which
    // no file scan can know: they are in the terminal's own `/` menu either way.
    // PI_CODING_AGENT_DIR moves the agent directory, as it does for pi's sessions and models
    const agentDir = process.env["PI_CODING_AGENT_DIR"] ? piAgentDir() : join(home, ".pi", "agent");
    commands.push(...piTemplates(join(agentDir, "prompts"), "user"));
    commands.push(...skills(join(agentDir, "skills"), "skill", { prefix: "skill" }));
    commands.push(...skills(join(home, ".agents", "skills"), "skill", { prefix: "skill" }));
  }
  if (agent === "codex") {
    // Codex's saved prompts run as /prompts:<name>; its skills are named with `$`
    commands.push(...customCommands(join(home, ".codex", "prompts"), "user").map((command) => ({ ...command, name: `prompts:${command.name}` })));
    commands.push(...skills(join(home, ".codex", "skills"), "skill", { trigger: "$" }));
    if (cwd) commands.push(...skills(join(cwd, ".codex", "skills"), "skill", { trigger: "$" }));
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}
