import type { Database } from "bun:sqlite";
import type { SkillActivity } from "../shared/protocol.ts";
import { invokedSkill } from "./skill-activity.ts";

/** Read only the metadata of oversized skill results, after the unchanged-page cache check. */
export function hermesSkillResult(db: Database, id: number): string | null {
  return db.query<{ result: string | null }, [number]>(`SELECT CASE WHEN json_valid(content) THEN
    json_object('success', content -> '$.success', 'name', content -> '$.name', 'path', content -> '$.path', 'file', content -> '$.file')
    END AS result FROM messages WHERE id = ?`).get(id)?.result ?? null;
}

/** Hermes's skill_view keeps the same activity when it reads a linked reference. */
export function hermesSkill(name: string, input: Record<string, unknown>, output?: string): SkillActivity | null {
  if (name !== "skill_view") return null;
  let result: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(output ?? "null");
    if (value !== null && typeof value === "object" && !Array.isArray(value)) result = value as Record<string, unknown>;
  } catch { /* an incomplete preview is not proof of success */ }
  const skill = invokedSkill("Skill", { skill: input.name ?? result.name });
  if (!skill) return null;
  if (result.success === true) skill.status = "loaded";
  else if (result.success === false || /^(?:error|failed|exception)\b/i.test(output?.trim() ?? "")) skill.status = "failed";
  const path = result.path ?? result.file;
  if (typeof path === "string" && path.length <= 4096 && !/[\r\n]/.test(path)) skill.path = path;
  return skill;
}

/** Only the runtime's leading envelope is instructions, never a quotation in a user's message. */
export function hermesSkillInvocation(text: string): { skill: SkillActivity; request: string } | null {
  const match = /^\[IMPORTANT: The user has invoked the "([^"\r\n]+)" skill, indicating they want you to follow its instructions\. The full skill content is loaded below\.\]/.exec(text);
  const skill = match ? invokedSkill("Skill", { skill: match[1] }) : null;
  if (!skill) return null;
  const marker = "\n\nThe user has provided the following instruction alongside the skill invocation: ";
  const at = text.lastIndexOf(marker);
  return { skill: { ...skill, evidence: "instructions", status: "loaded" }, request: at < 0 ? "" : text.slice(at + marker.length) };
}
