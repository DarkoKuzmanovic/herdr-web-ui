import { describe, expect, it } from "bun:test";
import { answerKeys, parseInteractivePrompt } from "./prompt.ts";

// screens as Hermes 0.x's Ink TUI draws its clarify question, read off a live herdr pane
const STATUS = " ─ (⌐■_■) deliberating…  · 10s │ opus 5.5 │ 39.9k/500k │ [█░░░░░░░░░] 8%";
const HINT = " 0/1 answered · ↑/↓ select · Enter confirm and continue · Tab/Shift+Tab switch question · Esc/Ctrl+C cancel";
const choice = [
  "   └─ ● Clarify(\"Pick a colour for the test card\") (3.0s)",
  " ask 1 question",
  " ▸ Pick a colour for the test card",
  "   ▸ 1. Red (Recommended)",
  "     2. Blue",
  "     3. Other (type your answer)",
  HINT,
  STATUS,
].join("\n");

describe("hermes clarify", () => {
  it("reads choices and answers by moving the cursor", () => {
    const prompt = parseInteractivePrompt("hermes", choice)!;
    expect(prompt.question).toBe("Pick a colour for the test card");
    expect(prompt.options.map((option) => option.label)).toEqual(["Red", "Blue"]);
    expect(prompt.custom_option_index).toBe(2);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { custom_text: "Green" })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }, { keys: ["ctrl+k"] }, { keys: ["ctrl+u"] }, { text: "Green" }, { keys: ["enter"] }]);
  });

  it("reads an open question in a batch as a typed answer", () => {
    const screen = [
      " ask 2 questions",
      " ✓ Pick a colour",
      "   Red",
      " ▸ Name one fruit that grows on",
      " trees",
      "   > ",
      HINT.replace("0/1", "1/2"),
      STATUS,
    ].join("\n");
    const prompt = parseInteractivePrompt("hermes", screen)!;
    expect(prompt.question).toBe("Name one fruit that grows on trees");
    expect(prompt.body).toBe("1/2 answered");
    // what is already on the `>` line goes first, or the answer would join it
    expect(answerKeys(prompt, { custom_text: "Apple" })).toEqual([{ keys: ["ctrl+k"] }, { keys: ["ctrl+u"] }, { text: "Apple" }, { keys: ["enter"] }]);
  });

  it("drops the card once the question is answered", () => {
    expect(parseInteractivePrompt("hermes", `${choice}\n ❯ Pick a colour → Red\n ┊ Red\n x\n y\n z`)).toBeNull();
  });

  it("ticks a multi-select question's rows with Space and locks them with Enter", () => {
    const multi = choice.replace("▸ 1. Red", "▸ [ ] 1. Red").replace("  2. Blue", "  [x] 2. Blue").replace("0/1 answered · ", "0/1 answered · Space toggle · ");
    const prompt = parseInteractivePrompt("hermes", multi)!;
    expect(prompt.multi_select).toBe(true);
    expect(prompt.custom_option_index).toBeNull();
    expect(prompt.options.map((option) => option.label)).toEqual(["Red", "Blue"]);
    // Blue is ticked already: Red is ticked, Blue left as it is
    expect(answerKeys(prompt, { option_indices: [0, 1] })).toEqual([{ keys: ["space"] }, { keys: ["enter"] }]);
    // only Red: tick it, untick Blue
    expect(answerKeys(prompt, { option_indices: [0] })).toEqual([{ keys: ["space"] }, { keys: ["down"] }, { keys: ["space"] }, { keys: ["enter"] }]);
    // the cursor on Other: back up to a choice, since Enter there opens the text line
    const onOther = multi.replace("▸ [ ] 1. Red", "  [ ] 1. Red").replace("  3. Other", "▸ 3. Other");
    expect(answerKeys(parseInteractivePrompt("hermes", onOther)!, { option_indices: [1] })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });
});

// the double box Hermes draws an approval and its own Yes/No in, read off a live pane
const boxed = (...rows: string[]) => [" ╔" + "═".repeat(60) + "╗", ...rows.map((row) => ` ║ ${row.padEnd(58)} ║`), " ╚" + "═".repeat(60) + "╝", "", STATUS].join("\n");

describe("hermes approval and confirm", () => {
  it("reads a dangerous command's approval and answers it by moving the cursor, never by a digit", () => {
    const prompt = parseInteractivePrompt("hermes", boxed(
      "⚠ approval required · recursive delete",
      " rm -rf /tmp/hx/junk",
      "▸ 1. Allow once",
      "  2. Allow this session",
      "  3. Always allow",
      "  4. Deny",
      "↑/↓ select · Enter confirm · 1-4 quick pick · Esc/Ctrl+C deny",
    ))!;
    expect(prompt.kind).toBe("approval");
    expect(prompt.question).toBe("Run this command? (recursive delete)");
    expect(prompt.body).toBe("rm -rf /tmp/hx/junk");
    expect(prompt.options.map((option) => option.label)).toEqual(["Allow once", "Allow this session", "Always allow", "Deny"]);
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  it("reads its own Yes/No, the cancel row first", () => {
    const prompt = parseInteractivePrompt("hermes", boxed(
      "⚠ Clear the current session?",
      " This ends the current conversation and clears the transcript.",
      "",
      "▸ No, keep going",
      "  Yes, clear the session",
      "↑/↓ select · Enter confirm · Y/N quick · Esc cancel",
    ))!;
    expect([prompt.question, prompt.body]).toEqual(["Clear the current session?", "This ends the current conversation and clears the transcript."]);
    expect(prompt.options.map((option) => option.label)).toEqual(["No, keep going", "Yes, clear the session"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  it("takes a two-row box for a Yes/No only under the Y/N hint", () => {
    expect(parseInteractivePrompt("hermes", boxed("? Something else", "▸ One", "  Two", "↑/↓ select · Enter confirm · 1-2 quick pick · Esc/Ctrl+C deny"))).toBeNull();
  });

  it("drops a box that has been answered and scrolled on", () => {
    const answered = boxed("⚠ Clear the current session?", "▸ No, keep going", "  Yes, clear the session", "↑/↓ select · Enter confirm · Y/N quick · Esc cancel");
    expect(parseInteractivePrompt("hermes", `${answered}\n${"later output\n".repeat(8)} ❯`)).toBeNull();
  });
});
